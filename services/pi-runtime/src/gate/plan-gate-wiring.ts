/**
 * C3 Plan 确认门接线（spec docs/superpowers/specs/2026-10-10-plan-gate-design.md §3.3/§3.4）。
 *
 * 从 index.ts 抽成独立模块的原因：index.ts 是模块级单例 + env 依赖装配，测试无法 import
 * 驱动；本函数是唯一接线源，index.ts 与真实 harness 集成测试共调，杜绝「测试复制接线」漂移。
 *
 * 两只钩子（hooks 契约见 agent-harness.d.ts）：
 * - before_tool：planPending 且 tier ∈ gated 且未豁免 → block（fail-closed，唯一解锁 = 确认卡）。
 *   与 generation-gate 并存不合并（节点级 SSOT vs transcript 快照两套语义）。
 * - before_run_end：execute 确认后的 run 收尾，todo 有未完成步骤 → followUp 注入执行轮
 *   （vendor boundary 把 followUp 转成合成 user 消息续跑）；信号消费一次即清 + 全部完成不注入
 *   = 双保险防双执行。
 */
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";
import type { Metrics } from "../metrics.js";
import { getTodoState } from "../tools/todo.js";
import { consumePlanExecutionSignal, shouldBlockForPlan } from "./plan-gate.js";

export function registerPlanGateHooks(
	harness: AgentHarness<LnkpiToolContext>,
	opts: {
		planKey: string;
		tiers: ReadonlyMap<string, string | undefined>;
		metrics: Pick<Metrics, "observePlanGateBlocked">;
	},
): void {
	const { planKey, tiers, metrics } = opts;
	harness.hooks.on("before_tool", async (event) => {
		if (!shouldBlockForPlan(event.toolName, tiers.get(event.toolName), planKey)) return undefined;
		metrics.observePlanGateBlocked(event.toolName);
		return {
			block: {
				reason:
					"方案待用户确认：请先用 propose_plan 征得用户确认（或与用户澄清下一步），确认前不写画布、不调生成。",
			},
		};
	});
	harness.hooks.on("before_run_end", async () => {
		// 双保险不双执行（spec §3.4）：信号消费一次即清；todo 全部完成则不注入。
		if (!consumePlanExecutionSignal(planKey)) return undefined;
		const next = getTodoState(planKey).find((i) => i.status !== "completed");
		if (!next) return undefined;
		return {
			followUp: `用户已确认方案，继续执行任务清单的下一步：「${next.content}」。完成或受挫后用 todo_write 更新状态；全部完成后提交空数组清空清单。`,
		};
	});
}
