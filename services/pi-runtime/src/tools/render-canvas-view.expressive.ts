/**
 * 表达能力层：三维正交（view × relation × groupBy）+ 业务逻辑排序 + 语义色。
 *
 * ## 为什么单独成文件
 *
 * `render-canvas-view.ts` 原本只服务一个 view（topology），颜色写死、无箭头、
 * 无分组、排序照抄画布 y 坐标。这份实现是**视图无关的表达层**：
 * 五个 view 共用同一套节点模型、同一套配色、同一套排序、同一套图例，
 * 避免每个 view 各写一份配色/排序导致语义漂移。
 *
 * ## 排序契约（产品决策：业务逻辑优先，数字字母次之）
 *
 * 真实案例（森林侦探社）：画布 y 坐标把 `EP05` 放在 `EP04` 前面，
 * 照抄 y 会让卡片读起来像剧情顺序错了。但**按id 重排又会撒谎**——
 * 卡片是画布的投影，不是画布的副本。
 *
 * 判据优先级：
 *   1. **业务序号**（EP04 / 第4 集 / 第四集 / Episode 4）—— 这是业务逻辑顺序
 *   2. 画布 `position.y` —— 无业务语义时按画布位置
 *   3. 画布 `position.x`
 *   4. 原数组下标（稳定）
 *
 * ⚠️ 业务序号**必须**按数值比较，不能按字符串：`EP10 < EP05` 在字符串序下成立，
 * 但业务上 EP10 是第十集、排在 EP05 之后。
 */

/** 画布节点的最小模型（只取表达层需要的字段；`get-canvas-layout` 提供全部）。 */
export interface GvNode {
	id: string;
	type?: string;
	title?: string;
	status?: string;
	parentNode?: string;
	position?: { x?: number; y?: number };
}

export interface GvEdge {
	source: string;
	target: string;
}

// ══════════════════════════════════════════════════════════
// 语义色（白名单，模型只能引用不能自定义色值）
// ══════════════════════════════════════════════════════════

export interface Palette {
	fill: string;
	stroke: string;
	/** 状态色（按 status 取深浅档）。 */
	strong?: string;
}

/**
 * 节点类型 → 配色。
 *
 * 选择依据：**色相承载"类型"这一个维度**，状态用同色相的深浅档表达
 * （见 `statusShade`）——两个维度抢同一个颜色通道会互相干扰，用户读不出来。
 */
export const NODE_PALETTE: Record<string, Palette> = {
	prompt: { fill: "#EEEDFE", stroke: "#7F77DD", strong: "#AFA9EC" },
	image: { fill: "#E1F5EE", stroke: "#1D9E75", strong: "#5DCAA5" },
	video: { fill: "#FCEBEB", stroke: "#E24B4A", strong: "#F09595" },
	audio: { fill: "#FAEEDA", stroke: "#BA7517", strong: "#EF9F27" },
	doc: { fill: "#E6F1FB", stroke: "#378ADD", strong: "#85B7EB" },
	group: { fill: "#F1EFE8", stroke: "#888780", strong: "#B4B2A9" },
	default: { fill: "#F1EFE8", stroke: "#888780", strong: "#D3D1C7" },
};

/** `nodes[].color` 允许的**语义色名**（不是色值）。注入原始色值一律拒绝。 */
export const ALLOWED_COLOR_NAMES = [
	"purple","blue","teal","green","amber","coral","red","pink","gray","default",
] as const;
export type ColorName = (typeof ALLOWED_COLOR_NAMES)[number];

/** 语义色名 → 调色板 key。用于 `nodes[].color` 的白名单校验。 */
const COLOR_NAME_TO_PALETTE: Record<ColorName, string> = {
	purple: "prompt",
	blue: "doc",
	teal: "image",
	green: "image",
	amber: "audio",
	coral: "video",
	red: "video",
	pink: "prompt",
	gray: "default",
	default: "default",
};

export function isAllowedColorName(v: unknown): v is ColorName {
	return typeof v === "string" && (ALLOWED_COLOR_NAMES as readonly string[]).includes(v);
}

export function paletteOf(node: GvNode, override?: string): Palette {
	if (override && isAllowedColorName(override)) {
		return NODE_PALETTE[COLOR_NAME_TO_PALETTE[override]] ?? NODE_PALETTE.default;
	}
	return NODE_PALETTE[node.type ?? ""] ?? NODE_PALETTE.default;
}

/**
 * 状态 → 同色相的深浅档。
 *
 * 状态**不改色相**（那是类型的通道），只改深浅与描边，
 * 这样"类型 + 状态"两维能同时读出来。
 */
export function statusShade(node: GvNode, palette: Palette): { fill: string; stroke: string; bold: boolean } {
	const s = (node.status ?? "").toLowerCase();
	if (s === "completed" || s === "done" || s === "delivered") {
		return { fill: palette.strong ?? palette.fill, stroke: palette.stroke, bold: true };
	}
	if (s === "failed" || s === "error" || s === "blocked") {
		return { fill: "#FCEBEB", stroke: "#A32D2D", bold: true };
	}
	if (s === "draft" || s === "pending" || s === "review") {
		return { fill: palette.fill, stroke: palette.stroke, bold: false };
	}
	return { fill: palette.fill, stroke: palette.stroke, bold: false };
}

// ══════════════════════════════════════════════════════════
// 业务逻辑排序
// ══════════════════════════════════════════════════════════

/** 中文数字 → 阿拉伯（支持 一~十 / 两 / 十一~十九 / 廿卅 的常见用法）。 */
const CN_DIGITS: Record<string, number> = {
	零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 貳: 2, 贰: 2, 三: 3, 叁: 3, 參: 3,
	四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cnToNumber(s: string): number | undefined {
	if (!s) return undefined;
	// 纯中文数字串（十/十一/二十/廿）
	if (/^[零〇一壹二两貳贰三叁參四五六七八九十廿卅]+$/.test(s)) {
		if (s === "十") return 10;
		if (s === "廿") return 20;
		if (s === "卅") return 30;
		const m = /^十([一二三四五六七八九])$/.exec(s);
		if (m) return 10 + CN_DIGITS[m[1]];
		const m2 = /^([二三])十([一二三四五六七八九])?$/.exec(s);
		if (m2) return CN_DIGITS[m2[1]] * 10 + (m2[2] ? CN_DIGITS[m2[2]] : 0);
		if (s.length === 1) return CN_DIGITS[s];
		// 多字组合逐位相加（罕见，兜底）
		let total = 0;
		for (const ch of s) {
			const d = CN_DIGITS[ch];
			if (d === undefined) return undefined;
			total += d;
		}
		return total || undefined;
	}
	// 阿拉伯数字（含全角）
	const digits = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
	return /^\d+$/.test(digits) ? Number(digits) : undefined;
}

/**
 * 从标题里抽业务序号。
 *
 * 覆盖 `EP04` / `EP 4` / `第4 集` / `第四集` / `第 12 期` / `Episode 3` / `Scene 5` 等。
 * ⚠️ 只有**首部**的序号算业务序；标题中间的 "EP"（如「EP01 的三视图」）不算，
 * 那是描述而非编号。
 */
export function businessOrder(title: string | undefined): number | undefined {
	if (!title) return undefined;
	const head = title.slice(0, 24);
	const m =
		/^\s*(?:EP|Ep|ep)\s*(\d+)/.exec(head) ??
		/^\s*第\s*([0-9０-９]+)\s*[集期話话章節节回]/.exec(head) ??
		/^\s*第\s*([零〇一壹二两貳贰三叁參四五六七八九十廿卅]+)\s*[集期話话章節节回]/.exec(head) ??
		/^\s*(?:Episode|Ep\.?|Scene|Chapter)\s*(\d+)/i.exec(head) ??
		// ⚠️ 裸中文数字开头（「一集」「三章」）—— 上一条要求「第」字，但真实标题常省略。
		// 约束：必须整段都是中文数字（避免把「三视图」里的「三」误当序号⇒ 后接量词）。
		/^\s*([零〇一壹二两貳贰三叁參四五六七八九十廿卅]+)\s*[集期話话章節节回]/.exec(head);
	if (!m) return undefined;
	return cnToNumber(m[1]);
}

/**
 * 业务逻辑优先的节点排序。
 *
 * 有业务序号 → 按序号升序（**数值比较**，`EP10` 排在 `EP05` 之后）；
 * 序号相同或皆无 → 画布 `y`，再 `x`，最后原下标（保证稳定）。
 */
export function orderNodes<T extends GvNode>(nodes: readonly T[]): T[] {
	return nodes
		.map((n, i) => ({ n, i, ord: businessOrder(n.title) }))
		.sort((a, b) => {
			if (a.ord !== undefined && b.ord !== undefined && a.ord !== b.ord) return a.ord - b.ord;
			if (a.ord !== undefined && b.ord === undefined) return -1; // 有序的在前
			if (a.ord === undefined && b.ord !== undefined) return 1;
			const ay = a.n.position?.y ?? 0;
			const by = b.n.position?.y ?? 0;
			if (ay !== by) return ay - by;
			const ax = a.n.position?.x ?? 0;
			const bx = b.n.position?.x ?? 0;
			if (ax !== bx) return ax - bx;
			return a.i - b.i;
		})
		.map((x) => x.n);
}

/** `orderNodes` 的原地包装（返回值仍是新数组）。 */
export function sortNodes<T extends GvNode>(nodes: T[]): T[] {
	return orderNodes(nodes);
}

// ══════════════════════════════════════════════════════════
// 公共工具
// ══════════════════════════════════════════════════════════

export function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const W = 720;

/**
 * 由 `cssColorClassMap` 生成配色 class 的 CSS 规则。
 *
 * 与 `views.ts` 的 `colorClass()` 配对：那边登记「颜色⇒短类名」，这边输出规则。
 * 顺序由 Map 插入序决定 ⇒ 同一输入必得同一输出（可测试）。
 */
export function buildCssRules(): string {
	const rules: string[] = [];
	for (const [color, cls] of cssColorClassMap()) {
		rules.push(`.cf${cls}{fill:${color}}`);
	}
	// 第二遍写 stroke：stroke 颜色与 fill 可能不同（status 失败时是 #A32D2D）
	for (const [color, cls] of cssColorClassMap()) {
		rules.push(`.cs${cls}{stroke:${color}}`);
	}
	return rules.join("");
}

/** 由 views 层注入（避免循环依赖：views 依赖 expressive，这里只消费它给的 Map）。 */
let classMapProvider: (() => Map<string, string>) | null = null;
export function registerColorClassMap(fn: () => Map<string, string>): void {
	classMapProvider = fn;
}
function cssColorClassMap(): Map<string, string> {
	return classMapProvider ? classMapProvider() : new Map();
}

/** 箭头 marker + 图例的公共前缀。marker id 固定，全图唯一。 */
export function svgHeader(height: number, extraCss = ""): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img">` +
		`<defs><marker id="gv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
		`<path d="M2 1L8 5L2 9" fill="none" stroke="#888780" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
		`</marker><marker id="gv-arrow-hi" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
		`<path d="M2 1L8 5L2 9" fill="none" stroke="#534AB7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
		`</marker></defs>` +
		`<style>${buildCssRules()}</style>` +
		// ⚠️ `dominant-baseline` 写进 class 而不是每个 <text> 重复 63 次
		// （实测单这一项就占 1764B；SVG 里 class 与内联等价，但 class 只写一次）
		`<style>.gv-t{font:12px sans-serif;fill:#334;dominant-baseline:central}` +
		`.gv-s{font:11px sans-serif;fill:#5F5E5A;dominant-baseline:central}` +
		`.gv-warn{font:11px sans-serif;fill:#A32D2D;dominant-baseline:central}` +
		`.n{stroke-width:1;rx:5}` +
		`.l{font:12px sans-serif;fill:#334;dominant-baseline:central}` +
		`.w{font:11px sans-serif;fill:#A32D2D;dominant-baseline:central;text-anchor:end}` +
		`.gv-e{stroke:#8aa;stroke-width:1.5;fill:none}.gvl{font:11px sans-serif;fill:#888780}</style>` +
		extraCss
	);
}

/**
 * 图例：**颜色含义不能靠猜**。
 *
 * 每个 view 都必须带（测试对此有断言）。只画实际用到的类型，避免图例比图还长。
 */
export function legendSvg(used: Array<{ label: string; palette: Palette }>, x = 8, y = 12): string {
	if (used.length === 0) return "";
	const parts = [`<g data-legend="1" transform="translate(${x},${y})">`];
	used.forEach((u, i) => {
		const ly = i * 16;
		parts.push(`<rect x="0" y="${ly}" width="11" height="11" rx="2" fill="${u.palette.fill}" stroke="${u.palette.stroke}" stroke-width="1"/>`);
		parts.push(`<text x="16" y="${ly + 9}" class="gvl">${esc(u.label)}</text>`);
	});
	parts.push("</g>");
	return parts.join("");
}

/** 收集实际用到的类型（保持出现顺序，避免图例顺序跳动）。 */
export function usedTypes(nodes: readonly GvNode[]): Array<{ label: string; palette: Palette }> {
	const seen: string[] = [];
	for (const n of nodes) {
		const t = n.type ?? "default";
		if (!seen.includes(t)) seen.push(t);
	}
	return seen.map((t) => ({ label: t, palette: NODE_PALETTE[t] ?? NODE_PALETTE.default }));
}

// ══════════════════════════════════════════════════════════
// 带圈序号：表达「这是第几个」
// ══════════════════════════════════════════════════════════

/** ①..⑳ �� ㉑（带圈数字）。超出范围返回 undefined（不编造字符）。 */
const CIRCLED = [
	"①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩",
	"⑪","⑫","⑬","⑭","⑮","⑯","⑰","⑱","⑲","⑳",
	"㉑","㉒","㉓","㉔","㉕","㉖","㉗","㉘","㉙","㉚",
];

/** 第 n 个（1-based）的带圈序号；超出 30 降级为普通数字「31.」而不是编造字符。 */
export function ordinal(n: number): string {
	return CIRCLED[n - 1] ?? `${n}.`;
}

// ══════════════════════════════════════════════════════════
// 顺序校验：画布上摆错的节点要能被指出来
// ══════════════════════════════════════════════════════════

export interface MisplacedNode {
	id: string;
	title: string;
	/** 业务序（1-based，按 `orderNodes`）。 */
	businessIndex: number;
	/** 画布序（1-based，按 `position.y`）。 */
	canvasIndex: number;
}

/**
 * 校验「画布上的摆放顺序」是否与「业务顺序」一致。
 *
 * ## 为什么需要（2026-10-05 用户明确要求）
 *
 * > 必须是实际的业务序，画布上画的可能是 AI 或人工搭建的，是错的，
 * > 需要通过这个来指导 AI 正确地自主搭建工作流。
 *
 * 卡片**按业务序渲染**（纠正错位），但光纠正不够 —— 用户还得知道**画布本身错了**，
 * 否则下次 AI 再按同样的错位搭一遍。⇒ 错位节点要打标记并在卡片上说明。
 *
 * ⚠️ 只在「两侧都存在业务序号」时才有意义：一个都没有（纯无序节点）⇒ 无法判定错位。
 * 部分有（混合）⇒ 只在有业务序号的子集内比较，不牵连无序节点。
 */
export function auditOrder(nodesIn: readonly GvNode[]): {
	misplaced: MisplacedNode[];
	/** 参与比较的节点数（有业务序号的）。 */
	compared: number;
} {
	const withOrd = nodesIn
		.map((n) => ({ n, ord: businessOrder(n.title) }))
		.filter((x) => x.ord !== undefined);
	if (withOrd.length < 2) return { misplaced: [], compared: withOrd.length };

	// 业务序：按 `orderNodes` 的规则（序号 → 画布 y → x → 原序）
	const business = orderNodes(withOrd.map((x) => x.n));
	// 画布序：只按画布位置（这才是「用户摆成什么样」）
	const byCanvas = [...withOrd]
		.map((x, i) => ({ n: x.n, i }))
		.sort(
			(a, b) =>
				(a.n.position?.y ?? 0) - (b.n.position?.y ?? 0) ||
				(a.n.position?.x ?? 0) - (b.n.position?.x ?? 0) ||
				a.i - b.i,
		)
		.map((x) => x.n);

	const businessIndex = new Map(business.map((n, i) => [n.id, i + 1]));
	const canvasIndex = new Map(byCanvas.map((n, i) => [n.id, i + 1]));
	const misplaced: MisplacedNode[] = [];
	for (const n of byCanvas) {
		const b = businessIndex.get(n.id)!;
		const c = canvasIndex.get(n.id)!;
		if (b !== c) {
			misplaced.push({ id: n.id, title: n.title ?? n.id, businessIndex: b, canvasIndex: c });
		}
	}
	return { misplaced, compared: withOrd.length };
}

/** 取一组节点的「共同群组后缀」（`标题· 群组` 里的群组），出现 ≥2 次才算「重复」。 */
export function commonSuffixes(nodesIn: readonly GvNode[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const n of nodesIn) {
		const parts = String(n.title ?? "").split("·");
		if (parts.length < 2) continue;
		const suf = parts.slice(1).join("·").trim();
		if (suf) counts.set(suf, (counts.get(suf) ?? 0) + 1);
	}
	const out = new Map<string, string>();
	for (const [suf, c] of counts) if (c >= 2) out.set(suf, String(c));
	return out;
}

/** 剥掉重复的群组后缀：把 6 个「…· 森林偵探社」压成6 个「…」+ 图例里 1 行群组名。 */
export function shortLabels(nodesIn: readonly GvNode[]): Array<{ n: GvNode; label: string }> {
	const common = commonSuffixes(nodesIn);
	return nodesIn.map((n) => {
		const full = String(n.title ?? n.id);
		if (common.size === 0) return { n, label: full };
		const parts = full.split("·");
		if (parts.length < 2) return { n, label: full };
		const head = parts[0].trim();
		const tail = parts.slice(1).join("·").trim();
		return { n, label: common.has(tail) ? head || full : full };
	});
}

// ══════════════════════════════════════════════════════════
// 尺寸预算（2026-10-05 生产复测发现的 P0）
// ══════════════════════════════════════════════════════════

/**
 * SVG 字符数上界，**必须与 `present-result.ts` 的 `SVG_MAX_CHARS` 一致**。
 *
 * 线上现状：超界 ⇒ `svg: ""` + `details.truncated = true`，前端降级成 `<pre>` 占位。
 * ⛔ 不是「截断显示」而是**整块丢弃** —— 用户看到的是「agent 说画了但没卡片」。
 *
 * 生产复测（63 节点 / 123 边真实画布）实测：
 *   layout+dependency  ❌ 超界被丢
 *   tree               ❌ 超界被丢
 *   swimlane           ❌ 超界被丢
 *   layout+category    �� 19784B（不画边才勉强过）
 *   timeline           ✅ 7154B
 *   matrix             ✅ 3744B
 *
 * ⇒ 关系类视图在真实规模下**必然超界**。两条修法（都要）：
 *   1. **瘦 SVG**（省体积）：共用 style 类、去掉每行重复的 `class="n"`、缩短属性
 *   2. **超限显式报错**（不静默丢）：告诉调用方「请用 node_ids 收窄」，并给出建议节点数
 */
export const SVG_MAX_CHARS = 20000;

/** 单个视图能安全渲染的节点数上限（按瘦身后的实测字节反推，取保守值）。 */
export const MAX_NODES_PER_VIEW = 80;

/**
 * 建议的收窄节点数：从超大画布里挑「最能代表关系」的一批。
 *
 * ## 取样规则（三段，顺序即优先级）
 *
 * 1. **层级根**（`parentNode ?? 出边> 0`）—— 关系的骨架，丢了图就退化成孤岛列表
 * 2. **有业务序号的节点**（EP04在 EP05 前）—— 业务逻辑顺序
 * 3. **其余**按画布位置 —— 兜底
 *
 * ## ⚠️ 为什么必须认「出边」而不是只看 `parentNode`
 *
 * 生产画布 `cmuptk4wz001bkz01gca02mv8` 实测 **63 个节点里 `parentNode` 全为空**，
 * 层级完全靠 `edges` 的入边表达（大纲 → 6 个 EP → 各集素材）。
 * 只看 `parentNode` 的版本在这些画布上**一个根都认不出** ⇒ 收窄后边从123 掉到 25，
 * 图变成「一堆没有连线的框」—— 比不收窄更糟。
 *
 * `buildTreeSvg` 早就用「显式 parentNode 优先，否则用入边推断」，
 * 这里必须**同一套判据**，否则「建议的 node_ids」与「渲染出的层级」会不一致。
 */
export function suggestNodeIds(
	nodesIn: readonly GvNode[],
	limit = MAX_NODES_PER_VIEW,
	edgesIn: readonly GvEdge[] = [],
): string[] {
	const hasOut = new Set<string>();
	for (const e of edgesIn) hasOut.add(e.source);
	const known = new Set(nodesIn.map((n) => n.id));
	const isRoot = (n: GvNode) =>
		Boolean(n.parentNode && known.has(n.parentNode)) === false && hasOut.has(n.id);

	const withOrd = nodesIn.filter((n) => businessOrder(n.title) !== undefined);
	const without = nodesIn.filter((n) => businessOrder(n.title) === undefined);
	const ordered = [...orderNodes(withOrd), ...orderNodes(without)];

	const roots = ordered.filter(isRoot);
	const rest = ordered.filter((n) => !isRoot(n));
	return [...roots, ...rest].slice(0, Math.max(0, limit)).map((n) => n.id);
}

/** 体积诊断：供测试与错误信息复用，避免各处重算。 */
export function svgBudgetReport(svg: string): {
	bytes: number;
	ratio: number;
	over: boolean;
} {
	const bytes = svg.length;
	return { bytes, ratio: bytes / SVG_MAX_CHARS, over: bytes > SVG_MAX_CHARS };
}
