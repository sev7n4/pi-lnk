import type { GraphIR } from "./graph-ir.js";

/**
 * IR → 视觉角色（D3-3 的「谁该被强调」）。
 *
 * ⭐ 判据来源：**业界高亮共识是 10%，不是 20%**。
 *   SAP 人机界面规范「不超过 10% 的屏幕内容应额外强调；通常最好只强调少于 3 项」、
 *   Universal Principles of Design「高亮不超过 10%；超过则效果被稀释」、
 *   OCAD POED「永远不要高亮超过 10% 的可见设计」。
 *   计划 v1 写的 20% 偏松 —— 63 节点的真实画布上就是 12 个强调元素，等于没有强调。
 *
 * ⛔ 渲染层**不得**自己猜谁重要：「什么是重要的」是输入事实（`node.mark`），
 *   渲染只负责表达。这也是 Mermaid / D2 / Graphviz 的共性做法 ——
 *   语义是节点自带的一等字段，渲染层只做映射。
 */

export const ACCENT_MAX_RATIO = 0.1;

export type VisualRole = "accent" | "primary" | "muted";

/**
 * @returns 每个节点 id 的角色。无 `mark` 的节点一律 `muted`（不是 `accent`）。
 */
export function visualRoles(ir: GraphIR): Map<string, VisualRole> {
	const total = ir.nodes.length;
	// ⭐ 至少 1 个：10 个节点的 10% = 1；ceil 保证「有标注就至少标出一个」。
	const cap = total === 0 ? 0 : Math.max(1, Math.ceil(total * ACCENT_MAX_RATIO));
	const marked = ir.nodes.filter((n) => n.mark !== undefined && n.mark.level > 0);
	// 稳定排序：level 降序，同 level 保持 IR 里的原序（不引入第二套排序）
	const top = new Set(
		[...marked]
			.sort((a, b) => (b.mark?.level ?? 0) - (a.mark?.level ?? 0))
			.slice(0, cap)
			.map((n) => n.id),
	);
	return new Map(
		ir.nodes.map((n) => [
			n.id,
			top.has(n.id) ? ("accent" as const) : n.type !== undefined ? ("primary" as const) : ("muted" as const),
		]),
	);
}

/** D3-3 渲染能表达的 severity 级别。⛔ 不是 `NodeMark.text` 的全部取值域。 */
export type SeverityLevel = "error" | "warn";

/**
 * IR → 该节点**可被渲染表达**的 severity 级别。
 *
 * ⛔ 为什么不能直接 `as SeverityLevel`：调用方传的 `mark.text` 是自由字符串
 *   （`NodeMark.text?: string`），只有 `error` / `warn` 两种级别有对应的视觉语言
 *   （红描边 / 琥珀描边）。其余取值（`"critical"`、`"高风险"`、空串…）**收不到就
 *   返回 undefined，而不是 `as` 强转当 error 上色** —— 后者会把一个没定义的颜色
 *   画成最高级别的红，是在图上编造严重度（与「级别贴到错的节点上」同级的事故）。
 *
 *   判据：`roles` 为 `accent`（进了前 `ACCENT_MAX_RATIO`）+ `text` 是已知级别。
 *   两个条件都要 —— 只看 text 会让被 10% 上限挤掉的节点漏出强调。
 *
 * @param roles `visualRoles(ir)` 的返回值（由本文件产出，避免调用方各建一套）
 */
export function severityOf(
	ir: GraphIR,
	roles: ReadonlyMap<string, VisualRole>,
	id: string,
): SeverityLevel | undefined {
	if (roles.get(id) !== "accent") return undefined;
	const text = ir.nodes.find((n) => n.id === id)?.mark?.text;
	return text === "error" || text === "warn" ? text : undefined;
}
