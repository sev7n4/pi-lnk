/**
 * B-1 门禁态工具声明集收缩（plan docs/superpowers/specs/2026-11-16-b1-gate-toolset-narrow-plan.md §2）。
 *
 * 动机：plan-pending / fail-closed 期间写工具仍 declared，模型看得见、调了被 before_tool 拦
 * → 浪费一轮 + 拒绝回执噪声。本模块把「拦截面」前移到「声明面」：pending 期模型根本
 * 看不到 gated 写工具 schema。before_tool 拦截保留不动（二线防线，语义不变）。
 *
 * 上游原语（阶段 B① 吃满）：vendor lane.getActiveTools/setActiveTools 双向接口——
 * declared set 的运行态读写全部现算差分，host 不持跨会话快照（fork 还原陷阱天然规避：
 * 子会话 store 键独立 + 差分基于当前 lane 实况，见 plan D3）。
 *
 * 单写者纪律（基座 §4-D2）：host 侧 declared set 写点只有 plan-gate-wiring（消费本模块）；
 * tiering 只在装配时给初值、tool_search 激活走 vendor addedToolNames 原生通道，均不经此。
 */
import { PLAN_GATED_TIERS, PLAN_EXEMPT_TOOLS } from "./plan-gate.js";

/** 收缩差分：给定当前 declared 集，返回应移除的 gated 写工具名（去序稳定）。
 *  「gated 写工具」= tier ∈ PLAN_GATED_TIERS 且不在豁免名单（todo_write/spawn_subagent：
 *  调研与清单更新是 plan 的输入/产出，pending 期必须保持可达）。 */
export function computeNarrow(
	activeNames: readonly string[],
	tiers: ReadonlyMap<string, string | undefined>,
): string[] {
	return activeNames.filter((n) => {
		const tier = tiers.get(n);
		return tier !== undefined && PLAN_GATED_TIERS.has(tier) && !PLAN_EXEMPT_TOOLS.has(n);
	});
}

/** 还原差分：合并加回（不是恢复快照）——保护收缩窗口内 tool_search 经 vendor
 *  addedToolNames 原生并入的延迟工具（plan D4）。去重保序。 */
export function computeRestore(
	activeNames: readonly string[],
	removed: readonly string[],
): string[] {
	return [...new Set([...activeNames, ...removed])];
}
