import type { MisplacedNode } from "../../tools/render-canvas-view.expressive.js";

/**
 * 布局层的公共类型与几何工具。
 *
 * ⭐ 本文件是坐标的**唯一来源**：`W` / `ROW_H` / `PLOT_*` 与 `edgePath` 从
 * `render-canvas-view.views.ts` 移到这里，视图侧改为 import —— 两处各留一份
 * 常量迟早漂移（历史上「两套逻辑必然漂移」在这里就是字面意义上的两套）。
 */

/** 画布宽。改它会同时影响所有视图与图例位置。 */
export const W = 720;
/** 行高。 */
export const ROW_H = 26;
/** 左侧标签带宽度（timeline 用它作 PLOT_X）。 */
export const LABEL_W = 150;
export const PLOT_X = LABEL_W;
export const PLOT_W = W - PLOT_X - 16;

export interface PlacedNode {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	row: number;
	/** 已按 `LABEL_BUDGET` 提炼（D3-2 之前等于原始 title/id）。 */
	label: string;
	description?: string;
	seq?: number;
	misplaced?: boolean;
	type?: string;
	/** 来自 `overlay.colors` 的按 id 覆盖色。 */
	color?: string;
	/** 分组键（`groupBy` 的结果），渲染层用它画分组边界与 `data-group`。 */
	groupKey?: string;
	emphasized?: boolean;
}

export interface PlacedEdge {
	source: string;
	target: string;
	/**
	 * SVG path 的 `d`。**可选**：layout 视图的三种出线策略（spread / bus / aggregate）
	 * 会改写起点盒，路径必须在渲染循环里按策略重算 ⇒ 布局只保证端点与方向。
	 */
	path?: string;
	/** ⭐ C1 修正：由 `edge.kind` 决定，⛔ 渲染层不得自行决定。 */
	directed: boolean;
	/** 是否在关键路径上（命中 `emphasize`）。 */
	isHi?: boolean;
	label?: string;
}

export interface GroupBox {
	key: string;
	label?: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface LaidOut {
	width: number;
	height: number;
	nodes: PlacedNode[];
	edges: PlacedEdge[];
	groups: GroupBox[];
	showType: boolean;
	colors?: Record<string, string | undefined>;
	emphasize?: readonly string[];
	/** 错位审计结果（渲染层直接消费，不重新推导 ⇒ 避免两套判定）。 */
	audit?: { misplaced: MisplacedNode[]; compared: number };
	/** 焦点视图的「自报家门」所需。 */
	focus?: { id: string; hops: number };
	/**
	 * 出边数超过 `AGGREGATE_THRESHOLD` 的源节点（layout 的 aggregate 策略要用）。
	 * 放在这里而不是让渲染层重算 —— 阈值一改就得同步两处，那是漂移的入口。
	 */
	aggSources?: readonly string[];
}

export function bboxArea(l: LaidOut): number {
	if (l.nodes.length === 0) return 0;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const n of l.nodes) {
		x0 = Math.min(x0, n.x);
		y0 = Math.min(y0, n.y);
		x1 = Math.max(x1, n.x + n.w);
		y1 = Math.max(y1, n.y + n.h);
	}
	return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

export function nodeAreaSum(l: LaidOut): number {
	return l.nodes.reduce((a, n) => a + n.w * n.h, 0);
}

/**
 * 空白率 = 1 − 节点面积和 / 包围盒面积。
 *
 * ⭐ C2 修正后的可测判据：规格原写「包围盒面积显著小于透传」，但五个视图的坐标
 * 全部来自行列计算、根本不读画布 `position` ⇒ **没有「透传」可比较**。
 */
export function whitespaceRatio(l: LaidOut): number {
	const b = bboxArea(l);
	if (b === 0) return 0;
	return 1 - nodeAreaSum(l) / b;
}

interface EdgeBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 节点右侧 → 目标左侧的折线（同源多条边时起点沿高度分散，修「扫帚」）。 */
export function edgePath(from: EdgeBox, to: EdgeBox, siblingIndex = 0, siblingCount = 1): string {
	const sx = from.x + from.w;
	const sy = from.y + (siblingCount <= 1 ? from.h / 2 : ((siblingIndex + 1) * from.h) / (siblingCount + 1));
	const tx = to.x;
	const ty = to.y + to.h / 2;
	const midX = sx + Math.max(18, (tx - sx) / 2);
	return `M${sx},${Math.round(sy)} C${Math.round(midX)},${Math.round(sy)} ${Math.round(midX)},${Math.round(ty)} ${tx},${Math.round(ty)}`;
}
