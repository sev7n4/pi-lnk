/**
 * A1 propose 单飞门（2026-11-02 老黄牛死循环护栏，RCA v2 `.workbuddy/audit/2026-11-02-propose-loop-incident-rca-v2.md` §4-A1）。
 *
 * 不变量：**同一画布节点在同一时刻至多一个未结算提议；同一 user turn 内同一节点至多一次
 * propose 结算**。生产事故链（cmvwads7g003up801s82h0zqh）：canvas-id-binding 静默改写后模型
 * 无感知 →「纠正性」再次 propose → Nest markProposeGeneration 无状态守卫把 generating 盖回
 * pending_confirm → 5min 超时 ×5 循环（_signal 文案诱导），run 烧 71 分钟直到用户手动停止。
 *
 * 三臂拦截（全部 fail-closed，行业纪律对齐 Claude SDK PreToolUse deny——reason 直接成为
 * tool result，必须给「不做什么+该做什么」的行动指令；LangGraph HITL——超时=终局，绝不重试）：
 * ① latch：本 user turn 该节点已结算过一次 propose（GenerationGateStore.shouldBlockRePropose）；
 * ② 在途：registry 中该节点已有未结算 pending（PendingToolRegistry.hasPendingForNode）；
 * ③ SSOT：画布节点 status ∈ {generating, fallback_pending}（get-node 现查，跨 run 防线）。
 *
 * 注册序约束（index.ts 遵守）：必须在 registerCanvasIdBindingHooks **之后**注册——before_tool
 * 链式 replace，本门要看到改写后的正确 node_id。与 generation-gate（run_* 门禁）并存不合并：
 * propose 是「提议入口」的准入，run 是「执行」的准入，两套 SSOT 语义（spec B-5 先例）。
 */
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";
import type { Metrics } from "../metrics.js";
import type { GenerationGateStore } from "./generation-gate.js";
import type { PendingToolRegistry } from "../pending-registry.js";
import { proposeGateEnabled } from "../runtime-config.js";

/** 拦截原因分类（观测用）。 */
export type ProposeGateBlockKind = "latch" | "pending" | "in_flight" | "ssot_unavailable";

/** 有活跃生成语义的节点状态（与 Nest markProposeGeneration 的 B1 守卫同词表）。 */
const IN_FLIGHT_STATUSES = new Set(["generating", "fallback_pending"]);

export interface ProposeGateCheckResult {
	allowed: boolean;
	kind?: ProposeGateBlockKind;
	reason?: string;
}

/** Nest 客户端窄接口（与 generation-gate 同形，纯函数可测）。 */
export interface ProposeGateClient {
	post(path: string, body: unknown): Promise<unknown>;
}

function extractNodeStatus(node: unknown): string | undefined {
	const d = (node as { data?: { status?: unknown } } | null | undefined)?.data;
	return d && typeof d === "object" && typeof d.status === "string" ? d.status : undefined;
}

/** 404 = 节点确定性不存在（新建节点尚未可见等）→ 放行，让 Nest proposeGeneration 给出权威错误。 */
function isNotFound(err: unknown): boolean {
	if (err && typeof err === "object" && (err as { status?: unknown }).status === 404) return true;
	return err instanceof Error && /\bhttp 404\b/.test(err.message);
}

/**
 * 纯函数裁决（便于单测）：propose_generation 的三臂单飞校验。
 * 非 propose 工具 / 缺 node_id → 放行（schema 层拦）。SSOT 查询失败非 404 → fail-closed。
 */
export async function checkProposeGate(
	store: Pick<GenerationGateStore, "shouldBlockRePropose">,
	registry: Pick<PendingToolRegistry, "hasPendingForNode">,
	client: ProposeGateClient,
	sessionId: string,
	toolName: string,
	args: Record<string, unknown>,
	ssot: { canvasSessionId?: string } = {},
): Promise<ProposeGateCheckResult> {
	if (toolName !== "propose_generation") return { allowed: true };
	const nodeId = typeof args.node_id === "string" ? args.node_id : "";
	if (!nodeId) return { allowed: true }; // 工具 schema 校验负责
	// ① latch：本 turn 已结算过一次（confirmed/timeout/rejected 等一切有副作用结算）
	if (store.shouldBlockRePropose(sessionId, nodeId)) {
		return {
			allowed: false,
			kind: "latch",
			reason: `节点 ${nodeId} 本轮已提议过并已结算。不要再次 propose_generation：等待用户在提议卡上操作、在画布上操作或回复新消息；需要修改参数时，等用户下一条消息后再提议。`,
		};
	}
	// ② 在途：同节点已有未结算的阻塞提议（防御 ① 覆盖不到的 settle 前窗口与跨 run 竞态）
	const canvasKey = ssot.canvasSessionId ?? sessionId;
	if (registry.hasPendingForNode(canvasKey, nodeId)) {
		return {
			allowed: false,
			kind: "pending",
			reason: `节点 ${nodeId} 已有等待用户确认的提议，禁止重复提议；等待用户操作即可。`,
		};
	}
	// ③ SSOT：节点已有生成在跑（含另一 run 启动的）→ 提议会把 generating 盖回 pending_confirm
	try {
		const node = await client.post("/agent/internal/get-node", { sessionId: canvasKey, nodeId });
		const status = extractNodeStatus(node);
		if (status && IN_FLIGHT_STATUSES.has(status)) {
			return {
				allowed: false,
				kind: "in_flight",
				reason: `节点 ${nodeId} 已有生成在跑（status=${status}），禁止重复提议；等待生成完成或用户指示。`,
			};
		}
		return { allowed: true };
	} catch (err) {
		if (isNotFound(err)) return { allowed: true };
		return {
			allowed: false,
			kind: "ssot_unavailable",
			reason: "提议前置校验暂时不可用（fail-closed），请稍后重试或向用户说明",
		};
	}
}

/** 唯一接线源（plan-gate-wiring 同纪律）：index.ts 与集成测试共调，杜绝「测试复制接线」漂移。 */
export function registerProposeGateHooks(
	harness: AgentHarness<LnkpiToolContext>,
	opts: {
		/** pi 会话键（latch 键域，与 index.ts after_tool 的 gateStore.markProposed 同域）。 */
		sessionKey: string;
		store: Pick<GenerationGateStore, "shouldBlockRePropose">;
		registry: Pick<PendingToolRegistry, "hasPendingForNode">;
		client: ProposeGateClient;
		/** 键域解析器：canvasSessionId 每轮可能自愈（doCreate），钩子内必须现算。 */
		canvasKey: string | (() => string);
		metrics: Pick<Metrics, "observeProposeGateBlocked">;
	},
): void {
	// kill switch off ⇒ 不注册，逐字节旧行为（回滚出口仿 plan-gate 终审 Critical #1）。
	if (!proposeGateEnabled()) return;
	const { store, registry, client, metrics, sessionKey } = opts;
	const resolveKey = () => (typeof opts.canvasKey === "function" ? opts.canvasKey() : opts.canvasKey);
	harness.hooks.on("before_tool", async (event) => {
		const check = await checkProposeGate(store, registry, client, sessionKey, event.toolName, event.args, {
			canvasSessionId: resolveKey(),
		});
		if (!check.allowed) {
			metrics.observeProposeGateBlocked(check.kind ?? "pending");
			console.warn(
				`[pi-runtime] propose-gate blocked: kind=${check.kind} tool=${event.toolName} reason=${check.reason}`,
			);
			return { block: { reason: check.reason ?? "propose gated" } };
		}
		return undefined;
	});
}
