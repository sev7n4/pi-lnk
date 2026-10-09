import { orderNodes } from "../../tools/render-canvas-view.expressive.js";
import type { GvNode } from "../../tools/render-canvas-view.expressive.js";
import { edgeDirected } from "../edge-direction.js";
import type { GraphIR, GraphIRNode } from "../graph-ir.js";
import { PLOT_W, PLOT_X, ROW_H, W, type LaidOut, type PlacedNode, type Trunk } from "./types.js";

/**
 * timeline 视图的布局：GraphIR → 行序 + 纵坐标 + 行间连线。
 *
 * ⭐ 本函数不产出字符串；`trunks` 把「哪两行之间有线」这个决定从渲染层收进来 ——
 * 迁移前渲染层按 `i < nodes.length - 1` 自行判断，等于把「顺序」当成了既成事实。
 */

/** 节点框高度。 */
const BAR_H = 20;
/** 行间连线距绘图区左边缘的距离。 */
const TRUNK_X = 16;
/** 图例区与正文之间预留的高度。 */
const LEGEND_PAD = 34;

/** 保持业务序的稳定排序（`orderNodes` 需要 `GvNode` 的 `position`）。 */
function toGv(n: GraphIRNode): GvNode {
	return {
		id: n.id,
		...(n.type !== undefined ? { type: n.type } : {}),
		...(n.title !== undefined ? { title: n.title } : {}),
		...(n.status !== undefined ? { status: n.status } : {}),
		...(n.position !== undefined ? { position: n.position } : {}),
	};
}

export function layoutTimelineFlow(ir: GraphIR): LaidOut & { trunks: Trunk[] } {
	const flat = orderNodes(ir.nodes.map(toGv));
	const H = 40 + flat.length * ROW_H + LEGEND_PAD;
	const irById = new Map(ir.nodes.map((n) => [n.id, n]));
	const placed: PlacedNode[] = flat.map((n, i) => {
		const irn = irById.get(n.id);
		return {
			id: n.id,
			x: PLOT_X,
			y: 30 + i * ROW_H,
			w: PLOT_W,
			h: BAR_H,
			row: i,
			label: irn?.label ?? n.id,
			...(irn?.description !== undefined ? { description: irn.description } : {}),
			seq: i + 1,
			...(n.type !== undefined ? { type: n.type } : {}),
			...(ir.colors?.[n.id] !== undefined ? { color: ir.colors[n.id] } : {}),
		};
	});

	// C1：trunk 只串**IR 里真实存在的边**，方向由 `edgeDirected` 决定。
	//   ⛔ 不再按「相邻行」无条件串 —— 那等于宣称「行序= 流转序」，
	//   而 IR 里并没有这条事实（迁移前 `buildTimelineFlowSvg` 压根不接 edges）。
	//   无向边仍然画 trunk，只是不带箭头：顺序信息不丢，方向不造假。
	//   `row` 记的是**下行**的行号。
	const rowOf = new Map(placed.map((p) => [p.id, p.row]));
	const trunks: Trunk[] = [];
	for (const e of ir.edges) {
		const fromRow = rowOf.get(e.source);
		const toRow = rowOf.get(e.target);
		// 端点不在图内 ⇒ 丢弃（不编造）；同行 ⇒ 无「行间」可连
		if (fromRow === undefined || toRow === undefined || fromRow === toRow) continue;
		const lo = Math.min(fromRow, toRow);
		const hi = Math.max(fromRow, toRow);
		trunks.push({
			row: hi,
			x: TRUNK_X,
			yTop: placed[lo].y + BAR_H,
			yBottom: placed[hi].y,
			armTo: TRUNK_X,
			directed: edgeDirected(ir, e),
		});
	}
	// 行号小的在前：渲染层按数组顺序画，重叠 trunk 时上层是谁是确定的
	trunks.sort((a, b) => a.row - b.row);

	return {
		width: W,
		height: H,
		nodes: placed,
		// timeline 不画依赖边（顺序由 trunk 表达）⇒ 不从 `ir.edges` 取。
		edges: [],
		groups: [],
		showType: ir.showType === true,
		...(ir.colors !== undefined ? { colors: ir.colors } : {}),
		flatOrder: flat.map((n) => n.id),
		trunks,
	};
}