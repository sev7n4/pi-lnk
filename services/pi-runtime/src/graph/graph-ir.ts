import type { GvEdge, GvNode } from "../tools/render-canvas-view.expressive.js";

/**
 * GraphIR —— 图形化表达的唯一真相源。
 *
 * ⭐ IR **不含坐标**（沿用 v1）：坐标是布局阶段的产物，换视图不动 IR。
 * ⭐ `label` / `description` 分离是「文字提炼」能成为**可断言纯函数**的前提：
 *   `label` 进节点框且必须满足预算，`description` 只进 hover / 详情 / 导出。
 */

export const GRAPH_VIEWS = ["layout", "tree", "timeline", "swimlane", "matrix"] as const;
export const ROW_VIEWS = ["table"] as const;
export type GraphView = (typeof GRAPH_VIEWS)[number];
export type RowView = (typeof ROW_VIEWS)[number];
export type ResolvedView = GraphView | RowView;

/**
 * legacy 视图名 → 规范名。归一必须在 **IR 入口**完成 ⇒ IR 的 `view` 字段不含 legacy 值。
 *
 * ⛔ D1 数据：`topology` 32 次、`table` 40 次 ⇒ **本轮不得废弃这两个别名**。
 */
const LEGACY_ALIAS: Readonly<Record<string, ResolvedView>> = { topology: "layout" };

export function resolveView(v: unknown): ResolvedView | undefined {
	if (typeof v !== "string") return undefined;
	const hit = LEGACY_ALIAS[v];
	if (hit) return hit;
	if ((GRAPH_VIEWS as readonly string[]).includes(v)) return v as GraphView;
	if ((ROW_VIEWS as readonly string[]).includes(v)) return v as RowView;
	return undefined;
}

export function isGraphView(v: ResolvedView): v is GraphView {
	return (GRAPH_VIEWS as readonly string[]).includes(v);
}

/**
 * 标签预算（**单位宽**）：12 汉字 × 2 = 24，24 拉丁 × 1 = 24 ⇒ 同一个数表达两种边界。
 * ⭐ 统一成单位宽而不是字符数，否则中英混排时预算不可比。
 */
export const LABEL_BUDGET = 24;

/** CJK（含全角标点）按 2 单位计，其余按 1 单位。 */
const WIDE = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;

export function labelWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
	return w;
}

/**
 * 长文本 → 短标签。超出预算的部分**必须**由调用方放进 `description`（N8：
 * ⛔ 禁止用 CSS 截断 / 输出侧 clip 代替内容提炼）。
 */
export function condenseLabel(raw: string, budget: number = LABEL_BUDGET): string {
	const s = raw.trim();
	if (s === "") return "";
	if (labelWidth(s) <= budget) return s;
	// 省略号占 1 单位，先从预算里扣掉 —— 否则截断后的总宽仍会超出预算。
	const cap = budget - 1;
	let w = 0;
	let out = "";
	for (const ch of s) {
		const cw = WIDE.test(ch) ? 2 : 1;
		if (w + cw > cap) break;
		w += cw;
		out += ch;
	}
	return out.trimEnd() + "…";
}

export interface GraphIRNode {
	id: string;
	type?: string;
	/** 提炼后的短标签，满足 `LABEL_BUDGET`。 */
	label: string;
	/** 完整文本。⛔ 不进节点框。 */
	description?: string;
	status?: string;
	parentNode?: string;
	sourceKind: "canvas" | "knowledge" | "derived";
	/** 语义标注（情绪强度 / 超时 / 严重度）→ 映射为强调色。 */
	mark?: { kind: string; level: number; text?: string };
	color?: string;
	seq?: number;
}

export interface GraphIREdge {
	source: string;
	target: string;
	kind: "sequence" | "dependency" | "containment" | "flow";
	label?: string;
}

export interface GraphIR {
	view: GraphView;
	/**
	 * ⭐ C1 修正：relation 进 IR。方向（有无箭头）由 `edge.kind` 决定，
	 * ⛔ 禁止渲染层自行决定 —— 现状 `buildTreeSvg` / `buildTimelineFlowSvg`
	 * 不接收 relation 却无条件画箭头，正是这条判据的反例。
	 */
	relation: "dependency" | "category";
	title?: string;
	nodes: GraphIRNode[];
	edges: GraphIREdge[];
	groupBy?: "type" | "status" | "parentNode";
	scope?: "structure" | "ownership" | "detail";
	focus?: string;
	hops?: number;
	focusAnchor?: "spread" | "bus" | "aggregate";
	showType?: boolean;
	colors?: Record<string, string | undefined>;
	emphasize?: readonly string[];
}

export interface GraphIRFromGvInput {
	view: GraphView;
	relation: "dependency" | "category";
	nodes: readonly GvNode[];
	edges: readonly GvEdge[];
	groupBy?: "type" | "status" | "parentNode";
	scope?: "structure" | "ownership" | "detail";
	showType?: boolean;
	colors?: Record<string, string | undefined>;
	emphasize?: readonly string[];
	focus?: string;
	hops?: number;
	focusAnchor?: "spread" | "bus" | "aggregate";
	title?: string;
}

/**
 * GvNode[] → GraphIR。
 *
 * ⚠️ 本阶段 **不做** `condenseLabel`：`label` 原样取 `title ?? id`，与迁移前
 * `nodeRect` 的 `opts.label ?? n.title ?? n.id` 完全一致。提炼在 D3-2 落地 ——
 * 提前做会破坏 D2「对外输出逐字节不变」的验收判据。
 */
export function graphIRFromGv(input: GraphIRFromGvInput): GraphIR {
	const edgeKind: GraphIREdge["kind"] = input.relation === "dependency" ? "dependency" : "category";
	return {
		view: input.view,
		relation: input.relation,
		...(input.title !== undefined ? { title: input.title } : {}),
		nodes: input.nodes.map((n) => ({
			id: n.id,
			...(n.type !== undefined ? { type: n.type } : {}),
			label: n.title ?? n.id,
			description: n.title !== undefined && n.title !== n.id ? n.title : undefined,
			...(n.status !== undefined ? { status: n.status } : {}),
			...(n.parentNode !== undefined ? { parentNode: n.parentNode } : {}),
			sourceKind: "canvas",
		})),
		edges: input.edges.map((e) => ({ source: e.source, target: e.target, kind: edgeKind })),
		...(input.groupBy !== undefined ? { groupBy: input.groupBy } : {}),
		...(input.scope !== undefined ? { scope: input.scope } : {}),
		...(input.showType !== undefined ? { showType: input.showType } : {}),
		...(input.colors !== undefined ? { colors: input.colors } : {}),
		...(input.emphasize !== undefined ? { emphasize: input.emphasize } : {}),
		...(input.focus !== undefined ? { focus: input.focus } : {}),
		...(input.hops !== undefined ? { hops: input.hops } : {}),
		...(input.focusAnchor !== undefined ? { focusAnchor: input.focusAnchor } : {}),
	};
}
