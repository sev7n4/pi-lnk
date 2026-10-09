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
 *
 * ⚠️ 它的角色是「**框宽未知时**的默认预算」（`condenseLabel` 的默认参数、
 *   非法框宽的回落），**不是**每个视图的实际预算。实际预算走 `labelBudgetFor`
 *   —— 各视图节点框宽差 5 倍，套同一个数会把宽框收紧、把窄框撑爆。
 */
export const LABEL_BUDGET = 24;

/** 节点框内边距（左右各 7px）。 */
const BOX_PADDING = 14;
/**
 * 1 单位宽 = 多少 px。`.l{font:12px sans-serif}` ⇒ 汉字≈12px 记 2 单位 ⇒ 6px/单位。
 * ⚠️ 拉丁字符实际约 6–7px（`m`/`w` 更宽），这里取下界保守估。
 */
const UNIT_PX = 6;

/**
 * 给定节点框宽，算出**该框真能装**的标签预算（单位宽）。
 *
 * ⭐⭐ 为什么必须有这个函数（2026-10-08，D3-2 实测）：
 * `LABEL_BUDGET = 24` 是照 **layout 的 554px 框宽**定的，但五个视图框宽差 5 倍：
 *
 * ```
 * 视图       框宽   旧口径(汉字)   若固定用 24 单位(=12 汉字)   结果
 * layout      554        45             12               收紧 3.75 倍
 * tree        150        11             12               溢出
 * swimlane    112         8             12               溢出 50%
 * ```
 *
 * 两类坏结果都**不会报错**（SVG 不换行，超宽只是视觉溢出；收紧也不违反任何断言）
 * ⇒ 只能靠测试钉住。照固定预算执行会把承载 63 节点真实画布的主视图砍到 1/4。
 *
 * ⚠️ 这里**不做** `Math.min(LABEL_BUDGET, …)` 的全局封顶：封顶等于把宽框也压到
 * 12 汉字，正是上面要避免的退化。`LABEL_BUDGET` 的角色是「**框宽未知时**的默认值」
 * （`condenseLabel` 的默认参数、以及非法输入的回落），不是宽框的天花板。
 */
export function labelBudgetFor(boxWidthPx: number): number {
	if (!Number.isFinite(boxWidthPx) || boxWidthPx < 0) return LABEL_BUDGET;
	const fits = Math.floor((boxWidthPx - BOX_PADDING) / UNIT_PX);
	// 框宽不足以放 1 个单位（如 4px）⇒ 预算 0。`condenseLabel(budget<=0)` 会返回原文，
	// 由调用方兜底 —— 绝不在这里悄悄吞内容。
	return fits <= 0 ? 0 : fits;
}

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
	// ⭐ 预算 0/负数（框宽不足1 单位）时不产出 "…" 这种无意义结果 ——
	//   直接返回原文，溢出由调用方兜底，绝不在这里悄悄吞内容。
	if (budget <= 0) return s;
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
	/**
	 * 原始标题（**未经** `condenseLabel`）。
	 *
	 * ⭐ 为什么 `label` 之外还要留它：业务序（`businessOrder`）是从标题推导的，
	 * 若布局改用提炼后的 `label` 排序，D3-2 一打开提炼就会**静默改变节点顺序**。
	 * knowledge 来源没有标题 ⇒ 可选。
	 */
	title?: string;
	status?: string;
	parentNode?: string;
	/**
	 * 画布上的原始摆放。**输入事实**，不是布局产物 —— tree 的根层排序在「无业务
	 * 序号」时会回落到它（见 `layout/tree.ts`）。
	 * ⚠️ 别与 IR「不含坐标」的判据混淆：那条指的是布局产出的 x/y/w/h。
	 */
	position?: { x?: number; y?: number };
	sourceKind: "canvas" | "knowledge" | "derived";
	/** 语义标注（情绪强度 / 超时 / 严重度）→ 映射为强调色。 */
	mark?: { kind: string; level: number; text?: string };
	color?: string;
	seq?: number;
}

export interface GraphIREdge {
	source: string;
	target: string;
	/**
	 * v1 的四种 kind 之外补 **`category`**：`relation=category` 是**无向**的分类关系，
	 * 映射到 sequence / dependency / containment / flow 里任何一个都会说错语义
	 * （containment 会暗示层级）。`edgeDirected` 对 category 返回 false。
	 */
	kind: "sequence" | "dependency" | "containment" | "flow" | "category";
	label?: string;
}

export interface GraphIR {
	view: GraphView;
	/**
	 * ⭐ C1 修正：relation 进 IR。方向（有无箭头）由 `edge.kind` 决定
	 * （判定收敛在 `edge-direction.ts` 的 `edgeDirected`），
	 * ⛔ 禁止渲染层自行决定 —— 迁移前 `buildTreeSvg` 不接收 relation 却无条件画箭头，
	 * `buildTimelineFlowSvg` 更是不接 `edges`，正是这条判据的反例。
	 *
	 * ⚠️ 另注：`buildTimelineFlowSvg` 目前**只被 import、没有调用点**，
	 * 生产 `view=timeline` 走的是行级渲染器 `buildTimelineSvg`。
	 * C1 在 timeline 上的改动因此暂时只影响布局层与单测，不影响线上输出；
	 * 等 timeline 切到 flow 渲染器时自动生效。
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
	colors?: Record<string, string | undefined>;
	emphasize?: readonly string[];
}

/**
 * 语义标注（D3-3 mark 通道的输入）。
 *
 * ⭐ 唯一来源是 `overlay.kind=severity`（调用方按节点给的级别），**不是**渲染层猜的
 *   —— 「什么是重要的」是输入事实，渲染只负责表达。
 */
export interface NodeMark {
	kind: string;
	/** 数值越大越该被强调；`visualRoles` 按它降序取前 `ACCENT_MAX_RATIO`。 */
	level: number;
	text?: string;
}

export interface GraphIRFromGvInput {
	view: GraphView;
	relation: "dependency" | "category";
	nodes: readonly GvNode[];
	edges: readonly GvEdge[];
	/**
	 * 按节点 id 索引的语义标注。缺省（或该 id 没有条目）⇒ 节点无 `mark`。
	 *
	 * ⛔ 不提供这个入口的话 `GraphIRNode.mark` 永远为空 ⇒ `visualRoles` 恒返回
	 *    `muted`，那是死代码。通道的输入端必须真的接得上调用方能给的东西。
	 */
	marks?: Readonly<Record<string, NodeMark | undefined>>;
	groupBy?: "type" | "status" | "parentNode";
	scope?: "structure" | "ownership" | "detail";
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
 * ⭐ `label` = 按 `labelBudget`提炼后的短标签，**原文完整保留在 `description`**。
 * 预算由调用方给（通常是布局层按本视图节点框宽算）⇒ IR 不假设框宽，
 * 也就不会把layout 的宽框预算套到 swimlane 的窄框上。
 *
 * @param labelBudget 该视图的标签预算（单位宽）。缺省走全局上限。
 */
export function graphIRFromGv(input: GraphIRFromGvInput & { labelBudget?: number }): GraphIR {
	const edgeKind: GraphIREdge["kind"] = input.relation === "dependency" ? "dependency" : "category";
	const budget = input.labelBudget;
	return {
		view: input.view,
		relation: input.relation,
		...(input.title !== undefined ? { title: input.title } : {}),
		nodes: input.nodes.map((n) => {
			const raw = n.title ?? n.id;
			const label = budget === undefined ? raw : condenseLabel(raw, budget);
			return {
				id: n.id,
				...(n.type !== undefined ? { type: n.type } : {}),
				label,
				// ⭐ 只有**真的被提炼了**才写 description —— 否则 `description`
				// 会等于 `title`，让调用方误以为「有全文可回落」。
				...(label !== raw ? { description: raw } : {}),
				...(n.title !== undefined ? { title: n.title } : {}),
				...(n.status !== undefined ? { status: n.status } : {}),
				...(n.parentNode !== undefined ? { parentNode: n.parentNode } : {}),
				// ⭐ 必须透传：`orderNodes` 的次级排序键就是画布 `position.y/x`。
				// 漏掉它 ⇒「有序号并列时按画布上下」这条判据失效，且**不会报错**
				//（原地下标恰好同序时结果一致）⇒ 静默的排序行为变化。
				...(n.position !== undefined ? { position: n.position } : {}),
				...(input.marks?.[n.id] !== undefined ? { mark: input.marks[n.id] } : {}),
				sourceKind: "canvas" as const,
			};
		}),
		edges: input.edges.map((e) => ({ source: e.source, target: e.target, kind: edgeKind })),
		...(input.groupBy !== undefined ? { groupBy: input.groupBy } : {}),
		...(input.scope !== undefined ? { scope: input.scope } : {}),
		...(input.colors !== undefined ? { colors: input.colors } : {}),
		...(input.emphasize !== undefined ? { emphasize: input.emphasize } : {}),
		...(input.focus !== undefined ? { focus: input.focus } : {}),
		...(input.hops !== undefined ? { hops: input.hops } : {}),
		...(input.focusAnchor !== undefined ? { focusAnchor: input.focusAnchor } : {}),
	};
}
