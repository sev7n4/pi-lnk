/**
 * pi-runtime 服务入口（spec §6.2.0 B2 骨架）
 *
 * P0'' 内交付：healthz + 会话端点骨架。AgentHarness 的完整会话生命周期
 * （create / prompt / events SSE / interrupt / followUp）在 B8（Nest RPC 客户端）
 * 与 P1 atomic 迁移中逐步填实 —— 端点形状现在定好，避免 B8 时返工。
 *
 * 部署形态：D-α' K3s Day-1（容器化见 Dockerfile，B7）。
 */
import Fastify from "fastify";
import { assembleModel, type AssembledModel } from "./model-assembly.js";

const PORT = Number(process.env.PORT ?? 8100);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({
	logger: true,
	bodyLimit: 4 * 1024 * 1024,
});

/** 会话注册表：sessionId → 组装好的模型上下文。P0 内换成完整 AgentHarness 会话。 */
const sessions = new Map<string, AssembledModel>();

app.get("/healthz", async () => {
	return {
		status: "ok",
		service: "pi-runtime",
		version: "0.0.1",
		pi: "0.85.1 (vendored, see vendor/earendil-works/pi/VENDORED.md)",
		sessions: sessions.size,
	};
});

app.post<{ Body: { sessionId?: string; modelId?: string } }>(
	"/sessions",
	async (request, reply) => {
		const sessionId = request.body?.sessionId ?? crypto.randomUUID();
		if (sessions.has(sessionId)) {
			return reply.code(409).send({ error: "session exists", sessionId });
		}
		try {
			const assembled = assembleModel();
			sessions.set(sessionId, assembled);
			return reply.code(201).send({
				sessionId,
				provider: assembled.providerId,
				model: assembled.model.id,
				// TODO(B8): 返回完整 AgentHarness session 句柄（prompt / events / interrupt / followUp）
			});
		} catch (err) {
			return reply.code(503).send({ error: (err as Error).message });
		}
	},
);

app.get<{ Params: { sessionId: string } }>(
	"/sessions/:sessionId/events",
	async (request, reply) => {
		const { sessionId } = request.params;
		if (!sessions.has(sessionId)) {
			return reply.code(404).send({ error: "session not found" });
		}
		// TODO(B8): AgentEvent 11 种事件 → SSE 流（对接 Nest 的 17 种 SSE 映射，spec L0）
		reply.raw.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		reply.raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);
		return reply;
	},
);

app.delete<{ Params: { sessionId: string } }>(
	"/sessions/:sessionId",
	async (request, reply) => {
		const deleted = sessions.delete(request.params.sessionId);
		return deleted ? reply.code(204).send() : reply.code(404).send();
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
