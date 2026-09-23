/**
 * pi-runtime 服务入口（spec §6.2.0 B2 骨架 → B8 实流）
 *
 * 会话生命周期由 SessionManager 承载（真实 AgentHarness，事件经 SSE 流出）。
 * 部署形态：D-α' K3s Day-1（容器化见 Dockerfile，B7）。
 */
import Fastify from "fastify";
import { SessionManager, ConflictError, NotFoundError, type NormalizedEvent } from "./session-manager.js";
import { Metrics, VERSION, routeLabel } from "./metrics.js";
import { resolveTools } from "./tools/config.js";

const PORT = Number(process.env.PORT ?? 8100);
const HOST = process.env.HOST ?? "0.0.0.0";
const HEARTBEAT_MS = 15_000;

const metrics = new Metrics();
const manager = new SessionManager(resolveTools(metrics));

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
		version: "0.0.1",
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

app.post<{ Body: { sessionId?: string; systemPrompt?: string; userId?: string } }>(
	"/sessions",
	async (request, reply) => {
		const sessionId = request.body?.sessionId ?? crypto.randomUUID();
		try {
			const { provider, model } = await manager.create(sessionId, {
				systemPrompt: request.body?.systemPrompt,
				userId: request.body?.userId,
			});
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

app.post<{ Params: { sessionId: string }; Body: { text: string; lane?: string } }>(
	"/sessions/:sessionId/prompt",
	async (request, reply) => {
		const { sessionId } = request.params;
		try {
			return await manager.prompt(sessionId, request.body.text, request.body.lane ?? "main");
		} catch (err) {
			if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
			const msg = (err as Error).message ?? "";
			const reason = /429|rate/i.test(msg) ? "upstream_rate_limited" : "upstream_error";
			metrics.observePromptError(reason);
			throw err;
		}
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
