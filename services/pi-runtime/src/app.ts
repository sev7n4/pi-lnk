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
	type NormalizedEvent,
	NotFoundError,
	SessionManager,
	type TurnContext,
} from "./session-manager.js";

const HEARTBEAT_MS = 15_000;

export interface AppDeps {
	metrics: Metrics;
	version: string;
	/** 生产传 true；测试缺省 false（避免 inject 用例被日志淹没）。 */
	logger?: boolean;
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
		Body: { text: string; lane?: string; forceSkills?: string[]; turnContext?: TurnContext };
	}>("/sessions/:sessionId/prompt", async (request, reply) => {
		const { sessionId } = request.params;
		try {
			// 每轮易变上下文（spec §5.3 T 层）：先刷新再 prompt，本轮 LLM 调用即读到新值。
			if (request.body?.turnContext) manager.setTurnContext(sessionId, request.body.turnContext);
			await manager.prompt(sessionId, request.body.text, request.body.lane, {
				forceSkills: request.body?.forceSkills,
			});
			return reply.code(202).send({ accepted: true });
		} catch (err) {
			if (err instanceof BusyError) return reply.code(409).send({ error: "session busy" });
			if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
			const msg = (err as Error).message ?? "";
			const reason = /429|rate/i.test(msg) ? "upstream_rate_limited" : "upstream_error";
			metrics.observePromptError(reason);
			return reply.code(503).send({ error: msg });
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

	app.get<{ Params: { sessionId: string }; Querystring: { lastEventId?: string } }>(
		"/sessions/:sessionId/events",
		async (request, reply) => {
			const { sessionId } = request.params;
			if (!manager.hasKey(sessionId)) {
				return reply.code(404).send({ error: "session not found" });
			}
			// 增量重连 offset（P0-③）：非法值（畸形/负数）一律按「全量重放」处理，不 400
			const parsed = Number(request.query?.lastEventId);
			const afterSeq = Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;

			reply.raw.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"connection": "keep-alive",
			});

			// id: 帧 = NormalizedEvent.seq，供客户端断点续传（P0-③）
			const writeEvent = (event: NormalizedEvent) => {
				reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			};

			// 重连/后订阅重放：先补发缓冲（仅 seq > afterSeq），再挂实时监听
			const buffered = manager.subscribe(sessionId, writeEvent, afterSeq);
			for (const event of buffered) writeEvent(event);

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
