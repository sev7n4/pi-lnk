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

/** B-1 修复（#906 重启泄漏）：resume 治愈的差分计算面。
 *
 *  泄漏机理（2026-11-16 B-1' SDD 取证 F2 + 对 #906 的审计）：`narrowedRemoved` 记账是
 *  进程内存态（plan-gate store LRU），重启即失；而盘上 lane config 的收缩态被 vendor
 *  `pi.lane.config` 持久化。重启后 resume 播种 pending=true ⇒ before_run 重收缩时
 *  `computeNarrow(current)` 返回 []（gated 已不在）⇒ `setToolsetNarrow(key,true,[])`
 *  把 removed 覆成空 ⇒ 之后 execute 还原 `computeRestore(current, [])` 原样放回收缩集
 *  ⇒ gated 写工具**永久**不可见（写工具在常驻集，tool_search 无法找回）。
 *  死亡落在「markPlanDecision(execute) 之后、after_tool 还原之前」的窗口同理。
 *
 *  治愈口径：resume 时把声明集收敛到 `base ∪ activated`（激活从 transcript 累计恢复——
 *  与 D4「合并加回」同源镜像），随后 before_run 依据播种出的 pending 重差分并正确记账。 */

/** base ∪ activated（去重，base 序在前、activated 按首次出现序；激活 ⊆ registered ⇒
 *  结果恒满足 vendor 的 activeToolNames ⊆ config.tools 校验）。 */
export function computeConverged(base: readonly string[], activated: readonly string[]): string[] {
	return [...new Set([...base, ...activated])];
}

/** resume 恢复：扫 transcript 把 tool_search 结果的 details.loaded **累计求并集**
 *  （多次搜索的激活要合并保留——刻意不是 pickLatest 的「取末条」语义，只沿用其防御式
 *  解析形态：message 包裹层 + result.details 顶层形态双兼容）。非 string / 空串 /
 *  异形态逐项跳过，绝不抛。返回按首次出现序去重的名单。 */
export function pickActivatedBySearch(entries: readonly unknown[]): string[] {
	const acc = new Set<string>();
	for (const e of entries) {
		const row = e as {
			toolName?: string;
			details?: unknown;
			result?: { details?: unknown };
			message?: { toolName?: string; details?: unknown; result?: { details?: unknown } };
		} | null;
		if (!row) continue;
		let raw: unknown;
		if (row.toolName === "tool_search") {
			raw = row.details ?? row.result?.details;
		} else if (row.message?.toolName === "tool_search") {
			raw = row.message.details ?? row.message.result?.details;
		} else {
			continue;
		}
		const loaded = (raw as { loaded?: unknown } | undefined)?.loaded;
		if (!Array.isArray(loaded)) continue;
		for (const name of loaded) {
			if (typeof name === "string" && name.length > 0) acc.add(name);
		}
	}
	return [...acc];
}
