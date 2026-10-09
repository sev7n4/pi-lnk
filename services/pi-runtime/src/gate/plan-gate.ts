/**
 * C3 Plan 确认门状态模块（spec docs/superpowers/specs/2026-10-10-plan-gate-design.md §3.1/§3.3）。
 * 会话级状态：pending（方案待确认/仅保留 → 拦写）+ executedThisRun（followUp 调度信号）。
 * 键域 = canvasSessionId ?? pi 会话键（propose_plan 的 tc.sessionId、index.ts 钩子的
 * manager.getCanvasSessionId(key) ?? key、session-manager 播种的 todoKey 三方同一公式）。
 * 模块级单例（tools/todo.ts store 同款先例）+ LRU 上限防泄漏。
 * 语义铁律（spec §3.1）：execute 是唯一解锁路径；refine/keep/timeout/aborted 全部 fail-closed
 * 保持拦写；pending 不因新用户轮自动清空（确认前绝不执行）。
 */
export type PlanDecision = "execute" | "refine" | "keep" | "timeout" | "aborted";

interface PlanSessionState {
	pending: boolean;
	executedThisRun: boolean;
}

const store = new Map<string, PlanSessionState>();
const STORE_CAP = 1000;

function stateFor(key: string): PlanSessionState {
	let s = store.get(key);
	if (!s) {
		s = { pending: false, executedThisRun: false };
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

/** 拦截判定：planPending 且 tier ∈ gated 且未豁免。tier 未知（注册表外工具）放行——
 * 收紧未知面属二线防线，plan-gate 只管「已注册的写类工具」。 */
export const PLAN_GATED_TIERS: ReadonlySet<string> = new Set(["gen", "destructive", "graph_batch", "write_light"]);
export const PLAN_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["todo_write"]);

export function shouldBlockForPlan(toolName: string, tier: string | undefined, key: string): boolean {
	if (!isPlanPending(key)) return false;
	if (PLAN_EXEMPT_TOOLS.has(toolName)) return false;
	return PLAN_GATED_TIERS.has(tier ?? "");
}

/** transcript 反向扫描最后一条 propose_plan 的 decision（task-state.ts pickLatestSnapshot 同构
 * 防御式解析：2026-10-09 生产 probe 实测形态为 message 包裹层，保留官方同构顶层形态兼容）。 */
export function pickLatestPlanDecision(entries: readonly unknown[]): PlanDecision | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as {
			toolName?: string;
			details?: unknown;
			result?: { details?: unknown };
			message?: { toolName?: string; details?: unknown; result?: { details?: unknown } };
		} | null;
		if (!e) continue;
		let raw: unknown;
		if (e.toolName === "propose_plan") {
			raw = e.details ?? e.result?.details;
		} else if (e.message?.toolName === "propose_plan") {
			raw = e.message.details ?? e.message.result?.details;
		} else {
			continue;
		}
		const d = (raw as { plan?: { decision?: unknown } } | undefined)?.plan?.decision;
		if (d === "execute" || d === "refine" || d === "keep" || d === "timeout" || d === "aborted") return d;
	}
	return undefined;
}
