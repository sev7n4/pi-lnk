/**
 * C2 turnBudget 状态机（spec docs/superpowers/specs/2026-10-10-turn-budget-design.md §3.1-3.3）。
 * per-run 纯内存状态：挂在 SessionEntry 上，进程重启即失（§5-5：无播种需求）。
 *
 * 计数铁律（§3.1，本设计最重要的一条正确性判据）：只计 runId 与当前 run 一致的
 * turn_start。vendor turn_start.runId = drive.operationId（generation.ts:163），
 * auto-compaction/navigation 是独立 operation ⇒ runId 不同 ⇒ 自动排除。
 * 重试不计数由 vendor 保证：turn_start 仅 nextAttempt === 1 时发射（generation.ts:158）。
 */
export interface TurnBudgetState {
	/** 当前 run 的 runId（run_start 写入、run_end 清空）；undefined = 无活跃窗口。 */
	runId?: string;
	/** 当前 run 已计入的 turn 数。 */
	count: number;
	/** 软着陆提醒是否已发（每 run 至多一次，§3.2）。 */
	warned: boolean;
	/** 硬停是否已执行（每 run 至多一次，§3.3；结算期漂移闸）。 */
	settled: boolean;
}

export function createTurnBudgetState(): TurnBudgetState {
	return { count: 0, warned: false, settled: false };
}

export function turnBudgetRunStart(s: TurnBudgetState, runId: string): void {
	s.runId = runId;
	s.count = 0;
	s.warned = false;
	s.settled = false;
}

export function turnBudgetRunEnd(s: TurnBudgetState): void {
	s.runId = undefined;
}

export type TurnBudgetAction = "ignore" | "warn" | "exceed" | "count";

/**
 * turn_start 计数判定。返回值驱动 session-manager 接线的副作用：
 *   ignore → 异 runId（compaction 等）或无活跃窗口，不计入；
 *   warn   → 首次达到 budget-10，调用方发软着陆 steer（至多一次）；
 *   exceed → 超过 budget 且未结算过，调用方执行硬停；
 *   count  → 普通计数（含 settled 闸后的漂移轮——无害）。
 * exceed 判定优先于 warn：budget<10 时 warn 已在首轮触发过，防双触发。
 */
export function turnBudgetOnTurnStart(
	s: TurnBudgetState,
	runId: string | undefined,
	budget: number,
): TurnBudgetAction {
	if (budget <= 0) return "ignore";
	if (s.runId === undefined || runId === undefined || runId !== s.runId) return "ignore";
	s.count += 1;
	if (s.count > budget && !s.settled) {
		s.settled = true;
		return "exceed";
	}
	if (!s.warned && s.count >= budget - 10) {
		s.warned = true;
		return "warn";
	}
	return "count";
}
