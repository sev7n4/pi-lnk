import { orderNodes } from "../../tools/render-canvas-view.expressive.js";
import type { GvNode } from "../../tools/render-canvas-view.expressive.js";
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

	// ⚠️⏳ **D2 已知不一致，Task 9 收敛**：这里按「相邻行」无条件给 trunk，
	//   而不是按 IR 的 `edge.kind` 决定方向 —— 与迁移前的行为逐字节一致。
	//   迁移前 `buildTimelineFlowSvg` 压根不接 `edges`，方向是渲染层自行决定的。
	//   本次只把「串哪些行」搬进布局层，使它可断言、可在 Task 9 一处改掉。
	//   `row` 记的是**下行**的行号（末行没有下行 trunk）。
	const trunks: Trunk[] = [];
	for (let i = 1; i < placed.length; i++) {
		trunks.push({
			row: i,
			x: TRUNK_X,
			yTop: placed[i - 1].y + BAR_H,
			yBottom: placed[i].y,
			armTo: TRUNK_X,
			directed: true,
		});
	}

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