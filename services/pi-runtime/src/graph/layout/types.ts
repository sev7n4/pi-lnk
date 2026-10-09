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
	/** 层级深度（tree 用，从 0 起）。其他视图不产出。 */
	depth?: number;
	/** 是否是「无 parentNode 也无入边」的孤儿节点（tree 用，画在末尾分隔区）。 */
	orphan?: boolean;
	/** 阶段列号（swimlane 用；渲染层写 `data-stage`，不自己重算）。 */
	stage?: number;
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

/**
 * tree视图的父子连线（trunk）：竖线 + 底端横臂。
 *
 * ⭐ 与 `PlacedEdge` 分开：trunk 的端点不是「某条边的两端」，而是「上一行与本行的
 * 缩进位置」，来源是层级推断而不是 `edges`。混进 `edges` 会让 containment 被当依赖画。
 */
export interface Trunk {
	/** 所属行号（= 子节点所在行）。 */
	row: number;
	/** 竖线 x。 */
	x: number;
	/** 竖线起点 y（上一行中心）。 */
	yTop: number;
	/** 竖线终点 / 横臂起点 y（本行中心）。 */
	yBottom: number;
	/** 横臂终点 x（=子节点框左边缘 −8）。 */
	armTo: number;
	/** ⭐ C1：箭头由 IR 的 containment 语义决定，渲染层不得自行决定。 */
	directed: boolean;
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
	/**
	 * **平铺序**的节点 id（业务序优先，回落画布 y/x）。
	 *
	 * ⭐ 与 `nodes`（行序 = 视图的排布结果）**刻意不同**：图例的排列顺序取自
	 * 「第一次出现的类型」，而 `shortLabels` / `commonSuffixes` 的后缀计数与
	 * `Map` 插入序也都依赖输入顺序。迁移前这些helper 吃的是平铺序，
	 * 若渲染层改吃行序（tree 的 DFS 序）⇒ 图例与群组后缀的排列会静默改变。
	 * 所以由布局层显式给出，而不是让渲染层自己再排一次。
	 */
	flatOrder?: readonly string[];
	/** 阶段列宽（swimlane 的列头与节点框共用；改它必须两处同步）。 */
	stageW?: number;
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

/**
 * 节点框两两相交的面积之和（重叠量）。
 *
 * ⭐ 为什么必须有它：**`whitespaceRatio` 在节点重叠时会算出负数**
 * （`nodeAreaSum > bboxArea`），而负数读起来像「极其紧凑」—— 含义恰好相反
 * （重叠 = 节点被后面的盖住 = 看不见）。这是典型的静默降级：一个真实缺陷被
 * 指标表达成了优点，且不会报错。
 *
 * ⇒ **判读顺序固定为：先看 `hasOverlap`，再看 `whitespaceRatio`。**
 *   有重叠时 `whitespaceRatio` 不可判读（swimlane 实测 −0.43）。
 */
export function overlapArea(l: LaidOut): number {
	let area = 0;
	for (let i = 0; i < l.nodes.length; i++) {
		for (let j = i + 1; j < l.nodes.length; j++) {
			const a = l.nodes[i];
			const b = l.nodes[j];
			const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
			const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
			if (w > 0 && h > 0) area += w * h;
		}
	}
	return area;
}

export function hasOverlap(l: LaidOut): boolean {
	return overlapArea(l) > 0;
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
