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
import { loadRuntimeConfig } from "./runtime-config.js";
import { SkillRegistry, approxTokens } from "./skills/registry.js";
import { resolveToolsWithClient } from "./tools/config.js";
import { GenerationGateStore, checkGenerationGate } from "./gate/generation-gate.js";
import { PendingToolRegistry } from "./pending-registry.js";
import { applyTrustBoundary, countTrustBoundaryActions } from "./trust-boundary.js";
import { governImagePayload } from "./payload-images.js";
import {
	DEFAULT_TOOL_RESULT_MAX_CHARS,
	capToolResult,
	measureToolResult,
} from "./tool-result-budget.js";

const PORT = Number(process.env.PORT ?? 8100);
const HOST = process.env.HOST ?? "0.0.0.0";

/**
 * 「大到不可能真实」的上下文窗口阈值（2026 年主流模型 ≤ 1M，且 1M 那档多为声明值而非可用值）。
 * 超过它就要求运维显式声明真实窗口，否则告警。
 */
const SUSPICIOUS_CONTEXT_WINDOW = 400_000;

const metrics = new Metrics();
// 阻塞式确认类工具（ask_user）的等待注册表（2026-09-30-ask-user-blocking）：
// 同一实例三处共享——工具域（ask_user waitForUser）、/answers + /pending 端点、abort 联动。
//
// 等待生命周期广播（2026-10-01）：等待**开始**就发 `waiting_user{status:"waiting"}`，
// 结束发 `{status:"resolved"}`。原因：阻塞工具的 tool_result 在等待结束后才到，前端
// 拿它反推「等待中」在本语义下恒不成立 → 整段等待期显示「生成回复中 · Ns」= 用户看到的卡死。
// 派发按画布会话 id 定位会话（registry 键同域）；命中 0 个会话静默（会话可能在别的实例）。
const registry = new PendingToolRegistry({
	onWaitStart: ({ sessionId, callId, toolName, timeoutMs, meta }) => {
		const nodeId = typeof meta?.nodeId === "string" ? meta.nodeId : undefined;
		manager.dispatchWaitingUser(sessionId, { status: "waiting", toolName, callId, timeoutMs, nodeId });
	},
	onSettled: ({ sessionId, callId, toolName, status }) => {
		manager.dispatchWaitingUser(sessionId, { status: "resolved", toolName, callId, reason: status });
		// 阻塞等待结算指标（2026-10-02 补：此前 ask_user / propose_generation 一块零指标，
		// 排障答不出「卡片超时率多少」）。挂在这里而不是工具层：一处覆盖所有 pending 工具，
		// 也免去给每个工具改签名 ; toolName/status 本来就是 hook 的既有入参。
		metrics.observePendingOp(toolName, status);
	},
});
const { tools, client: nestClient } = resolveToolsWithClient(metrics, { registry });

// D-η'：进程内扫描一次 skills 目录（缺省 ./skills；PI_RUNTIME_SKILLS_DIR 覆盖）。
// 目录缺失/为空时 indexBlock=""、tools=[]，会话行为与未配置 skills 逐字节一致。
const skillRegistry = new SkillRegistry(process.env.PI_RUNTIME_SKILLS_DIR ?? "./skills", metrics);
metrics.setSkillsLoaded(skillRegistry.entries.length);
metrics.setSkillsPromptTokens(approxTokens(skillRegistry.indexBlock)); // follow-up-1：index 常驻 token 观测

// B-5 HITL Gate（roadmap D3）：确认权收归 harness。
// ① before_tool：run_* 双重校验（同轮自批拦截 + 画布 SSOT pending_confirm），fail-closed；
// ② after_tool：propose_generation 成功 → 记录本轮提议（① 的数据源）；
// ③ onPrompt：用户轮计数（区分「同轮自批」与「跨轮确认后执行」）。
// ④ transform_context（审计 #8）：进 LLM 前的信任边界——本轮工具结果来源标注 + 目标复述。
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
			// hook 层共用的运行时开关：一次解析，避免每个 hook / 每次工具调用重复读 env。
			const hookCfg = loadRuntimeConfig(process.env);
			harness.hooks.on("after_tool", async (event) => {
				if (event.toolName === "propose_generation" && !event.isError) {
					const nodeId = (event.args as { node_id?: unknown } | undefined)?.node_id;
					if (typeof nodeId === "string" && nodeId) {
						// B-2：阻塞确认后 details.confirmed=true → gate 视同跨轮放行（spec §4.3）
						const confirmed =
							(event.details as { confirmed?: unknown } | null | undefined)?.confirmed === true;
						gateStore.markProposed(sessionId, nodeId, { confirmed });
					}
				}
				// 统一上限（审计「缺统一上限」）：体积观测全量接线 + 越界兜底截断。
				// 观测放在开关之前——即使治理关掉，也要能回答「一条结果占了多少上下文」。
				const size = measureToolResult(event.content);
				if (size.bytes > 0) metrics.observeToolResult(event.toolName, size.bytes);
				if (hookCfg.toolResultBudget === false) return undefined;
				const capped = capToolResult(event.content, hookCfg.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS);
				if (!capped.trimmed) return undefined;
				metrics.observeToolResultTrim(event.toolName);
				return { content: capped.content };
			});
			// 审计 #8：trust boundary（目标复述 + 工具结果来源标注）。
			// 纯文本模式也注册（无 toolResult 时复述仍有价值）；off = 逐字节旧行为。
			// fail-soft：纯函数不 throw；压缩摘要走 generateSummary 独立请求路径，不经本 hook。
			if (hookCfg.trustBoundary !== false) {
				harness.hooks.on("transform_context", async (event) => {
					const out = applyTrustBoundary(event.messages);
					if (!out) return undefined;
					const stats = countTrustBoundaryActions(event.messages);
					metrics.observeTransformContext(stats.goalReinjected, stats.annotatedToolResults);
					return { messages: out };
				});
			}
			// T2 图片治理（spec §3.2）：历史图片渐进降级 + 本轮优先裁剪 + 超限剔除。
			// 常开（低风险只减不增）；vendor 的 before_payload 分发本身对 handler 异常 fail-soft，
			// 这里再包一层 try/catch 双保险：治理炸了就 payload 原样放行。
			harness.hooks.on("before_payload", async (event) => {
				try {
					const result = governImagePayload(event.payload, hookCfg.directImageHistoryRounds ?? 2, 4);
					if (result.trims.length === 0) return undefined; // 零变更零拷贝
					for (const t of result.trims) metrics.observeBeforePayloadTrim(t.reason);
					return { payload: { ...(event.payload as Record<string, unknown>), messages: result.messages } };
				} catch (err) {
					console.warn("[pi-runtime] before_payload image governance failed (fail-soft):", err);
					return undefined;
				}
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
	// F-01：压缩「跳过理由」计数。不注入则 skips 指标恒为空，验收判据第 1 条
	// （skips_total 有累加 = 判定链路在跑）无法成立——这条比触发本身更容易被漏掉。
	metrics,
	// 审计 #6/#7：压缩完成 → 摘要落 Nest ContextSnapshot（W18 表激活）。
	// fail-soft：上报失败只留痕，不影响会话；纯文本模式（无 Nest client）跳过。
	{
		onSnapshot: (payload) => {
			if (!nestClient) return;
			nestClient
				.post("/agent/internal/save-context-snapshot", payload)
				.catch((err) => {
					console.warn("[compaction-summary] snapshot persist failed (fail-soft):", err);
				});
		},
	},
);

manager.setPendingRegistry(registry);

const app = buildApp(manager, { metrics, version: VERSION, logger: true, registry });

// 启动期自检（spec §11）：模型未声明 contextWindow 时阈值型 compaction 永不触发
// （只剩 overflow 兜底）——必须留痕，否则表现为「长会话突然 400」。
// 只探测 env 装配路径（BYOK 渠道的 contextWindow 由 Nest 覆盖时随会话带入）。
try {
	const { model, providerId } = assembleModel(undefined);
	const declared = model.contextWindow;
	if (!declared) {
		app.log.warn(
			{ model: model.id, provider: providerId },
			"model has no contextWindow declared; threshold-based auto-compaction may never trigger",
		);
	} else if (declared > SUSPICIOUS_CONTEXT_WINDOW) {
		// Review Focus #1 的「假修好」防线：provider 可能把窗口声明得远大于真实值
		// （agnes 侧实测 source of truth = 1_000_000），此时阈值高到永不触及，
		// 而 skips_total{below_threshold} 照常累加 —— 从指标看一切正常，实际一次都没压缩。
		const override = loadRuntimeConfig(process.env).compactionContextWindow;
		if (override === undefined) {
			app.log.warn(
				{ model: model.id, provider: providerId, declared, threshold: declared - 16_384 },
				"declared contextWindow is implausibly large and PI_RUNTIME_COMPACTION_CONTEXT_WINDOW is unset; compaction may never trigger (set the override to the model's real window)",
			);
		}
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
