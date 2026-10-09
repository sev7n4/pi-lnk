import type { GraphIR, GraphIRNode } from "../graph-ir.js";
import { W, type LaidOut } from "./types.js";

/**
 * matrix 视图的布局：GraphIR → 交叉表的行列与格子坐标。
 *
 * ⭐ matrix 画的是**格子**而不是节点框 ⇒ 它不产出 `LaidOut.nodes`，
 *   产出的是 `matrix.cells`（每个交叉一个已算好坐标的格子）。
 *
 * ⚠️ 行列顺序**按首次出现、不排序**，这是刻意的：matrix 的行含义是
 *   「用户自己建的分类」，排序会打乱分类逻辑（与 tree/timeline 的
 *   「业务序优先」故意不同）。迁移前 `buildMatrixSvg` 直接 `nodes = nodesIn`。
 */

/** 左侧行标签带宽度（也是绘图区起点）。 */
const LABEL_W = 150;
/** 行高。 */
const ROW_H = 30;
/** 格子四周内缩。 */
const CELL_INSET = 2;
/** 顶部列头基线 y。 */
const COL_LABEL_Y = 30;
/** 首行顶部 y。 */
const FIRST_ROW_Y = 44;
/** 顶部预留（列头 + 留白）。 */
const TOP_PAD = 50;
/** 底部预留（图例）。 */
const BOTTOM_PAD = 30;

export type MatrixBy = "type" | "status" | "parentNode";

export interface MatrixCell {
	row: string;
	col: string;
	count: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MatrixGrid {
	rows: string[];
	cols: string[];
	labelW: number;
	cw: number;
	ch: number;
	/** 首行顶部 y（渲染层算 `y + ch/2` 得行标签基线）。 */
	firstRowY: number;
	/** 列头基线 y。 */
	colLabelY: number;
	cells: MatrixCell[];
	/** 图例左上角 y。 */
	legendY: number;
}

export type MatrixLaidOut = LaidOut & { matrix: MatrixGrid };

function keyOf(n: GraphIRNode, by: MatrixBy): string {
	return String(n[by] ?? "未分类");
}

export function layoutMatrix(ir: GraphIR, rowBy: MatrixBy, colBy: MatrixBy): MatrixLaidOut {
	// ⭐ 不排序：交叉表的行序 = 用户建分类的顺序（见文件头注释）。
	const nodes = ir.nodes;
	const rows: string[] = [];
	const cols: string[] = [];
	for (const n of nodes) {
		const r = keyOf(n, rowBy);
		if (!rows.includes(r)) rows.push(r);
		const c = keyOf(n, colBy);
		if (!cols.includes(c)) cols.push(c);
	}

	// ⚠️ `Math.max(1, cols.length)` 防除零；但列宽下限要≥1，否则格子宽度 0 ⇒ 看不见。
	const cw = Math.max(1, Math.floor((W - LABEL_W) / Math.max(1, cols.length)));
	const H = TOP_PAD + rows.length * ROW_H + BOTTOM_PAD;

	const cellKey = (r: string, c: string): number =>
		nodes.filter((n) => keyOf(n, rowBy) === r && keyOf(n, colBy) === c).length;
	const cells: MatrixCell[] = [];
	rows.forEach((r, ri) => {
		cols.forEach((c, ci) => {
			cells.push({
				row: r,
				col: c,
				count: cellKey(r, c),
				x: LABEL_W + ci * cw,
				y: FIRST_ROW_Y + ri * ROW_H,
				w: cw - CELL_INSET * 2,
				h: ROW_H - CELL_INSET * 2,
			});
		});
	});

	return {
		width: W,
		height: H,
		// matrix 不画节点框；节点信息已编码进 cells 的 count
		nodes: [],
		edges: [],
		groups: [],
		...(ir.colors !== undefined ? { colors: ir.colors } : {}),
		matrix: {
			rows,
			cols,
			labelW: LABEL_W,
			cw,
			ch: ROW_H,
			firstRowY: FIRST_ROW_Y,
			colLabelY: COL_LABEL_Y,
			cells,
			legendY: H - 26,
		},
	};
}