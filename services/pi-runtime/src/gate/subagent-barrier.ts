/**
 * P1 pending-work barrier（spec 2026-11-15-subagent-pending-work-barrier-design.md §5）。
 * 单一 before_run_end handler：合成 plan-gate 续跑 + 后台子任务结果回注，
 * 避开上游 hooks.js last-write-wins（多个 handler 的 followUp 后者覆盖前者）。
 */
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";
import type { SubagentCoordinator, SettledSubagentResult } from "./subagent.js";
import { SUBAGENT_TIMEOUT_MS } from "./subagent.js";
import { isSubagentSessionKey } from "../session-manager.js";
import { planGateFollowUp } from "./plan-gate-wiring.js";

export const BARRIER_DEADLINE_MS = SUBAGENT_TIMEOUT_MS + 30_000; // 决策 D4

export function composeBarrierFollowUp(results: SettledSubagentResult[]): string | undefined {
	if (results.length === 0) return undefined;
	const lines = results.map((r) => {
		const flag = r.partial ? "（结果不完整）" : "";
		return `- ${r.callId} [${r.status}] ${r.report || "（无报告）"}${flag}`;
	});
	const hasPartial = results.some((r) => r.partial);
	const tail = hasPartial ? "\n注意：部分后台任务结果不完整或在本进程未收口、不可恢复，请据此谨慎合成结论。" : "";
	return `【后台子任务已完成，以下为结果，请据此合成最终答复】\n${lines.join("\n")}${tail}`;
}

/** 局部接口：barrier 只依赖这一个 observeBarrier 方法，不前置依赖 Task 3 才加到 Metrics 上的实现。 */
export interface BarrierMetrics {
	observeBarrier(outcome: "waited" | "deadline" | "cancelled" | "none"): void;
}

export function registerRunEndHooks(
	harness: AgentHarness<LnkpiToolContext>,
	opts: {
		sessionId: string;
		coordinator: SubagentCoordinator;
		resolvePlanKey: () => string;
		metrics: BarrierMetrics;
		/** 测试注入用短 deadline；生产缺省 BARRIER_DEADLINE_MS。 */
		deadlineMs?: number;
	},
): void {
	// 子会话不挂 barrier（与 plan-gate 的 !isSubagentSessionKey 守卫一致，防回灌）。
	if (isSubagentSessionKey(opts.sessionId)) return;
	harness.hooks.on("before_run_end", async () => {
		const pending = opts.coordinator.pendingFor(opts.sessionId);
		let barrierText: string | undefined;
		if (pending.length > 0) {
			const results = await opts.coordinator.awaitSettled(pending, { deadlineMs: opts.deadlineMs ?? BARRIER_DEADLINE_MS });
			opts.metrics.observeBarrier(results.some((r) => r.status === "interrupted") ? "deadline" : "waited");
			barrierText = composeBarrierFollowUp(results);
		} else {
			opts.metrics.observeBarrier("none");
		}
		const planText = planGateFollowUp(opts.resolvePlanKey()); // 一次性消费信号：只调用一次
		const parts = [barrierText, planText].filter((x): x is string => !!x);
		return parts.length === 0 ? undefined : { followUp: parts.join("\n\n") };
	});
}
