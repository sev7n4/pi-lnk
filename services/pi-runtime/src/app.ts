/**
 * 路由装配（自 index.ts 抽出，spec §9）。
 *
 * 唯一目的：让路由可被 `app.inject` 测试——原 index.ts 在 import 时即 `listen()`，
 * 测试无法引用实例，S1/S4 类契约（幂等 status、busy 409、turnContext 透传）无处可测。
 * index.ts 因此退化为 bootstrap（装配依赖 + listen + startSweeper）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import { Metrics, routeLabel } from "./metrics.js";
import { parseLlmOverride } from "./llm-override.js";
import {
	BusyError,
	ConflictError,
	ForkTargetUnknownError,
	isReplayComplete,
	type NormalizedEvent,
	NotFoundError,
	SessionManager,
	toSessionKey,
	type TurnContext,
	InvalidInputError,
	QueueRejectedError,
} from "./session-manager.js"
import type { DirectImage } from "./direct-images.js";
import type { PendingToolRegistry } from "./pending-registry.js";

const HEARTBEAT_MS = 15_000;

export type EventsSubscribeMode =
	| { mode: "live" }
	| { mode: "replay"; afterSeq: number };

/**
 * `GET /sessions/:id/events` 的订阅起点裁决（纯函数，P0-A 2026-09-29）。
 *
 * 优先级：
 *  1. `lastEventId`（合法非负整数）→ 增量续传（P0-③，断线重连）
 *  2. `from=now`                   → **live**：只收未来事件，不重放缓冲
 *  3. 其余（含畸形 lastEventId）    → `afterSeq=-1` 全量重放（旧客户端兼容）
 *
 * 为什么需要 live：持久会话的事件缓冲**跨轮累积**（dispatch 只 push 不清）。每轮新订阅若
 * 全量重放，Nest 会先收到上一轮全部事件（含其 `agent_end`）→ 命中即 emit `done` 关流
 * → 本轮回答被上一轮回答顶替（生产六步 CRUD 实证，S2–S6 每轮 ~100ms 内重复 S1）。
 */
export function resolveEventsSubscribeMode(
	query: { lastEventId?: string; from?: string } | undefined,
): EventsSubscribeMode {
	const parsed = Number(query?.lastEventId);
	if (Number.isInteger(parsed) && parsed >= 0) return { mode: "replay", afterSeq: parsed };
	if (query?.from === "now") return { mode: "live" };
	return { mode: "replay", afterSeq: -1 };
}

export interface AppDeps {
	metrics: Metrics;
	version: string;
	/** 生产传 true；测试缺省 false（避免 inject 用例被日志淹没）。 */
	logger?: boolean;
	/**
	 * 阻塞式确认类工具的等待注册表（2026-09-30-ask-user-blocking）。
	 * 缺省时 /answers 返回 503、/pending 返回 {pending:null}——纯降级，不影响既有端点。
	 */
	registry?: PendingToolRegistry;
}

export function buildApp(manager: SessionManager, deps: AppDeps): FastifyInstance {
	const { metrics, version } = deps;
	const app = Fastify({
		logger: deps.logger ?? false,
		bodyLimit: 4 * 1024 * 1024,
	});

	// K2/K3 度量：请求计数 + 耗时直方图（SSE 长连接计入 /events 的总时长）
	app.addHook("onRequest", async (request) => {
		(request as unknown as Record<string, unknown>)["__t0"] = process.hrtime.bigint();
	});
	app.addHook("onResponse", async (request, reply) => {
		const t0 = (request as unknown as Record<string, unknown>)["__t0"] as bigint | undefined;
		if (t0 === undefined) return;
		const durationSec = Number(process.hrtime.bigint() - t0) / 1e9;
		metrics.observeHttp(routeLabel(request.url), request.method, reply.statusCode, durationSec);
	});

	app.get("/healthz", async () => {
		return {
			status: "ok",
			service: "pi-runtime",
			version,
			pi: "0.85.1 (vendored, see vendor/earendil-works/pi/VENDORED.md)",
			sessions: manager.count(),
		};
	});

	// spec §5.4.1 readiness 探针端点（Day-1 与 healthz 同语义；Day-2 可加依赖检查）
	app.get("/readyz", async () => ({ status: "ready" }));

	// spec K2/K3 Prometheus 度量入口
	app.get("/metrics", async (_request, reply) => {
		reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
		return metrics.render(manager.count(), version);
	});

	app.get("/skills", async () => ({ skills: manager.listSkills() }));

	/**
	 * 幂等 upsert（spec §5.4）：
	 *   新建 → 201 `status=created`；复用 → 200 `status=resumed`；身份变更 → 200 `status=rebuilt`；
	 *   userId 不一致 → 409（fail-closed，不回显会话内容）。
	 * `attachments` / `mentionedKeys` / `refOrder` / `focusNodeId` 仅作旧 Nest 兼容：
	 * 新 Nest 每轮走 prompt 的 turnContext，create 只把它们写成首轮初值。
	 */
	app.post<{
		Body: {
			sessionId?: string;
			systemPrompt?: string;
			userId?: string;
			/**
			 * 画布会话 id（Nest 查库用），与 `sessionId`（pi 会话键）**解耦**。
			 * 工具经 `toolContext.sessionId` 取用；缺省时回落 pi 会话键。
			 */
			canvasSessionId?: string;
			attachments?: Array<{ url?: string; text?: string; mediaType?: string }>;
			mentionedKeys?: string[];
			refOrder?: string[];
			focusNodeId?: string;
			thinkingLevel?: string;
			/** K-1：BYOK 会话级模型覆盖（畸形 → 400，不静默兜底） */
			llm?: unknown;
		};
	}>("/sessions", async (request, reply) => {
		const threadKey = request.body?.sessionId ?? crypto.randomUUID();
		// 空/空白 sessionId 是客户端错误：直接 400（放进去会被 toSessionKey 抛成 503，语义失真）
		if (!threadKey.trim()) {
			return reply.code(400).send({ error: "sessionId must be a non-empty string" });
		}
		// 畸形 llm 直接 400：宁可本轮失败，也不「以为用 BYOK 实际走平台 key」（错账）。
		// 错误信息只描述结论，不回显请求体（apiKey 明文红线）。
		const llm = parseLlmOverride(request.body?.llm);
		if (llm.state === "invalid") {
			return reply.code(400).send({ error: "invalid llm override: 必填字段缺失或类型错误" });
		}
		try {
			const result = await manager.create(threadKey, {
				systemPrompt: request.body?.systemPrompt,
				userId: request.body?.userId,
				canvasSessionId: request.body?.canvasSessionId,
				attachments: request.body?.attachments,
				mentionedKeys: request.body?.mentionedKeys,
				refOrder: request.body?.refOrder,
				focusNodeId: request.body?.focusNodeId,
				thinkingLevel: request.body?.thinkingLevel,
				llm: llm.state === "ok" ? llm.value : undefined,
			});
			// K-1 观测：只打 providerId（哈希）+ model id —— 不打 apiKey / baseUrl（密钥红线）。
			// 出现 byok-* 即证明本会话走了 BYOK 覆盖，agnes 表示 env 装配。
			if (llm.state === "ok") {
				app.log.info({ threadKey, provider: result.provider, model: result.model }, "session created with BYOK override");
			}
			// P0-① 观测：created→new，rebuilt→rebuilt，resumed→memory|disk（区分内存快路径与磁盘 repo.open）。
			metrics.observeSessionResume(
				result.status === "created" ? "new" : result.status === "rebuilt" ? "rebuilt" : (result.resumedFrom ?? "memory"),
			);
			// 部署顺序保护（spec §11）：新 Nest 依赖 status/resumedFrom；旧 Nest 只读 provider/model。
			return reply.code(result.status === "created" ? 201 : 200).send({ sessionId: threadKey, ...result });
		} catch (err) {
			if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
			// 模型凭据缺失等装配期错误：503（下游不可用）
			return reply.code(503).send({ error: (err as Error).message });
		}
	});

	app.post<{
		Params: { sessionId: string };
		Body: { text: string; lane?: string; forceSkills?: string[]; turnContext?: TurnContext; images?: DirectImage[] };
	}>("/sessions/:sessionId/prompt", async (request, reply) => {
		const { sessionId } = request.params;
		try {
			// turnContext 随 prompt 一起提交：在 busy 校验之后应用（复核 Important #5）——
			// 被 409 拒绝的请求不得改写在跑 run 下一轮 LLM 调用将读到的动态上下文。
			await manager.prompt(sessionId, request.body.text, request.body.lane, {
				forceSkills: request.body?.forceSkills,
				turnContext: request.body?.turnContext,
				images: request.body?.images,
			});
			return reply.code(202).send({ accepted: true });
		} catch (err) {
			if (err instanceof BusyError) {
				// 区分「在跑 run」与「在压缩」：后者是短期的、可重试的，
				// 混在一个 busy 里会让容量类排查把两者混淆（body 保持 "session busy" 不变，避免破坏契约）。
				metrics.observePromptRejection(err.reason === "compacting" ? "busy_compacting" : "busy");
				return reply.code(409).send({ error: "session busy" });
			}
			if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
			const msg = (err as Error).message ?? "";
			const reason = /429|rate/i.test(msg) ? "upstream_rate_limited" : "upstream_error";
			metrics.observePromptError(reason);
			return reply.code(503).send({ error: msg });
		}
	});

	/**
	 * 用户插话（steering 队列）——「run 进行中发言」的正道（2026-10-02 接入）。
	 *
	 * 此前这条路径是坏的：Nest 的 prompt 撞 409 后 `void ... .catch(() => {})` 静默吞掉，
	 * 前端只有浏览器内一个「最多 1 条」的单槽队列，刷新即丢。现在服务端有了真正的队列：
	 * 消息经 `pi.pending.entry` 落盘，下一个 turn 边界（`runtime/drive/boundary.ts:85-89`）选中并
	 * 让同一次 run 接着生成，事件流不断、UI 不断。
	 *
	 * 返回 202 而非 409/200-new-run：语义是「已入队，稍后会并入本轮」，不是新开一轮。
	 */
	app.post<{
		Params: { sessionId: string };
		Body: { text: string; lane?: string; turnContext?: TurnContext };
	}>("/sessions/:sessionId/steer", async (request, reply) => {
		const { sessionId } = request.params;
		const text = typeof request.body?.text === "string" ? request.body.text : "";
		if (!text.trim()) return reply.code(400).send({ error: "text is required (non-empty)" });
		try {
			const result = await manager.steer(sessionId, text, request.body?.lane, {
				turnContext: request.body?.turnContext,
			});
			metrics.observeQueueOp("enqueue", "steer", "ok");
			return reply.code(202).send(result);
		} catch (err) {
			if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
			if (err instanceof InvalidInputError) return reply.code(400).send({ error: err.message });
			// 拒收要计数：队列功能「看起来接住了」但实际没落盘是最难查的一类静默失败。
			metrics.observeQueueOp("enqueue", "steer", "rejected");
			return reply.code(503).send({ error: (err as Error).message });
		}
	});

	/**
	 * 尾随指令（followUp 队列）。语义 =「run 收尾时再接一句」：只在收尾边界
	 * （`finishRunBoundary`，boundary.ts:187）且本轮无 trigger 时被选中，把**同一次 run**
	 * 续跑一代。想立刻插话请用 `/steer`（followUp 在工具阻塞期连边界都没有，必睡）。
	 */
	app.post<{
		Params: { sessionId: string };
		Body: { text: string; lane?: string; turnContext?: TurnContext };
	}>("/sessions/:sessionId/followup", async (request, reply) => {
		const { sessionId } = request.params;
		const text = typeof request.body?.text === "string" ? request.body.text : "";
		if (!text.trim()) return reply.code(400).send({ error: "text is required (non-empty)" });
		try {
			const result = await manager.followUp(sessionId, text, request.body?.lane, {
				turnContext: request.body?.turnContext,
			});
			metrics.observeQueueOp("enqueue", "followUp", "ok");
			return reply.code(202).send(result);
		} catch (err) {
			if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
			if (err instanceof InvalidInputError) return reply.code(400).send({ error: err.message });
			metrics.observeQueueOp("enqueue", "followUp", "rejected");
			return reply.code(503).send({ error: (err as Error).message });
		}
	});

	/**
	 * 中断该会话当前正在跑的 run（前端「停止」按钮）。
	 * 会话本身保留——用户可接着发新消息；无活跃 run 时 skipped=true，
	 * 前端据此提示「已断开回复，后台可能仍在收尾」。
	 */
	app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/abort", async (request, reply) => {
		const { sessionId } = request.params;
		const aborted = manager.abort(sessionId);
		app.log.info({ sessionId, aborted }, "abort requested");
		return reply.send({ ok: aborted, skipped: !aborted });
	});

	/**
	 * 用户作答回传（ask_user 阻塞链路，2026-09-30 spec §6.2）。
	 *
	 * 幂等铁律（Review Focus 1）：registry.answer 对未知 callId / 已 settle 一律
	 * `{ok:true, deduped:true}` —— 业务路径**永不 404/500**。会话已被 sweeper 回收、
	 * callId 从未注册、Nest 超时重试重放，都落到 deduped 分支，回答端点重试安全。
	 */
	app.post<{
		Params: { sessionId: string };
		Body: { callId?: string; answers?: Record<string, string[]> };
	}>("/sessions/:sessionId/answers", async (request, reply) => {
		const { registry } = deps;
		if (!registry) return reply.code(503).send({ error: "pending registry not configured" });
		const callId = request.body?.callId;
		const answers = request.body?.answers;
		if (!callId || typeof answers !== "object" || answers === null) {
			return reply.code(400).send({ error: "callId and answers are required" });
		}
		// registry 键 = 画布会话 id（工具域），路由参数 = threadKey → 先 sanitize 成 pi 会话键，
		// 再经 getCanvasSessionId 换算（#74/#76 解耦语义的镜像：会话不存在回落键本身，
		// registry 查不到 → 幂等 deduped，无副作用）。
		const canvasId = manager.getCanvasSessionId(toSessionKey(request.params.sessionId));
		return reply.send(registry.answer(canvasId, callId, answers));
	});

	/**
	 * 当前阻塞等待状态查询（Nest 轮询用）。会话不存在 / 无 pending 一律 200
	 * `{pending:null}` —— 不给探测面（枚举会话无意义），也不 404。
	 */
	app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId/pending", async (request, reply) => {
		const { registry } = deps;
		if (!registry) return reply.send({ pending: null });
		const canvasId = manager.getCanvasSessionId(toSessionKey(request.params.sessionId));
		return reply.send({ pending: registry.pendingInfo(canvasId) });
	});

	/**
	 * ③ 重跑：后端线程截断（与 WorkBuddy「编辑并重发」一致）。
	 *
	 * 以 `atEntryId` 为切点 fork 出一条新分支会话：目标消息及其之后全部丢弃，新 run 从
	 * 切点父节点续写。来源会话不动。返回的 `newKey` 是**原始** threadKey，调用方（Nest）
	 * 后续以它作为 threadId —— pi-runtime 内部 `toSessionKey` 会推导回同一内存键。
	 */
	app.post<{
		Params: { sessionId: string };
		Body: { atEntryId?: string };
	}>("/sessions/:sessionId/fork", async (request, reply) => {
		const { sessionId } = request.params;
		const atEntryId = request.body?.atEntryId?.trim();
		if (!atEntryId) {
			return reply.code(400).send({ error: "atEntryId is required (fork cut point entry id)" });
		}
		try {
			const result = await manager.fork(sessionId, atEntryId);
			app.log.info(
				{ sessionId, atEntryId, newKey: result.newKey, newSessionId: result.newSessionId },
				"session forked",
			);
			// newKey 是后续所有调用（prompt/events/create）都要用的 **原始** threadKey
			return reply.code(201).send({
				sessionId: result.newKey,
				newKey: result.newKey,
				newSessionId: result.newSessionId,
			});
		} catch (err) {
			if (err instanceof ForkTargetUnknownError) return reply.code(400).send({ error: err.message });
			if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
			if (err instanceof BusyError) return reply.code(409).send({ error: "session busy" });
			return reply.code(503).send({ error: (err as Error).message });
		}
	});

	// #78：from=now 让客户端只订阅「当下之后」的事件（不重放 buffer）
	app.get<{ Params: { sessionId: string }; Querystring: { lastEventId?: string; from?: string } }>(
		"/sessions/:sessionId/events",
		async (request, reply) => {
			const { sessionId } = request.params;
			if (!manager.hasKey(sessionId)) {
				return reply.code(404).send({ error: "session not found" });
			}
			// 订阅起点优先级（P0-A，2026-09-29）见 resolveEventsSubscribeMode
			const mode = resolveEventsSubscribeMode(request.query);

			// id: 帧 = NormalizedEvent.seq，供客户端断点续传（P0-③）
			const writeEvent = (event: NormalizedEvent) => {
				reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			};

			// 复核 Minor #10：先订阅再写响应头——hasKey 与 subscribe 之间的 sweeper 回收窗口
			// 会以 NotFoundError 浮出，此时还能 404；写头之后再抛就只能 500。
			//
			// T1：`subscribe` 现在额外报告 `droppedFromSeq`（buffer 溢出时被淘汰的最早 seq）。
			// `afterSeq` 早于它 ⇒ 客户端要的重放段已被 `shift()` 丢掉，拿到的是**断头的**流。
			//
			// ⚠️ **本PR 刻意不回 409**，行为与改前**逐字节一致**（200 + 原有补发逻辑）。
			// 理由（2026-10-04 影响面取证）：
			//  1. 客户端 `pi-runtime.client.ts:424-428` 只对 404 特判，
			//     其余非 2xx 一律 `throw` →进指数退避重连；而重连**仍带同一个 lastEventId**
			//     ⇒ 服务端必然再次 409 ⇒ 循环到 120 秒预算耗尽才报 exhausted。
			//     即：**在客户端适配之前，回 409 会把「静默残缺」换成「长时间无响应」**，
			//     后者更糟（连部分内容都没有）。
			//  2. `agent.service.ts` 的两处生产调用**都传 `{ live: true }`** ⇒ 首连走
			//     `from=now`，`lastEventId` 只在**同一订阅内断线重连**时才有值。
			//     而断线重连发生在事件仍在推送的窗口内 ⇒ 真实触发条件苛刻。
			//  3. 线上 `PI_RUNTIME_MODE=off` + `replicas=1` + 零流量 ⇒ 当前根本触发不了。
			//
			// 本 PR 的价值是**把缺陷变成可判读**（`droppedFromSeq` 落到返回值上），
			// 客户端据此判读后，改 409 只需动服务端一行、客户端零改。
			// 判读函数 `isReplayComplete` 已在下面用于**日志观测**。
			let buffered: (NormalizedEvent[] & { droppedFromSeq: number }) | undefined;
			try {
				if (mode.mode === "live") {
					manager.subscribeLive(sessionId, writeEvent);
				} else {
					buffered = manager.subscribe(sessionId, writeEvent, mode.afterSeq);
				}
			} catch (err) {
				if (err instanceof NotFoundError) return reply.code(404).send({ error: "session not found" });
				throw err;
			}

			// 残缺只**记日志**不改状态：让运维能从日志看到「发生过丢弃 + 丢了多少」，
			// 而不改变任何客户端可见行为。
			if (buffered && mode.mode === "replay" && !isReplayComplete(buffered, mode.afterSeq)) {
				app.log.warn(
					{
						sessionId,
						afterSeq: mode.afterSeq,
						droppedFromSeq: buffered.droppedFromSeq,
						lostCount: buffered.droppedFromSeq - mode.afterSeq,
					},
					"replay window expired: requested events were evicted; client received a truncated stream",
				);
			}

			reply.raw.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"connection": "keep-alive",
			});

			// 重连/后订阅重放：先补发缓冲（仅 seq > afterSeq），监听已在 subscribe 时挂上。
			// ⚠️ 残缺时**照样发**（本 PR 不改客户端可见行为）：`droppedFromSeq` 已在上面记了日志，
			// 客户端将来适配 `isReplayComplete` 后再改回 409，届时这里不动。
			for (const event of buffered ?? []) writeEvent(event);

			const heartbeat = setInterval(() => {
				reply.raw.write(`: heartbeat\n\n`);
			}, HEARTBEAT_MS);

			request.raw.on("close", () => {
				clearInterval(heartbeat);
				manager.unsubscribe(sessionId, writeEvent);
				app.log.info({ sessionId }, "sse client disconnected");
			});

			return reply;
		},
	);

	app.delete<{ Params: { sessionId: string } }>("/sessions/:sessionId", async (request, reply) => {
		const removed = await manager.remove(request.params.sessionId);
		return removed ? reply.code(204).send() : reply.code(404).send();
	});

	return app;
}
