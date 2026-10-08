import type { GraphIREdge, GraphIR } from "./graph-ir.js";

/**
 * C1：一条边**是否带箭头**的唯一判定处。
 *
 * ⭐ 规格 §4.2(2)：有向关系必须带箭头、无向不得带，且⛔ 禁止渲染层自行决定。
 *   迁移前 `buildTreeSvg` / `buildTimelineFlowSvg` 根本不接 `relation`，
 *   无条件画箭头 —— 那正是这条判据的反例。
 *
 * 判定用 `edge.kind` 而不是 `ir.relation`：IR 允许一张图里同时出现多种关系
 * （例如混合来源的图，既有分类边也有依赖边）。只看 relation 会把
 * `relation=category` 图里那条 `kind=dependency` 的边方向抹掉。
 */

/** 无向的边类型 —— 只有分类关系无方向（`containment` 也有方向：父→子）。 */
const UNDIRECTED: ReadonlySet<GraphIREdge["kind"]> = new Set<GraphIREdge["kind"]>(["category"]);

/**
 * 这条边是否带箭头。
 *
 * @param ir 图级上下文。当前只用于将来区分「混合关系」时的兜底，
 *   保留参数是为了避免调用点各写一份 `e.kind !== "category"` ——
 *   那种散落正是 D2 之前「两套逻辑必然漂移」的同一个入口。
 * @param e IR 里的边。
 */
export function edgeDirected(ir: GraphIR, e: GraphIREdge): boolean {
	void ir; // ⭐ 刻意不参与判定：见上方文档。留着它是为了让调用点签名统一、可扩展。
	return !UNDIRECTED.has(e.kind);
}