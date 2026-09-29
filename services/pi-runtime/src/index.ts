/**
 * pi-runtime 服务入口（bootstrap，spec §6.2.0 B2 骨架 → B8 实流 → §9 路由抽取）
 *
 * 职责只剩「装配依赖 → buildApp → listen → 启 sweeper」。
 * 路由本身在 app.ts（可被 `app.inject` 测试）；会话生命周期在 SessionManager。
 */
import { buildApp } from "./app.js";
import { SessionManager } from "./session-manager.js";
import { assembleModel } from "./model-assembly.js";
import { Metrics, VERSION } from "./metrics.js";
import { SkillRegistry, approxTokens } from "./skills/registry.js";
import { resolveToolsWithClient } from "./tools/config.js";
import { GenerationGateStore, checkGenerationGate } from "./gate/generation-gate.js";

const PORT = Number(process.env.PORT ?? 8100);
const HOST = process.env.HOST ?? "0.0.0.0";

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
// P0-① 会话常驻后：onSessionCreated 只在新建/重建时触发，onPrompt 每轮触发——
// 「同轮」判定因此从「每轮重建恒为 0」变成真实递增的轮号，语义反而更准。
const gateStore = new GenerationGateStore();
const manager = new SessionManager(
	tools,
	undefined,
	undefined,
	undefined,
	{
		onSessionCreated(sessionId, harness) {
			gateStore.resetSession(sessionId);
			harness.hooks.on("after_tool", async (event) => {
				if (event.toolName !== "propose_generation" || event.isError) return undefined;
				const nodeId = (event.args as { node_id?: unknown } | undefined)?.node_id;
				if (typeof nodeId === "string" && nodeId) gateStore.markProposed(sessionId, nodeId);
				return undefined;
			});
			if (!nestClient) return undefined; // 纯文本模式无工具，Gate 无用武之地
			const gateClient = nestClient;
			harness.hooks.on("before_tool", async (event) => {
				const check = await checkGenerationGate(gateStore, gateClient, sessionId, event.toolName, event.args, {
					// #74 解耦语义：SSOT 查询必须带画布会话 id —— 本闭包只有 pi 会话键，
					// 拿键查 Nest get-node 404 → 全部 run_* 被 fail-closed 假阳性拦截（2026-09-29 冒烟实证）。
					canvasSessionId: manager.getCanvasSessionId(sessionId),
				});
				if (!check.allowed) {
					metrics.observeToolCall(event.toolName, "error", "gate_blocked"); // ③：HITL 拦截归因观测
					return { block: { reason: check.reason ?? "generation gated" } };
				}
				if (check.retry) metrics.observeToolCall(event.toolName, "ok", "retry"); // V-γ 重试放行打点
				return undefined;
			});
			return undefined;
		},
		onPrompt(sessionId) {
			gateStore.bumpUserTurn(sessionId);
		},
	},
	skillRegistry,
	undefined,
	// P0-① 观测：compaction 成败计数（spec §5.7）
	(result) => metrics.observeCompaction(result),
);

const app = buildApp(manager, { metrics, version: VERSION, logger: true });

// 启动期自检（spec §11）：模型未声明 contextWindow 时阈值型 compaction 永不触发
// （只剩 overflow 兜底）——必须留痕，否则表现为「长会话突然 400」。
// 只探测 env 装配路径（BYOK 渠道的 contextWindow 由 Nest 覆盖时随会话带入）。
try {
	const { model, providerId } = assembleModel(undefined);
	if (!model.contextWindow) {
		app.log.warn(
			{ model: model.id, provider: providerId },
			"model has no contextWindow declared; threshold-based auto-compaction may never trigger",
		);
	}
} catch (err) {
	// 凭据缺失等装配期错误：不影响启动（真正用到时会在 create 里报 503），只留痕。
	app.log.warn(
		{ err: err instanceof Error ? err.message : String(err) },
		"model assembly probe failed at startup; skipping contextWindow self-check",
	);
}

// 内存句柄 TTL 回收 + 磁盘 LRU（spec §5.4）：随进程启动，进程退出自动失效。
manager.startSweeper();

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
