/**
 * render_canvas_view（tier="present"）：把画布上已有的节点/边/表格以只读 SVG 卡片呈现。
 *
 * spec docs/superpowers/specs/2026-10-03-tool-contract-and-canvas-render-card-design.md
 * §4.1 落点判据 / §4.5 SVG 安全 / §4.7 视图维度 / §5.1 入参契约。
 *
 * 行为契约（不可放宽）：
 *   - **只读**：只调 fetchLayout，不 POST 任何 Nest 写端点
 *   - **不编造**：数据源缺失 → ok:false + missing 清单，不填假行
 *   - **非静默降级**：overlay 传给 topology → 报错，不忽略
 *   - **不阻塞**：不 await 用户，立即 resolve
 *
 * **行级指标（时长/台词字数/情绪强度）没有画布数据源**——`get-canvas-layout` 的 node 只有
 * `{id, type, title, position}`。故这些指标只能由调用方经 `overlay.data` 逐行提供，
 * 本文件**不按节点下标造时长**（spec §5.1「数据源不存在则报错，不编造」）。没有 `overlay.data`
 * 时 timeline 退化为**等宽刻度**（形状仍在，时长/预算一概不画）。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import { presentResult, presentResultDual } from "./present-result.js";
import { buildNodeGraphPayload } from "./node-graph-payload.js";
import {
	ALLOWED_COLOR_NAMES,
	isAllowedColorName,
	MAX_NODES_PER_VIEW,
	SVG_MAX_CHARS,
	type GvNode,
	svgBudgetReport,
	suggestNodeIds,
} from "./render-canvas-view.expressive.js";
import type { NodeMark } from "../graph/graph-ir.js";
import {
	buildLayoutSvg,
	buildMatrixSvg,
	buildSwimlaneSvg,
	buildTimelineFlowSvg,
	buildTreeSvg,
} from "./render-canvas-view.views.js";

/**
 * view × relation × groupBy**三维正交**。
 *
 * - `view` —— 形状（布局），回答"画成什么样"
 * - `relation` —— 关系（意图），回答"看什么关系"
 * - `groupBy` —— 分组依据，回答"按什么分组"
 *
 * 旧名`topology` 保留为 `layout` + `relation=dependency` 的别名（向后兼容，见
 * `resolveView`）。`table` 保留给"逐行列出 + 行级overlay"的旧场景。
 */
const VIEWS = ["layout", "tree", "timeline", "swimlane", "matrix", "topology", "table"] as const;
const RELATIONS = ["dependency", "category"] as const;
/**
 * 观察尺度：宏观讲原理 / 中观看归属 / 微观求精确（2026-08-05 产品决策）。
 * ⚠️ `relation=dependency` 时**默认 structure**：依赖在用户嘴里就排除了「顺序」，
 * 把 `image→image` 的镜头顺序画成依赖箭头是主动误导。
 */
const SCOPES = ["structure", "ownership", "detail"] as const;
/**
 * 局部视图的出线策略（默认 `spread`）。
 * - `spread`：焦点节点高度按下游数拉伸，每条边真正错开 —— 想看清「谁连到谁」
 * - `bus`：高度不变，右侧加垂直汇流条 —— 想看「一个焦点连出一片」的整体感
 * - `aggregate`：边数超阈值时聚合成单箭头 +「→ N 个下游」—— 只关心数量
 *
 * 三种都保留是因为它们诉求不同：硬编码一种会让「看清关系」与「看规模」互相冲突。
 */
const FOCUS_ANCHORS = ["spread", "bus", "aggregate"] as const;
const GROUP_BYS = ["type", "status", "parentNode"] as const;
/** 行级指标 overlay（时长/台词/情绪/级别）—— 与 `relation` 正交，用于 timeline/table。 */
const OVERLAYS = ["emotion", "budget", "severity"] as const;

export type ViewKind = (typeof VIEWS)[number];
export type RelationKind = (typeof RELATIONS)[number];
export type ScopeKind = (typeof SCOPES)[number];
export type GroupByKind = (typeof GROUP_BYS)[number];
export type OverlayKind = (typeof OVERLAYS)[number];

/** `topology` 是 `layout` 的旧名；`table` 走旧渲染路径。 */
function isLegacyView(v: ViewKind): boolean {
	return v === "topology" || v === "table";
}


export interface TimelineRow {
	shotId: string;
	label: string;
	/**
	 * 真实镜头时长（秒）。**可选**：画布 layout 不含该字段，调用方未经 `overlay.data` 提供时为
	 * `undefined`，此时本文件按等宽刻度渲染且**不输出任何时长数字**——宁可少画，不编造。
	 */
	durationSec?: number;
	/** 台词字数；与 durationSec 同时存在时才可能判超预算。 */
	dialogueChars?: number;
	/** 情绪强度（0–10 渲染量程）；仅 `overlay=emotion` 且 ≥2 行有值时才画折线。 */
	emotion?: number;
}
export interface TopoNode {
	id: string;
	title: string;
}
export interface TopoEdge {
	source: string;
	target: string;
}
export interface TableRow {
	id: string;
	cells: string[];
}
export interface Overlay {
	kind: OverlayKind;
	data: unknown;
}

/** `overlay.data` 的行级项（spec §5.1：行级指标的唯一来源）。 */
interface OverlayItem {
	/** 与画布 node 对齐的 id；缺省时按数组顺序对应画布节点。 */
	node_id?: string;
	/** 覆盖节点标题的显示名。 */
	label?: string;
	duration_sec?: number;
	dialogue_chars?: number;
	emotion?: number;
	/** `overlay=severity` 的行底色级别：`error` / `warn`。 */
	level?: string;
}

/** 中文口播语速上限：4–5 字/秒，取 4.5 作判据（spec §5.1）。 */
const CHARS_PER_SEC = 4.5;

/** 情绪强度渲染量程（0–10）；越界值在几何计算里被夹取，不外溢画布。 */
const EMOTION_MAX = 10;

/** 无真实时长时的等宽刻度宽度（px）。 */
const TICK_W = 48;

const W = 720;
const PLOT_X = 120;
const PLOT_W = W - 160;
const ROW_H = 34;
const TRACK_H = 60;

/** 有限数取用；非有限（NaN / ±Infinity / undefined）一律视作「无此指标」。 */
function finite(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 文本/属性值转义：agent 生成的标题是不可信输入，未转义则标签被解析、卡片内容静默丢失（spec §4.5）。 */
function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * overlay 形状校验：`kind` 必须在枚举内；`data` 必须是数组（行级数据）或空对象 `{}`
 * （显式声明「本视图无行级数据」）。**其他非空非数组形态 → 抛错**，因为静默渲染空轨道会让
 * agent 以为叠加生效了（spec §4.7 非静默降级）。错误信息带 overlay kind 名字便于定位。
 */
function assertOverlay(overlay: Overlay | undefined): void {
	if (!overlay) return;
	if (!OVERLAYS.includes(overlay.kind)) {
		throw new Error(`overlay.kind 非法：${String(overlay.kind)}，可选 ${OVERLAYS.join(" | ")}`);
	}
	const { data } = overlay;
	if (Array.isArray(data)) return;
	if (isPlainObject(data) && Object.keys(data).length === 0) return;
	throw new Error(
		`overlay.kind=${overlay.kind} 的 data 必须是数组（每项 {node_id?, label?, duration_sec?, dialogue_chars?, emotion?, level?}）` +
			`或空对象 {}（声明无行级数据），收到 ${data === null ? "null" : Array.isArray(data) ? "array" : typeof data}`,
	);
}

/**
 * 逐项校验并归一 `overlay.data`。字段存在但类型/取值非法 → 抛错，**不**当 0 参与渲染
 * （当 0 会让「超预算」判据给出假的否定结论）。
 */
function parseOverlayItems(overlay: Overlay | undefined): OverlayItem[] {
	if (!overlay || !Array.isArray(overlay.data)) return [];
	const numeric: Array<["duration_sec" | "dialogue_chars" | "emotion", string]> = [
		["duration_sec", "有限数字（秒）"],
		["dialogue_chars", "有限非负数字（字）"],
		["emotion", "有限数字（0–10）"],
	];
	return overlay.data.map((raw, i) => {
		if (!isPlainObject(raw)) {
			throw new Error(`overlay.kind=${overlay.kind} 的 data[${i}] 必须是对象，收到 ${typeof raw}`);
		}
		const item: OverlayItem = {};
		for (const key of ["node_id", "label", "level"] as const) {
			const v = raw[key];
			if (v === undefined) continue;
			if (typeof v !== "string") {
				throw new Error(`overlay.kind=${overlay.kind} 的 data[${i}].${key} 必须是字符串，收到 ${typeof v}`);
			}
			item[key] = v;
		}
		for (const [key, desc] of numeric) {
			const v = raw[key];
			if (v === undefined) continue;
			const n = finite(v);
			if (n === undefined) {
				throw new Error(`overlay.kind=${overlay.kind} 的 data[${i}].${key} 必须是${desc}，收到 ${JSON.stringify(v) ?? typeof v}`);
			}
			if (key !== "emotion" && n < 0) {
				throw new Error(`overlay.kind=${overlay.kind} 的 data[${i}].${key} 不得为负，收到 ${n}`);
			}
			item[key] = n;
		}
		return item;
	});
}

/** `overlay=severity` 的行底色 class；非 error/warn 视作无级别（不配色，不猜）。 */
function severityClass(level: string | undefined): string {
	if (level === "error") return "sev-error";
	if (level === "warn") return "sev-warn";
	return "";
}

/**
 * 把 `overlay.data` 对齐到各行：带 `node_id` 的按 id 命中，不带 `node_id` 的按数组顺序依次填入
 * **尚未被 id 命中**的行。两侧都没有 ⇒ 该行无行级数据。
 *
 * 单一对齐实现：`execute`（取duration/dialogueChars/emotion/label）与 `buildTimelineSvg` /
 * `buildTableSvg`（取 severity level）必须用同一套规则，否则 `node_ids` 过滤或乱序时
 * 级别会贴到错误的行上——那既是静默错配，也是在图上编造不存在的数据。
 */
function alignByKey(items: OverlayItem[], keys: string[]): Array<OverlayItem | undefined> {
	const byNodeId = new Map<string, OverlayItem>();
	const positional: OverlayItem[] = [];
	for (const it of items) {
		if (it.node_id === undefined) positional.push(it);
		else byNodeId.set(it.node_id, it);
	}
	let cursor = 0;
	return keys.map((k) => byNodeId.get(k) ?? positional[cursor++]);
}

/** 情绪折线纵坐标：按 0–10 固定量程映射并夹取，避免越界值把点画到画布外。 */
function emotionY(trackTop: number, emotion: number): number {
	const clamped = Math.max(0, Math.min(EMOTION_MAX, emotion));
	return Math.round(trackTop + TRACK_H - (clamped / EMOTION_MAX) * TRACK_H);
}

export function buildTimelineSvg(rows: TimelineRow[], overlay?: Overlay): string {
	assertOverlay(overlay);
	const items = Array.isArray(overlay?.data) ? alignByKey(overlay.data as OverlayItem[], rows.map((r) => r.shotId)) : [];
	// 只有 ≥2 行带真实情绪值才画折线：1 个点画不出线，0 个点画出来是假的。
	const emoRows = rows.map((r, i) => ({ i, e: finite(r.emotion) })).filter((x) => x.e !== undefined);
	const hasTrack = overlay?.kind === "emotion" && emoRows.length >= 2;
	// 量程取真实时长的最大值；全为 0（或无时长）时 maxDur=0，须走等宽刻度，否则 0/0 → NaN 宽度。
	const durs = rows.map((r) => finite(r.durationSec));
	const maxDur = Math.max(0, ...durs.map((d) => d ?? 0));
	const bodyBottom = 30 + rows.length * ROW_H + 10;
	const trackTop = bodyBottom;
	const h = hasTrack ? trackTop + TRACK_H + 8 : bodyBottom;
	// 超预算与severity 是**两条正交的轴**：前者改描边、后者改填充，故可同时生效而不互相抹除。
	// severity 的配色规则仅在真要用到时才写进<style> —— 类名含 "warn" 字面量，常驻会让
	// 契约测试「未超预算时图上不得出现任何超预算标记」的 /warn/ 断言失去意义。
	const sev = overlay?.kind === "severity";
	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img">`,
		`<style>.bar{fill:#dbe4ee}.over{stroke:#c0392b;stroke-width:2}.lbl{font:12px sans-serif;fill:#334}${
			sev ? ".sev-error{fill:#fdecea}.sev-warn{fill:#fff6e5}" : ""
		}</style>`,
	];
	rows.forEach((r, i) => {
		const y = 30 + i * ROW_H;
		const dur = durs[i];
		const chars = finite(r.dialogueChars);
		// 无真实时长 → 等宽刻度；超预算判定需要时长与字数同时存在，缺一即不判（不编造）。
		const over = dur !== undefined && chars !== undefined && chars > dur * CHARS_PER_SEC;
		const w = dur === undefined || maxDur <= 0 ? TICK_W : Math.max(4, Math.round((dur / maxDur) * PLOT_W));
		// 两个class 累加而非互斥：`over` 与 severity 级别同时成立时都写上，
		// 不会出现「属性说超预算、填充说没超」的矛盾行。
		const cls = [over ? "over" : "", sev ? severityClass(items[i]?.level) : ""].filter(Boolean).join(" ");
		parts.push(
			`<text x="8" y="${y + 14}" class="lbl">${esc(r.label)}</text>`,
			`<rect class="bar${cls ? ` ${cls}` : ""}" x="${PLOT_X}" y="${y}" width="${w}" height="20"${over ? ' data-warn="1"' : ""}/>`,
		);
		// 时长只在真实存在时写；否则图上不出现任何时长数字。
		if (dur !== undefined) parts.push(`<text x="${PLOT_X + w + 4}" y="${y + 14}" class="lbl">${dur}s</text>`);
	});
	if (hasTrack) {
		const n = rows.length;
		const pts = emoRows
			.map(({ i, e }) => {
				const x = Math.round(PLOT_X + (n <= 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W));
				return `${x},${emotionY(trackTop, e!)}`;
			})
			.join(" ");
		parts.push(`<polyline points="${pts}" fill="none" stroke="#4a7ebb" stroke-width="2"/>`);
	}
	parts.push("</svg>");
	return parts.join("");
}

export function buildTopologySvg(nodes: TopoNode[], edges: TopoEdge[]): string {
	const h = 40 + nodes.length * 30;
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img">`,
		`<style>.n{fill:#eef2f7;stroke:#8aa}.t{font:12px sans-serif;fill:#334}.e{stroke:#8aa;stroke-width:1.5}</style>`,
	];
	edges.forEach((e) => {
		// 端点不在本图内 → 丢弃该边：凭空补一个节点就是编造。
		const a = index.get(e.source);
		const b = index.get(e.target);
		if (a === undefined || b === undefined) return;
		parts.push(`<line x1="${PLOT_X + 20}" y1="${24 + a * 30 + 11}" x2="${W - 20}" y2="${24 + b * 30 + 11}" class="e"/>`);
	});
	nodes.forEach((n, i) => {
		const y = 24 + i * 30;
		parts.push(`<rect class="n" x="${PLOT_X}" y="${y}" width="${PLOT_W}" height="22"/>`);
		parts.push(`<text x="${PLOT_X + 8}" y="${y + 15}" class="t">${esc(n.title)}</text>`);
	});
	parts.push("</svg>");
	return parts.join("");
}

export function buildTableSvg(rows: TableRow[], overlay?: Overlay): string {
	assertOverlay(overlay);
	const items = Array.isArray(overlay?.data) ? alignByKey(overlay.data as OverlayItem[], rows.map((r) => r.id)) : [];
	const rowH = 26;
	const h = 36 + rows.length * rowH;
	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img">`,
		`<style>.t{font:12px sans-serif;fill:#334}.row0{fill:#fafbfc}.sev-error{fill:#fdecea}.sev-warn{fill:#fff6e5}</style>`,
	];
	rows.forEach((r, i) => {
		const y = 26 + i * rowH;
		const sev = overlay?.kind === "severity" ? severityClass(items[i]?.level) : "";
		const cls = sev || (i % 2 ? "" : "row0");
		parts.push(`<rect class="${cls}" x="8" y="${y}" width="${W - 16}" height="${rowH - 2}"/>`);
		parts.push(`<text x="14" y="${y + 16}" class="t">${esc(r.cells.join(" | "))}</text>`);
	});
	parts.push("</svg>");
	return parts.join("");
}

/** 契约失败返回：ok:false +可读 error（+ missing 清单），经 content 让模型读到原因。 */
function fail(error: string, missing?: string[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: false; error: string; missing?: string[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: false, error, ...(missing ? { missing } : {}) }) }],
		details: { ok: false, error, ...(missing ? { missing } : {}) },
	};
}

interface CanvasNode {
	id: string;
	title?: string;
	type?: string;
	/**
	 * 以下字段 `get-canvas-layout` **本来就返回**，过去被本interface 挡在门外
	 * （只声明了 id/title/type）⇒ 关系视图拿不到，颜色/层级/分类全画不出来。
	 * 2026-10-05 补齐：多颜色按 `type`、状态深浅按 `status`、层级按 `parentNode`。
	 */
	status?: string;
	parentNode?: string | null;
	position?: { x?: number; y?: number };
}

export function createRenderCanvasViewTools(deps: {
	fetchLayout: (sessionId: string) => Promise<unknown>;
}): LnkpiTool[] {
	return [
		{
			tier: "present",
			name: "render_canvas_view",
			label: "渲染画布视图卡片",
			// 长度受 spec 硬约束 [80,400]（Task 8 的 lint-tool-descriptions 会拒 >400）：
			// 参数文档写进 Type.*({ description })，description 只留「做什么 + 前提 + 边界」。
			description:
				"Render a read-only SVG card of canvas data. Pick the SHAPE with `view`, the RELATION " +
				"with `relation`, the GROUPING with `groupBy` — independent. Source nodes must already " +
				"exist; missing ones error out instead of inventing rows. Ordered by business sequence, " +
				"not canvas position. Read-only: does NOT edit or create nodes, does NOT trigger " +
				"generation. Unsupported overlays are rejected, not ignored.",
			parameters: Type.Object({
				view: Type.Optional(
					Type.Union(VIEWS.map((v) => Type.Literal(v)), {
						description:
							"Shape only, independent of relation and groupBy: 'layout' (bipartite graph, use with relation=dependency), 'tree' (hierarchy from parentNode), 'timeline' (one-dimensional order), 'swimlane' (stage columns x groupBy rows), 'matrix' (rowBy x colBy cross-tab). 'topology' is the legacy alias of layout+dependency; 'table' is the legacy per-row list. Defaults to layout.",
					}),
				),
				relation: Type.Optional(
					Type.Union(RELATIONS.map((r) => Type.Literal(r)), {
						description:
							"What relation to draw. 'dependency' draws directed arrows (who depends on whom / what breaks if I change this). 'category' draws no dependency edges — use it when the user asks about grouping or ownership, so the picture does not imply causal links. Defaults to dependency.",
					}),
				),
				groupBy: Type.Optional(
					Type.Union(GROUP_BYS.map((g) => Type.Literal(g)), {
						description:
							"Coloring / grouping dimension: 'type' (node type from the canvas), 'status' (node status), 'parentNode' (which group / episode the node belongs to). Affects color, lane and group assignment — NOT the shape. Defaults to type.",
					}),
				),
				scope: Type.Optional(
					Type.Union(SCOPES.map((s) => Type.Literal(s)), {
						description:
							"How much detail to show. 'structure' (DEFAULT) = only the skeleton —prompt-to-prompt edges like 「大纲 → 各集」, i.e. the shape of the whole thing, not its details. Use it when the user asks why it is built this way or what the overall structure is. 'ownership' = skeleton plus which asset belongs to which episode. 'detail' = every edge, for when the user needs exactness. 'detail' on a large canvas overflows the card budget — then pass `focus` to zoom into one part instead of showing everything.",
					}),
				),
				focus: Type.Optional(
					Type.String({
						description:
							"Zoom into one node: draw only its `hops`-deep neighbourhood instead of the whole canvas. This is how you answer a precise question about one episode or one asset without overflowing the card. Must be an existing node id — an unknown id is rejected, never silently ignored.",
					}),
				),
				hops: Type.Optional(
					Type.Integer({
						description: "Neighbourhood depth for `focus` (1-3, default 1). 1 = direct relations, 2 = one level further. Clamped, not rejected.",
					}),
				),
				focus_anchor: Type.Optional(
					Type.Union(FOCUS_ANCHORS.map((a) => Type.Literal(a)), {
						description:
							"How to draw edges leaving the focus node in a local (focus) view. Default 'spread'. "
							+ "'spread' stretches the focus node vertically so each outgoing edge starts at a different y — "
							+ "use it when the user needs to see exactly who connects to what. "
							+ "'bus' keeps the node height and adds a vertical trunk on its right — "
							+ "use it when the user wants the overall 'this node feeds a whole set' impression. "
							+ "'aggregate' collapses more than 8 outgoing edges into one arrow labelled '-> N downstream' — "
							+ "use it when the user only cares how many, not which.",
					}),
				),
				rowBy: Type.Optional(
					Type.Union(GROUP_BYS.map((g) => Type.Literal(g)), {
						description: "matrix only: row dimension. Defaults to type.",
					}),
				),
				colBy: Type.Optional(
					Type.Union(GROUP_BYS.map((g) => Type.Literal(g)), {
						description: "matrix only: column dimension. Defaults to status.",
					}),
				),
				nodes: Type.Optional(
					Type.Array(
						Type.Object({
							node_id: Type.String({ description: "Canvas node id this styling applies to" }),
							color: Type.Optional(
								Type.Union(ALLOWED_COLOR_NAMES.map((c) => Type.Literal(c)), {
									description:
										"Semantic color NAME, not a hex value. Use only to highlight or override a few nodes; omitting it assigns the type color automatically. Hex values are rejected.",
								}),
							),
						}),
						{ description: "Per-node style overrides. Keep it small — the default coloring already covers type and status." },
					),
				),
				overlay: Type.Optional(
					Type.Object({
						kind: Type.Union(OVERLAYS.map((k) => Type.Literal(k)), {
							description:
								"emotion (intensity curve) and budget (flags rows whose dialogue_chars exceed duration_sec x 4.5, Chinese speech at 4-5 chars/sec) are row-level tracks and work only on timeline / table. severity marks which nodes matter and works on every view except matrix (layout / tree / swimlane / timeline / table): pass data[].level=error|warn per node and at most 10% of the nodes get emphasised, highest level first. Unsupported combinations are rejected, not ignored.",
						}),
						data: Type.Union([Type.Array(Type.Unknown()), Type.Object({}, { description: "Empty object: declare there is no row-level data." })], {
							description:
								"Per-row overlay payload: {node_id?, label?, duration_sec?, dialogue_chars?, emotion?, level?}. node_id omitted means positional against the canvas nodes. The canvas layout carries no duration/timing fields, so timeline rows render as equal-width ticks and gain no duration text or budget marking unless these numbers are supplied here.",
						}),
					}),
				),
				node_ids: Type.Optional(Type.Array(Type.String(), { description: "Source node ids; omitted means all canvas nodes" })),
				title: Type.Optional(Type.String({ description: "Card title" })),
				annotations: Type.Optional(
					Type.Array(
						Type.Object({
							node_id: Type.String({ description: "Annotated node id" }),
							text: Type.String({ description: "Annotation text" }),
							severity: Type.Union([Type.Literal("info"), Type.Literal("warn")], {
								description: "info = neutral note; warn = over budget, rendered highlighted",
							}),
						}),
						{ description: "Per-node annotations" },
					),
				),
			}),
			execute: async (
				_id,
				p: {
					view?: ViewKind;
					/** 看什么关系（与 view 正交）。 */
					relation?: RelationKind;
					/** 按什么分组（与 view / relation 正交）。 */
					groupBy?: GroupByKind;
					/** 观察尺度（宏观/中观/微观）。 */
					scope?: ScopeKind;
					/** 拆分局部的中心节点。 */
					focus?: string;
					/** 邻域跳数（夹取 1..3）。 */
					hops?: number;
					/** 局部视图出线策略（对外是 focus_anchor）。 */
					focus_anchor?: (typeof FOCUS_ANCHORS)[number];
					/** matrix 行维度。 */
					rowBy?: GroupByKind;
					/** matrix 列维度。 */
					colBy?: GroupByKind;
					/** 逐节点样式覆盖（`color` 只接受语义色名）。 */
					nodes?: Array<{ node_id: string; color?: string }>;
					overlay?: Overlay;
					node_ids?: string[];
					title?: string;
					annotations?: Array<{ node_id: string; text: string; severity: "info" | "warn" }>;
				},
				_u,
				tc: LnkpiToolContext,
			) => {
				const view: ViewKind = p.view ?? "layout";
				if (!VIEWS.includes(view)) return fail(`view 非法：${String(p.view)}，可选 ${VIEWS.join(" | ")}`);
				const relation: RelationKind = p.relation ?? "dependency";
				if (!RELATIONS.includes(relation)) {
					return fail(`relation 非法：${String(p.relation)}，可选 ${RELATIONS.join(" | ")}`);
				}
				const groupBy: GroupByKind = p.groupBy ?? "type";
				if (!GROUP_BYS.includes(groupBy)) {
					return fail(`groupBy 非法：${String(p.groupBy)}，可选 ${GROUP_BYS.join(" | ")}`);
				}
				const focusAnchor = p.focus_anchor ?? "spread";
				if (!FOCUS_ANCHORS.includes(focusAnchor)) {
					return fail(`focus_anchor 非法：${String(p.focus_anchor)}，可选 ${FOCUS_ANCHORS.join(" | ")}`);
				}
				const scope: ScopeKind = p.scope ?? "structure";
				if (!SCOPES.includes(scope)) {
					return fail(`scope 非法：${String(p.scope)}，可选 ${SCOPES.join(" | ")}`);
				}
				const rowBy: GroupByKind = p.rowBy ?? "type";
				const colBy: GroupByKind = p.colBy ?? "status";
				if (!GROUP_BYS.includes(rowBy) || !GROUP_BYS.includes(colBy)) {
					return fail(`rowBy/colBy 非法，可选 ${GROUP_BYS.join(" | ")}`);
				}
				// ⭐ overlay 分两类，**不再一刀切拒绝**（D3-3 mark 通道）：
				//   · `emotion` / `budget` = **行级时序指标**（要行轨道才画得出）⇒ 图形视图仍是错误；
				//   · `severity` = **节点语义标注**（每节点一个级别）⇒ 图形视图收下，进 `node.mark`。
				//   一刀切拒绝会让「在依赖图上标出出问题的节点」这条路根本不存在。
				if (p.overlay && (view === "topology" || view === "layout" || view === "tree" || view === "swimlane" || view === "matrix")) {
					if (p.overlay.kind !== "severity") {
						return fail(
							`overlay.kind=${String(p.overlay.kind)}（行级指标）not supported on view=${view}（它只用于 timeline / table 的行级轨道）。` +
								`关系表达请改用 view + relation + groupBy —— overlay 不表达逻辑关系。`,
						);
					}
					// ⛔ matrix 画的是格子、没有节点框 ⇒ severity 无处表达。
					//    收下却不画 = 静默忽略叠加，比报错更难查（agent 以为生效了）。
					if (view === "matrix") {
						return fail(
							`overlay.kind=severity 无法在 view=matrix 上表达（matrix 画的是分类交叉的格子，没有节点框可标注）。` +
								`要标出异常节点请改用 layout / tree / swimlane。`,
						);
					}
				}
				// table 只实现了 severity 行底色；收下 emotion/budget 却什么都不画，与 topology
				// 同属「静默忽略叠加」——agent 会以为叠加生效了而图上少一条轨道，比报错更难查。
				if (p.overlay && view === "table" && p.overlay.kind !== "severity") {
					return fail(`overlay.kind=${String(p.overlay.kind)} not supported on view=table（仅支持 severity）`);
				}
				// 节点颜色只接受白名单**色名**，原始色值（#hex / rgb()）一律拒绝 ——
				// 颜色通道由类型自动分配；让模型传任意色值会绕过「一色一义」并引入注入面。
				const colorOverrides: Record<string, string | undefined> = {};
				if (Array.isArray(p.nodes)) {
					for (const n of p.nodes) {
						if (!n || typeof n.node_id !== "string") continue;
						if (n.color === undefined) continue;
						if (!isAllowedColorName(n.color)) {
							return fail(
								`nodes[].color 只接受语义色名（${ALLOWED_COLOR_NAMES.join(" | ")}），收到 ${JSON.stringify(n.color)}。` +
									`不要传十六进制或 rgb()：颜色通道由 node.type 自动分配，语义色名已足够。`,
							);
						}
						colorOverrides[n.node_id] = n.color;
					}
				}
				let items: OverlayItem[] = [];
				if (p.overlay) {
					try {
						assertOverlay(p.overlay);
						items = parseOverlayItems(p.overlay);
					} catch (err) {
						return fail(err instanceof Error ? err.message : String(err));
					}
				}

				const raw = (await deps.fetchLayout(tc.sessionId)) as {
					nodes?: CanvasNode[];
					edges?: Array<{ source: string; target: string }>;
				};
				const allNodes = raw?.nodes ?? [];
				const known = new Set(allNodes.map((n) => n.id));
				const wanted = p.node_ids ?? allNodes.map((n) => n.id);
				const missing = wanted.filter((id) => !known.has(id));
				if (missing.length > 0) return fail(`数据源节点不存在：${missing.join("、")}`, missing);
				const wantedSet = new Set(wanted);
				const nodes = allNodes.filter((n) => wantedSet.has(n.id));
				// focus 必须是已存在的节点 —— 不静默忽略（静默退化成全量图= 答非所问）
				if (p.focus !== undefined && !known.has(p.focus)) {
					return fail(`focus 节点不存在：${p.focus}（不静默退化为全量图 —— 请给一个真实的 node id）`);
				}
				if (nodes.length === 0) {
					return fail("数据源为空：画布上没有可渲染的节点（不编造行）");
				}

				/**
				 * 行级指标与画布节点的对齐规则见 {@link alignByKey}：与两个 build* 函数共用同一实现，
				 * 保证「行内指标」与「行底色级别」落在同一行上。
				 */
				const aligned = alignByKey(items, nodes.map((n) => n.id));

				/**
				 * `overlay.kind=severity` → `node.mark`（D3-3 mark 通道的输入端）。
				 *
				 * ⭐ 对齐规则与 timeline / table **共用** `alignByKey`：带 `node_id` 按 id 命中，
				 *   不带的按数组顺序填入未被命中的行 —— 换成另一套规则会把级别贴到错的节点上
				 *   （既是静默错配，也是在图上编造不存在的严重度）。
				 * ⭐ level 归一为数值：`visualRoles` 要按它降序取前 10%。
				 *   `error`=2 / `warn`=1 / 其它=0（0 不算标注，与行级渲染「非 error/warn 不配色」一致）。
				 */
				const severityMarks: Record<string, NodeMark | undefined> = {};
				if (p.overlay?.kind === "severity") {
					nodes.forEach((n, i) => {
						const level = aligned[i]?.level;
						if (level !== "error" && level !== "warn") return;
						severityMarks[n.id] = { kind: "severity", level: level === "error" ? 2 : 1, text: level };
					});
				}
				const hasMarks = Object.keys(severityMarks).length > 0;

				// 关系视图需要**完整节点字段**（type/status/parentNode/position）——
				// 这正是过去被丢弃、导致「多颜色 / 层级 / 分类」画不出来的那部分。
				const gvNodes: GvNode[] = nodes.map((n) => ({
					id: n.id,
					...(n.type !== undefined ? { type: String(n.type) } : {}),
					...(n.title !== undefined ? { title: String(n.title) } : {}),
					...(n.status !== undefined ? { status: String(n.status) } : {}),
					...(n.parentNode !== undefined && n.parentNode !== null ? { parentNode: String(n.parentNode) } : {}),
					position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
				}));
				const gvEdges = (raw?.edges ?? []).filter((e) => wantedSet.has(e.source) && wantedSet.has(e.target));

				// `topology` 是 `layout` 的旧名：等价于 layout + relation=dependency。
				// `table` 与 `timeline` 走既有行级渲染（overlay 轨道只在这两个上有效）。
				const effView: ViewKind = view === "topology" ? "layout" : view;
				const svg = isLegacyView(view) && view === "table"
					? buildTableSvg(
							nodes.map((n) => ({ id: n.id, cells: [n.id, n.title || ""] })),
							p.overlay,
						)
					: effView === "timeline"
						? buildTimelineSvg(
								nodes.map((n, i) => {
									const it = aligned[i];
									return {
										shotId: n.id,
										label: it?.label ?? n.title ?? n.id,
										...(it?.duration_sec !== undefined ? { durationSec: it.duration_sec } : {}),
										...(it?.dialogue_chars !== undefined ? { dialogueChars: it.dialogue_chars } : {}),
										...(it?.emotion !== undefined ? { emotion: it.emotion } : {}),
									};
								}),
								p.overlay,
							)
						: effView === "tree"
							? buildTreeSvg(gvNodes, gvEdges, hasMarks ? { marks: severityMarks } : {})
							: effView === "swimlane"
								? buildSwimlaneSvg(gvNodes, gvEdges, groupBy === "parentNode" ? "status" : groupBy, hasMarks ? { marks: severityMarks } : {})
								: effView === "matrix"
									? buildMatrixSvg(gvNodes, rowBy, colBy)
									: buildLayoutSvg(gvNodes, gvEdges, {
											drawEdges: relation === "dependency",
											colors: colorOverrides,
											groupBy,
											scope,
											...(hasMarks ? { marks: severityMarks } : {}),
											...(p.focus !== undefined
											? { focus: p.focus, hops: p.hops, focusAnchor }
											: {}),
										});
				// ⛔ 超界**显式报错**，而不是产出注定被丢的图。
				// 线上 `present-result` 超 20000B 会整块丢弃（svg:""+ truncated:true），
				// 前端只显示 <pre> 占位 ⇒ 用户看到「agent 说画了但没卡片」，极难排查。
				// 这里提前拦住并给出可执行的补救（收窄到哪些节点）。
				const budget = svgBudgetReport(svg);
				if (budget.over) {
					// ⭐ 补救建议必须**指向真能解决问题的参数**（#186 的教训：给错参数= 把人送去更糟的结果）
					//   · 已用 focus 但局部仍太大 ⇒ 降 hops 或换出度更小的中心
					//   · 未用 focus 且是 layout/topology ⇒ 先劝宏观/中观（用户多半只想看原理），
					//     再劝 focus 拆局部，最后才 node_ids
					//   · 其它 view ⇒ node_ids / matrix
					const suggested = suggestNodeIds(gvNodes, MAX_NODES_PER_VIEW, gvEdges);
					const head =
						`画布规模超出单张卡片上限：${nodes.length} 个节点会产出约 ${budget.bytes} 字节，` +
						`超过 ${SVG_MAX_CHARS} 字节上限（超出会被整块丢弃，用户看不到图）。`;
					// ⚠️ 建议必须**对当前 view 可行**。
					// `scope` / `focus` 只作用于 layout/topology（依赖图）；
					// 给 swimlane/tree/timeline 建议「改用 scope」是**指一条不存在的路**
					// （2026-10-05 截图评审发现：泳道超预算时仍推 scope，用户照做无效）。
					// 注：旧名 topology 在上面已归一为 layout（:590），故只需判 layout。
					const SCOPE_AWARE = effView === "layout";
					const canFocus = SCOPE_AWARE;
					const focusLine = canFocus
						? `要精确到某一集/某张图，用 focus=<该节点 id> 拆局部（配 hops=2 看两跳）。`
						: `（${effView} 视图不支持 focus 拆局部，只能用 node_ids 收窄。）`;
					const scopeLine = SCOPE_AWARE
						? `请改用 scope 收窄观察尺度：scope=structure 只画骨架（讲原理）、` +
							`scope=ownership 加归属（看素材属于哪一集）、scope=detail 才是全量。`
						: "";
					const idsLine =
						`请用 node_ids 收窄 —— 建议取这 ${suggested.length} 个（保留层级骨架与业务序）：` +
						`${suggested.slice(0, 6).join("、")}${suggested.length > 6 ? " …" : ""}。`;
					const advice =
						p.focus !== undefined
							? `当前已聚焦「${p.focus}」（hops=${p.hops ?? 1}），请把 hops 调小，` +
								`或换一个出度更小的中心节点（如某张分镜脚本）。`
							: [
									scopeLine,
									focusLine,
									`若都不需要，改用 view=matrix（交叉表，体积与节点数无关）。`,
									// scope/focus 都不可用时，node_ids 是唯一出路，必须明确给出
									canFocus ? "" : idsLine,
								]
									.filter(Boolean)
									.join("");
					return fail(`${head}${advice}`);
				}
				// 🔀 双写（2026-10-07）：同时产出 `node_graph`（结构化、给 Vue Flow）
				//   与 `svg_card`（旧路径）。前端未接 node_graph 时它会被忽略（无害），
				//   ⇒ 后端可先上线，前端后接。等前端灰度验证通过再删SVG 那条路。
				//   ⚠️ nodeGraph 用**全部**画布节点（raw.nodes），不是 p.node_ids 过滤后的子集——
				//   节点图的语义是"看看画布上有什么"，按需筛选是SVG 卡片的事。
				return presentResultDual(
					{
						type: "svg_card",
						svg,
					...(p.title ? { title: p.title } : {}),
					...(p.annotations
						? {
								annotations: p.annotations.map((a) => ({
									nodeId: a.node_id,
									text: a.text,
									severity: a.severity,
								})),
							}
						: {}),
					},
					buildNodeGraphPayload(raw, p.title),
				);
			},
		},
	];
}
