/**
 * pi-runtime 服务入口（spec §6.2.0 B2 骨架 → B8 实流）
 *
 * 会话生命周期由 SessionManager 承载（真实 AgentHarness，事件经 SSE 流出）。
 * 部署形态：D-α' K3s Day-1（容器化见 Dockerfile，B7）。
 */
import Fastify from "fastify";
import { SessionManager, ConflictError, NotFoundError, type NormalizedEvent } from "./session-manager.js";
import { Metrics, VERSION, routeLabel } from "./metrics.js";
import { SkillRegistry, approxTokens } from "./skills/registry.js";
import { resolveToolsWithClient } from "./tools/config.js";
import { GenerationGateStore, checkGenerationGate } from "./gate/generation-gate.js";
import { parseLlmOverride } from "./llm-override.js";

const PORT = Number(process.env.PORT ?? 8100);
const HOST = process.env.HOST ?? "0.0.0.0";
const HEARTBEAT_MS = 15_000;

const metrics = new Metrics();
const { tools, client: nestClient } = resolveToolsWithClient(metrics);

// D-η'：进程内扫描一次 skills 目录（缺省 ./skills；PI_RUNTIME_SKILLS_DIR 覆盖）。
// 目录缺失/为空时 indexBlock=""、tools=[]，会话行为与未配置 skills 逐字节一致。
const skillRegistry = new SkillRegistry(process.env.PI_RUNTIME_SKILLS_DIR ?? "./skills", metrics);
metrics.setSkillsLoaded(skillRegistry.entries.length);
metrics.setSkillsPromptTokens(approxTokens(skillRegistry.indexBlock)); // follow-up-1：index 常驻 token 观测

// B-5 HITL Gate（roadmap D3）：确认权收归 harness。
// ① before_tool：run_* 双重校验（同轮自批拦截 + 画布 SSOT pending_confirm），fail-closed；
// ② after_tool：propose_generation 成功 → 记录本轮提议（① 的数据源）；
// ③ onPrompt：用户轮计数（区分「同轮自批」与「跨轮确认后执行」）。
const gateStore = new GenerationGateStore();
const manager = new SessionManager(tools, undefined, undefined, undefined, {
	onSessionCreated(sessionId, harness) {
		gateStore.resetSession(sessionId); // B4 每轮重建语义：新会话即新轮
		harness.hooks.on("after_tool", async (event) => {
			if (event.toolName !== "propose_generation" || event.isError) return undefined;
			const nodeId = (event.args as { node_id?: unknown } | undefined)?.node_id;
			if (typeof nodeId === "string" && nodeId) gateStore.markProposed(sessionId, nodeId);
			return undefined;
		});
		if (!nestClient) return undefined; // 纯文本模式无工具，Gate 无用武之地
		const gateClient = nestClient;
		harness.hooks.on("before_tool", async (event) => {
			const check = await checkGenerationGate(gateStore, gateClient, sessionId, event.toolName, event.args);
			return check.allowed ? undefined : { block: { reason: check.reason ?? "generation gated" } };
		});
		return undefined;
	},
	onPrompt(sessionId) {
		gateStore.bumpUserTurn(sessionId);
	},
}, skillRegistry);

const app = Fastify({
	logger: true,
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
		version: VERSION,
		pi: "0.85.1 (vendored, see vendor/earendil-works/pi/VENDORED.md)",
		sessions: manager.count(),
	};
});

// spec §5.4.1 readiness 探针端点（Day-1 与 healthz 同语义；Day-2 可加依赖检查）
app.get("/readyz", async () => ({ status: "ready" }));

// spec K2/K3 Prometheus 度量入口
app.get("/metrics", async (_request, reply) => {
	reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
	return metrics.render(manager.count(), VERSION);
});

app.get("/skills", async () => ({ skills: manager.listSkills() }));

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
}>(
	"/sessions",
	async (request, reply) => {
		const sessionId = request.body?.sessionId ?? crypto.randomUUID();
		// 畸形 llm 直接 400：宁可本轮失败，也不"以为用 BYOK 实际走平台 key"（错账）。
		// 错误信息只描述结论，不回显请求体（apiKey 明文红线）。
		const llm = parseLlmOverride(request.body?.llm);
		if (llm.state === "invalid") {
			return reply.code(400).send({ error: "invalid llm override: 必填字段缺失或类型错误" });
		}
		try {
			const { provider, model } = await manager.create(sessionId, {
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
				app.log.info({ sessionId, provider, model }, "session created with BYOK override");
			}
			return reply.code(201).send({ sessionId, provider, model });
		} catch (err) {
			if (err instanceof ConflictError) {
				return reply.code(409).send({ error: err.message });
			}
			// 模型凭据缺失等装配期错误：503（下游不可用）
			return reply.code(503).send({ error: (err as Error).message });
		}
	},
);

app.post<{ Params: { sessionId: string }; Body: { text: string; lane?: string; forceSkills?: string[] } }>(
	"/sessions/:sessionId/prompt",
	async (request, reply) => {
		const { sessionId } = request.params;
		try {
			return await manager.prompt(sessionId, request.body.text, request.body.lane ?? "main", {
				forceSkills: request.body.forceSkills,
			});
		} catch (err) {
			if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
			const msg = (err as Error).message ?? "";
			const reason = /429|rate/i.test(msg) ? "upstream_rate_limited" : "upstream_error";
			metrics.observePromptError(reason);
			throw err;
		}
	},
);

/**
 * 中断该会话当前正在跑的 run（前端「停止」按钮）。
 * 会话本身保留——用户可接着发新消息；无活跃 run 时 skipped=true，
 * 前端据此提示「已断开回复，后台可能仍在收尾」。
 */
app.post<{ Params: { sessionId: string } }>(
	"/sessions/:sessionId/abort",
	async (request, reply) => {
		const { sessionId } = request.params;
		const aborted = manager.abort(sessionId);
		app.log.info({ sessionId, aborted }, "abort requested");
		return reply.send({ ok: aborted, skipped: !aborted });
	},
);

app.get<{ Params: { sessionId: string } }>(
	"/sessions/:sessionId/events",
	async (request, reply) => {
		const { sessionId } = request.params;
		if (!manager.has(sessionId)) {
			return reply.code(404).send({ error: "session not found" });
		}

		reply.raw.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const writeEvent = (event: NormalizedEvent) => {
			reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		};

		// 重连/后订阅重放：先补发缓冲，再挂实时监听
		const buffered = manager.subscribe(sessionId, writeEvent);
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

app.delete<{ Params: { sessionId: string } }>(
	"/sessions/:sessionId",
	async (request, reply) => {
		const removed = await manager.remove(request.params.sessionId);
		return removed ? reply.code(204).send() : reply.code(404).send();
	},
);

const start = async () => {
	try {
		await app.listen({ port: PORT, host: HOST });
		app.log.info(`pi-runtime listening on ${HOST}:${PORT}`);
	} catch (err) {
		app.log.error(err);
		process.exit(1);
	}
};

void start();
