/**
 * C3 Plan 确认门状态模块（spec docs/superpowers/specs/2026-10-10-plan-gate-design.md §3.1/§3.3）。
 * 会话级状态：pending（方案待确认/仅保留 → 拦写）+ executedThisRun（followUp 调度信号）。
 * 键域 = canvasSessionId ?? pi 会话键（propose_plan 的 tc.sessionId、index.ts 钩子的
 * manager.getCanvasSessionId(key) ?? key、session-manager 播种的 todoKey 三方同一公式）。
 * 模块级单例（tools/todo.ts store 同款先例）+ LRU 上限防泄漏。
 * 语义铁律（spec §3.1）：execute 是唯一解锁路径；refine/keep/timeout/aborted 全部 fail-closed
 * 保持拦写；pending 不因新用户轮自动清空（确认前绝不执行）。
 */
// B-2 一等账本条目读取（plan 2026-11-16-b2-task-contract-custom-entry-plan.md §3-D3）。
// task-state 只依赖 tools/acceptance，无循环。
import { readTaskEntry } from "../tools/task-state.js";

export type PlanDecision = "execute" | "refine" | "keep" | "timeout" | "aborted";

const PLAN_DECISION_SET: ReadonlySet<string> = new Set([
	"execute",
	"refine",
	"keep",
	"timeout",
	"aborted",
]);

interface PlanSessionState {
	pending: boolean;
	executedThisRun: boolean;
	/** B-1 门禁态声明集收缩（plan 2026-11-16-b1-gate-toolset-narrow-plan.md）：会话 lane
	 *  当前是否处于「gated 写工具已从 declared set 移除」状态 + 被移除名单（还原合并加回用）。
	 *  还原一律 getActiveTools 现算差分 + 本名单合并，不持跨会话快照（fork 陷阱，plan D3）。 */
	toolsetNarrowed: boolean;
	narrowedRemoved: string[];
}

const store = new Map<string, PlanSessionState>();
const STORE_CAP = 1000;

function stateFor(key: string): PlanSessionState {
	let s = store.get(key);
	if (!s) {
		s = { pending: false, executedThisRun: false, toolsetNarrowed: false, narrowedRemoved: [] };
		store.set(key, s);
		if (store.size > STORE_CAP) {
			const first = store.keys().next().value;
			if (first !== undefined && first !== key) store.delete(first);
		}
	}
	return s;
}

export function isPlanPending(key: string): boolean {
	return stateFor(key).pending;
}

export function markPlanDecision(key: string, decision: PlanDecision): void {
	const s = stateFor(key);
	if (decision === "execute") {
		s.pending = false;
		s.executedThisRun = true;
	} else {
		s.pending = true;
	}
}

export function seedPlanState(key: string, decision: PlanDecision): void {
	const s = stateFor(key);
	s.pending = decision !== "execute";
	s.executedThisRun = false; // 播种的是跨 run 终态，run 内信号无从恢复
}

export function consumePlanExecutionSignal(key: string): boolean {
	const s = stateFor(key);
	if (!s.executedThisRun) return false;
	s.executedThisRun = false;
	return true;
}

export function clearPlanRunFlag(key: string): void {
	stateFor(key).executedThisRun = false;
}

export function resetPlanState(key: string): void {
	store.delete(key);
}

/** B-1 声明集收缩记账（plan §2-D1）：收缩/还原完成后由 wiring 回写；
 *  before_run/after_tool 幂等判定读这里。removed 传 undefined = 保持原名单（只翻状态位）。 */
export function setToolsetNarrow(key: string, narrowed: boolean, removed?: string[]): void {
	const s = stateFor(key);
	s.toolsetNarrowed = narrowed;
	if (removed !== undefined) s.narrowedRemoved = removed;
}

export function getToolsetNarrow(
	key: string,
): { narrowed: boolean; removed: string[] } {
	const s = stateFor(key);
	return { narrowed: s.toolsetNarrowed, removed: s.narrowedRemoved };
}

/** 拦截判定：planPending 且 tier ∈ gated 且未豁免。tier 未知（注册表外工具）放行——
 * 收紧未知面属二线防线，plan-gate 只管「已注册的写类工具」。 */
export const PLAN_GATED_TIERS: ReadonlySet<string> = new Set(["gen", "destructive", "graph_batch", "write_light"]);
// P4 豁免（#841 F5，2026-11-14 落地）：调研是 plan 的输入而非写操作——子代理白名单
// 物理只读（gate/subagent.ts SUBAGENT_TOOL_WHITELIST），plan 期豁免无副作用面。
export const PLAN_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["todo_write", "spawn_subagent"]);

export function shouldBlockForPlan(toolName: string, tier: string | undefined, key: string): boolean {
	if (!isPlanPending(key)) return false;
	if (PLAN_EXEMPT_TOOLS.has(toolName)) return false;
	return PLAN_GATED_TIERS.has(tier ?? "");
}

/** transcript 反向扫描最后一条 propose_plan 的 decision。
 * B-2 起两源并存、**最新条目胜出**（plan 2026-11-16-b2-task-contract-custom-entry-plan.md §3-D3）：
 * ① 首选源：custom entry（customType "lnkpi.task"，kind="plan"，v===1）；
 * ② fallback：toolResult details 副作用（防御式解析：2026-10-09 生产 probe 实测形态为
 *    message 包裹层，保留官方同构顶层形态兼容，观察期后退役）。两源不一致触发 onMismatch。 */
export function pickLatestPlanDecision(
	entries: readonly unknown[],
	opts?: { onMismatch?: () => void },
): PlanDecision | undefined {
	let customHit: PlanDecision | undefined;
	let fallbackHit: PlanDecision | undefined;
	let customHitIndex = -1;
	let fallbackHitIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e) continue;
		// ① 一等源（custom entry）
		const task = readTaskEntry(e);
		if (task && task.kind === "plan" && PLAN_DECISION_SET.has(task.decision as string)) {
			if (!customHit) {
				customHit = task.decision as PlanDecision;
				customHitIndex = i;
			}
			continue;
		}
		if (customHit && fallbackHit) break;
		// ② fallback：toolResult details 副作用（原样保留）
		const o = e as {
			toolName?: string;
			details?: unknown;
			result?: { details?: unknown };
			message?: { toolName?: string; details?: unknown; result?: { details?: unknown } };
		} | null;
		if (!o) continue;
		let raw: unknown;
		if (o.toolName === "propose_plan") {
			raw = o.details ?? o.result?.details;
		} else if (o.message?.toolName === "propose_plan") {
			raw = o.message.details ?? o.message.result?.details;
		} else {
			continue;
		}
		const d = (raw as { plan?: { decision?: unknown } } | undefined)?.plan?.decision;
		if (d === "execute" || d === "refine" || d === "keep" || d === "timeout" || d === "aborted") {
			if (!fallbackHit) {
				fallbackHit = d;
				fallbackHitIndex = i;
			}
		}
	}
	if (customHit && fallbackHit && customHit !== fallbackHit) {
		opts?.onMismatch?.();
	}
	const customLater = customHitIndex >= fallbackHitIndex;
	return customHit && fallbackHit
		? (customLater ? customHit : fallbackHit)
		: (customHit ?? fallbackHit);
}
