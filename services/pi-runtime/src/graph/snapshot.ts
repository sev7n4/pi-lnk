import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRenderCanvasViewTools } from "../tools/render-canvas-view.js";
import type { GvEdge, GvNode } from "../tools/render-canvas-view.expressive.js";

/**
 * `render_canvas_view` 的黄金快照。
 *
 * ⛔ 存在的理由：D2 的验收判据是「对外输出逐字节不变」，但仓库里**没有任何快照设施**
 * （既有测试全是 `assert.match` 片段匹配）。没有迁移前采下来的基线，这条判据无法证明 ——
 * 只能凭感觉说「应该没变」。所以本文件必须在任何搬迁动作**之前**生成基线。
 */

export interface GoldenCase {
	/** 稳定标识：改了它就必须重新生成基线并在提交信息里说明理由。 */
	name: string;
	params: Record<string, unknown>;
	layout: { nodes: GvNode[]; edges: GvEdge[] };
	svg: string;
}

export interface GoldenFile {
	/** 生成时的 HEAD，便于 reviewer 知道基线来自哪个提交。 */
	commit: string;
	cases: GoldenCase[];
}

/** 3 节点基线：layout / topology / timeline / table 共用。 */
export const BASE3: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{ id: "n1", type: "prompt", title: "镜头 1", position: { x: 0, y: 0 } },
		{ id: "n2", type: "prompt", title: "镜头 2", position: { x: 100, y: 0 } },
		{ id: "n3", type: "prompt", title: "镜头 3", position: { x: 200, y: 0 } },
	],
	edges: [{ source: "n1", target: "n2" }],
};

/** 5 节点树：含真实父子关系（tree / swimlane 用）。 */
export const TREE5: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{ id: "n1", type: "outline", title: "大纲", position: { x: 0, y: 0 } },
		{ id: "n2", type: "ep", title: "EP01", parentNode: "n1", position: { x: 0, y: 100 } },
		{ id: "n3", type: "ep", title: "EP02", parentNode: "n1", position: { x: 0, y: 200 } },
		{ id: "n4", type: "ep", title: "EP03", parentNode: "n2", position: { x: 0, y: 300 } },
		{ id: "n5", type: "ep", title: "EP04", parentNode: "n2", position: { x: 0, y: 400 } },
	],
	edges: [
		{ source: "n1", target: "n2" },
		{ source: "n1", target: "n3" },
		{ source: "n2", target: "n4" },
		{ source: "n2", target: "n5" },
	],
};

/** 6 节点混合：两个维度都 ≥2 个取值（matrix 的 rowBy/colBy 需要）。 */
export const MIXED6: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{ id: "m1", type: "a", status: "todo", title: "甲", position: { x: 0, y: 0 } },
		{ id: "m2", type: "a", status: "done", title: "乙", position: { x: 100, y: 0 } },
		{ id: "m3", type: "b", status: "todo", title: "丙", position: { x: 200, y: 0 } },
		{ id: "m4", type: "b", status: "done", title: "丁", position: { x: 300, y: 0 } },
		{ id: "m5", type: "c", status: "todo", title: "戊", position: { x: 400, y: 0 } },
		{ id: "m6", type: "c", status: "done", title: "己", position: { x: 500, y: 0 } },
	],
	edges: [{ source: "m1", target: "m3" }],
};

/**
 * 长标题 fixture —— **专门覆盖 D3-2 的提炼路径**。
 *
 * ⭐ 为什么必须有它：原有 8 个 fixture 的标题全是短中文（`镜头 1` / `EP01` / `甲`），
 *全在各自视图的预算内 ⇒ 提炼是 no-op，快照**逐字节不变**。
 * 也就是说：快照全绿**证明不了提炼是否正确**，这里必须有一个真会触发的样本。
 *
 * 三个标题分别超出所在视图的预算：layout(45 汉字) / tree(11 汉字) / swimlane(8 汉字)。
 * 外加一个**中英混排**样本 —— 迁移前的 `clip()` 按字符数截，算不准混排的像素宽。
 *
 * ⭐⭐ 全部节点都带 `· 雨夜编` 这个**共有后缀** —— 这让 `shortLabels` 真的会剥。
 *   我第一版 fixture 没有共有后缀，于是变异「跳过 shortLabels」**测不出来**：
 *   没有后缀可剥，两条路径输出一模一样。⇒ 判据要覆盖「先剥后缀、再提炼」的**顺序**。
 *   L4 剥完剩 9 汉字（18 单位 ≤ 22）⇒ 顺序反了会被先提炼砍到 14 汉字，标签就变了。
 */
export const LONG_TITLES: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{
			id: "L1",
			type: "prompt",
			// 69 汉字 = 138 单位 > layout 预算 90
			title: "第一章少年在雨夜的老宅里发现祖父留下的那本没有署名的黑色笔记本里面夹着一张褪色的车票 · 雨夜编",
			position: { x: 0, y: 0 },
		},
		{
			id: "L2",
			type: "prompt",
			// 69 汉字，同样超 tree(11) / swimlane(8) 预算
			title: "第二章少女在旧书店的阁楼里翻到那本笔记的残页发现墨迹下面还压着另一层被刮掉的字迹 · 雨夜编",
			position: { x: 100, y: 0 },
		},
		{
			id: "L3",
			type: "image",
			// 中英混排：单位宽与字符数不等价，旧 clip 会算错
			title: "Scene 04A雨夜老宅 · 内景 · 手持笔记本特写 · 缓慢推进 · 无对白 · ENV: rain · 雨夜编",
			position: { x: 200, y: 0 },
		},
		{
			id: "L4",
			type: "prompt",
			// 刚好在 tree 预算内（9 汉字 = 18 单位 ≤ 22）⇒ **不该被提炼**
			title: "第三章收尾与回望",
			position: { x: 300, y: 0 },
		},
	],
	edges: [
		{ source: "L1", target: "L2" },
		{ source: "L2", target: "L3" },
	],
};

export function goldenFixtures(): Array<Omit<GoldenCase, "svg">> {
	return [
		{ name: "layout-dependency", params: { view: "layout", relation: "dependency" }, layout: BASE3 },
		{ name: "layout-category", params: { view: "layout", relation: "category" }, layout: BASE3 },
		{ name: "topology-legacy", params: { view: "topology" }, layout: BASE3 },
		{ name: "tree", params: { view: "tree" }, layout: TREE5 },
		{ name: "timeline", params: { view: "timeline" }, layout: BASE3 },
		{ name: "swimlane-type", params: { view: "swimlane", groupBy: "type" }, layout: TREE5 },
		{ name: "matrix-type-status", params: { view: "matrix", rowBy: "type", colBy: "status" }, layout: MIXED6 },
		// D3-2：提炼路径的快照样本（短标题用例证明不了提炼，见 LONG_TITLES 注释）
		{ name: "layout-long-titles", params: { view: "layout", relation: "dependency" }, layout: LONG_TITLES },
		{ name: "tree-long-titles", params: { view: "tree" }, layout: LONG_TITLES },
		{ name: "swimlane-long-titles", params: { view: "swimlane", groupBy: "type" }, layout: LONG_TITLES },
		{
			name: "table-legacy-overlay",
			// OverlayItem.level 是字符串枚举（"error" / "warn"），不是数字。
			params: { view: "table", overlay: { kind: "severity", data: [{ node_id: "n1", level: "error" }] } },
			layout: BASE3,
		},
	];
}

/** 跑一次工具并取回 SVG；失败时抛出（不静默返回空串）。 */
export async function svgOfCase(
	params: Record<string, unknown>,
	layout: { nodes: GvNode[]; edges: GvEdge[] },
): Promise<string> {
	const tools = createRenderCanvasViewTools({ fetchLayout: async () => layout as never });
	const tool = tools.find((t) => t.name === "render_canvas_view")!;
	const r = await tool.execute("call-1", params as never, () => {}, { sessionId: "s1" }, {} as never, {} as never);
	const d = r.details as { ok: boolean; error?: string; canvasCommands?: Array<{ svg: string }> };
	assertOk(d, params);
	return d.canvasCommands![0].svg;
}

function assertOk(
	d: { ok: boolean; error?: string; canvasCommands?: Array<{ svg: string }> },
	params: Record<string, unknown>,
): void {
	if (!d.ok || !d.canvasCommands?.[0]?.svg) {
		throw new Error(`用例 ${JSON.stringify(params)} 未产出 svg：${d.error ?? "canvasCommands 为空"}`);
	}
}

export async function captureGolden(commit: string): Promise<GoldenFile> {
	const cases: GoldenCase[] = [];
	for (const fx of goldenFixtures()) {
		cases.push({ ...fx, svg: await svgOfCase(fx.params, fx.layout) });
	}
	return { commit, cases };
}

export const GOLDEN_PATH = new URL("./__snapshots__/golden.json", import.meta.url);

export function loadGolden(): GoldenFile {
	return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
}

export function saveGolden(g: GoldenFile): void {
	const p = fileURLToPath(GOLDEN_PATH);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(g, null, 2) + "\n");
}

/**
 * 分层 diff：把「输出变了」拆成「纯视觉变化」与「几何被改了」。
 *
 * ⭐ 为什么逐字节快照不够：重生快照时它只告诉你「变了」，不告诉你**变了什么**。
 *   D2/D3-1 的做法是逐字节不变（纯重构），但 D3-3 是**有意改像素**的
 *   ⇒ 必须有一道判据能证明「视觉可以变、坐标不许变」，否则「改配色顺手挪了节点」
 *   会被快照重生静默盖掉。
 *
 * 判据（按元素粒度，不是按属性袋子）：
 *  ① 剥掉 `<style>` / `<defs>`（前者是 CSS 颜色，后者是箭头 marker）
 *  ② 逐元素抽 (tag, 几何属性, 自身文本)，得有序序列
 *  ③ 旧序列必须是新序列的**子序列** ⇒ 允许纯新增（色条 / 卡片底 / 虚框容器），
 *     但任何原有元素被删或被改都算硬失败。子序列判定天然排除「坐标被挪动」。
 *
 * ⛔ 几何属性刻意**不含 `rx/ry`**（圆角是纯视觉，D3-3 给节点框加了 rx=4）。
 * ⛔ 匹配必须带前导空格边界：`\bwidth\b` 会命中 `stroke-width` 子串。
 */
export interface GoldenDiff {
	name: string;
	/** 逐字节是否相同。 */
	identical: boolean;
	/** 原有元素是否全部保留（保序，允许纯新增）。 */
	geometricIntact: boolean;
	/** 人类可读的差异说明（纯新增统计 / 首个失配位置）。 */
	detail: string;
}

interface SvgElement {
	tag: string;
	geom: string;
	text: string;
	/**
	 * ⭐ 语义角色（归一化用，见 `classifyRole`）。空串 = 普通元素；
	 * `typebar` = 顶部类型色条；`edge` = 连线。
	 */
	role: string;
	/** ⭐ `typebar` 角色的语义条数（一个 path 里的 `M` 子路径数）。 */
	segCount: number;
	/** ⭐ `edge` 角色的去重键（同一批边合并后`d` 唯一）。 */
	dedge: string;
}

/** 剥掉 `<style>`…</style>` 与 `<defs>`…</defs>。 */
function stripNonVisual(svg: string): string {
	return svg.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<defs>[\s\S]*?<\/defs>/g, "");
}

/**
 * 归一化：把「视觉等价但写法不同」的元素标成同一种语义角色。
 *
 * ## 为什么需要（两处 D3-3 字节优化都会撞上这层判据）
 *
 * ① **顶部类型色条**：从「每节点一个 `<rect height="4" class="cfX">`」
 *    改成「每种颜色一个 `<path class="cfX" d="M…h…v4h-…z…">`」
 *    （63 节点 3747B → ~1200B）。这是**元素类型替换**（rect→path）
 *    ⇒ 纯子序列匹配会判「原有元素被删」= 假红。两者视觉语义完全相同。
 * ② **连线**：tree 原来一条边画两个 `<path>`（垂直段 + 带箭头的水平段），
 *    现在合成一个 `M…V…H…`。合并后元素数少 1 ⇒ 同样不是「纯新增」。
 *
 * ⛔ 只有这两类元素清空 geom；节点框 / 容器 / 文本 / 图例的坐标仍逐字段比对
 *   —— 放宽必须精确到「本次确实重写过的那两类」，不能整体降级。
 */
function classifyRole(tag: string, attrs: string): string {
	if (/class="[^"]*\bcf[a-z0-9]+\b[^"]*"/.test(attrs) && (tag === "path" || /\sheight="4"/.test(attrs))) {
		return "typebar";
	}
	if (tag === "path" && /class="[^"]*\b(gv-e|gva|gvh)\b/.test(attrs)) return "edge";
	return "";
}

/** 按元素顺序抽出 (tag, 几何属性, 自身文本, 语义角色)。 */
function svgElements(svg: string): SvgElement[] {
	const out: SvgElement[] = [];
	const re = /<([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>([^<]*)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stripNonVisual(svg))) !== null) {
		const attrs = m[2] ?? "";
		const geom = [...attrs.matchAll(/\s(x|y|x1|y1|x2|y2|width|height|cx|cy|viewBox)="([^"]*)"/g)]
			.map((a) => `${a[1]}=${a[2]}`)
			.join(" ");
		const role = classifyRole(m[1], attrs);
		const d = attrs.match(/\sd="([^"]*)"/)?.[1] ?? "";
		const segCount = role === "typebar" ? d.split("M").filter(Boolean).length : 0;
		out.push({ tag: m[1], geom: role ? "" : geom, text: (m[3] ?? "").trim(), role, segCount, dedge: d });
	}
	return out;
}

/**
 * 元素等价判定。
 *
 * ⭐ 普通元素比 (tag, geom, text) 三项；**被归一化过的元素**（色条 / 连线）
 *   只比角色 —— 它们的写法在 D3-3 字节优化里刻意变了，但视觉与走向不变。
 */
const sameElement = (a: SvgElement, b: SvgElement): boolean =>
	a.tag === b.tag && a.geom === b.geom && a.text === b.text;

/**
 * 配对序列：把**归一化元素**（色条/连线）与**严格元素**分开。
 *
 * ## 为什么必须拆成两个序列（子序列匹配的盲区）
 *
 * 主判据是「旧序列是新序列的**子序列**」，需要保序。但D3-3 字节优化把色条
 * 从「每个 `<g data-node>` 内部」移到了「整图末尾统一输出」
 * ⇒ 色条之后的**所有元素相对顺序都没变**，只是色条本身换了位置。
 * 若把色条留在主序列里比，它一失配就把它后面每一个严格元素都顶掉一位
 * ⇒后面全是假红（D3-3 实测：swimlane/layout-long-titles 的 text 全被误报）。
 *
 * 所以：
 * - **严格元素**（节点框 / 容器 / 文本 / 图例）仍走子序列保序匹配——这是本判据的核心，
 *   「节点被挪位」必须能被抓到。
 * - **归一化元素**只比**角色计数**（色条 N 条、连线 M 条），不比位置与顺序。
 */
function splitByRole(els: SvgElement[]): { strict: SvgElement[]; typebars: number; edges: number } {
	const strict: SvgElement[] = [];
	let typebars = 0;
	const edgeDs = new Set<string>();
	for (const e of els) {
		if (e.role === "typebar") {
			// ⛔ **加权计数**：一个 `<path>` 里拼了 N 个矩形（每色一条 path），
			//   所以色条数 = `d` 里的 `M` 子路径数，**不是 path 元素个数**。
			//   数元素个数会把「聚合成 1 个 path」误判成「丢了 N-1 个色条」。
			typebars += e.segCount || 1;
		} else if (e.role === "edge") {
			// 边按 `d` 去重：同一批边合并成一条折线后 d 唯一。
			// ⛔ 不能按元素个数计 —— tree 原来一条边 2 个 path，合并后 1 个。
			if (e.dedge) edgeDs.add(e.dedge);
		} else {
			strict.push(e);
		}
	}
	return { strict, typebars, edges: edgeDs.size };
}

/**
 * 归一化元素是否「旧 ⊆ 新」。
 *
 * - **色条**：新数量 ≥ 旧数量（纯新增允许，等量即重写）。
 * - **连线**：允许被合并 —— tree 一条边由 2 段 path 合成 1 条折线（2→1），
 *   所以判据是「新 ≥ 旧的一半」。⚠️ 这个宽松是**有代价**的：若有人把两条边
 *   合成一条，本判据不会红。真正的守门员是快照逐字节 + 上面 text/rect 的保序匹配
 *   （边被合并时折线走向不变，端点坐标仍会体现在坐标比对之外的视觉评审里）。
 */
function rolesPreserved(o: { typebars: number; edges: number }, n: { typebars: number; edges: number }): boolean {
	if (n.typebars < o.typebars) return false;
	return n.edges * 2 >= o.edges;
}

/** 逐用例分层 diff。 */
export function diffGolden(oldF: GoldenFile, newF: GoldenFile): GoldenDiff[] {
	const out: GoldenDiff[] = [];
	for (let i = 0; i < Math.max(oldF.cases.length, newF.cases.length); i++) {
		const o = oldF.cases[i];
		const n = newF.cases[i];
		if (!o || !n) {
			out.push({
				name: o?.name ?? n?.name ?? `#${i}`,
				identical: false,
				geometricIntact: false,
				detail: `用例数量不一致：old=${oldF.cases.length} new=${newF.cases.length}`,
			});
			continue;
		}
		if (o.svg === n.svg) {
			out.push({ name: o.name, identical: true, geometricIntact: true, detail: "逐字节不变" });
			continue;
		}
		const oldAll = svgElements(o.svg);
		const newAll = svgElements(n.svg);
		// ⭐ 色条/连线走角色计数（写法在 D3-3 变过、位置也变过），
		//   其余元素仍走子序列保序匹配（节点挪位必须被抓到）。
		const oldSplit = splitByRole(oldAll);
		const newSplit = splitByRole(newAll);
		const oldEls = oldSplit.strict;
		const newEls = newSplit.strict;
		let k = 0;
		for (let j = 0; j < newEls.length && k < oldEls.length; j++) {
			if (sameElement(oldEls[k], newEls[j])) k++;
		}
		const rolesOk = rolesPreserved(oldSplit, newSplit);
		const intact = k === oldEls.length && rolesOk;
		const rectDelta = (n.svg.match(/<rect/g) ?? []).length - (o.svg.match(/<rect/g) ?? []).length;
		const dashDelta = (n.svg.match(/stroke-dasharray/g) ?? []).length - (o.svg.match(/stroke-dasharray/g) ?? []).length;
		const notes: string[] = [`元素 ${oldAll.length}→${newAll.length}`];
		if (rectDelta !== 0) notes.push(`rect ${rectDelta > 0 ? "+" : ""}${rectDelta}（色条/卡片底新增）`);
		if (dashDelta !== 0) notes.push(`dasharray ${dashDelta > 0 ? "+" : ""}${dashDelta}（容器改虚框）`);
		if (!rolesOk) {
			notes.push("⛔ 归一化元素（色条/连线）数量减少");
		}
		if (k !== oldEls.length) {
			notes.push(`⛔ 首个失配：旧元素 ${JSON.stringify(oldEls[k])}`);
		}
		out.push({ name: o.name, identical: false, geometricIntact: intact, detail: notes.join(" | ") });
	}
	return out;
}
