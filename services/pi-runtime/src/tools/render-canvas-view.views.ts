/**
 * 五个关系视图的 SVG 构建器。
 *
 * 全部共享 `render-canvas-view.expressive.ts` 的节点模型 / 配色 / 排序 / 图例，
 * 保证「同一个颜色在任何 view 里是同一个含义」。
 *
 * 视图职责（正交于 relation 与 groupBy）：
 *   layout    — 二分图，关系由 relation 决定画不画
 *   tree      — 层级（parentNode），表达"属于"
 *   timeline  — 一维顺序
 *   swimlane  — 阶段横轴 × 分组纵轴，表达"谁在什么时候做什么"
 *   matrix    — 分类 × 状态交叉，表达"分布"
 */
import {
	type GvEdge,
	type GvNode,
	type Palette,
	auditOrder,
	businessOrder,
	filterEdgesByScope,
	focusNeighborhood,
	nodesInNeighborhood,
	type Scope,
	registerColorClassMap,
	commonSuffixes,
	esc,
	legendSvg,
	orderNodes,
	ordinal,
	paletteOf,
	shortLabels,
	svgOpen,
	svgTail,
	statusShade,
	usedTypes,
	NODE_PALETTE,
} from "./render-canvas-view.expressive.js";

const W = 720;
const ROW_H = 26;
const LABEL_W = 150;
const PLOT_X = LABEL_W;
const PLOT_W = W - PLOT_X - 16;

/** 单个节点的外接框（供连线端点计算）。 */
interface Box {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	row: number;
}

function boxesFrom(
	nodes: readonly GvNode[],
	xOf: (n: GvNode, row: number) => number,
	wOf: (n: GvNode, row: number) => number,
	yOf: (n: GvNode, row: number) => number,
	hOf: (n: GvNode, row: number) => number,
): Map<string, Box> {
	const m = new Map<string, Box>();
	nodes.forEach((n, i) => {
		const row = i;
		m.set(n.id, { id: n.id, x: xOf(n, row), y: yOf(n, row), w: wOf(n, row), h: hOf(n, row), row });
	});
	return m;
}

/** 节点右上角 → 目标左侧的折线路径（同源多条边时起点沿高度分散，修「扫帚」）。 */
function edgePath(from: Box, to: Box, siblingIndex = 0, siblingCount = 1): string {
	const sx = from.x + from.w;
	const sy = from.y + (siblingCount <= 1 ? from.h / 2 : (siblingIndex + 1) * (from.h / (siblingCount + 1)));
	const tx = to.x;
	const ty = to.y + to.h / 2;
	const midX = sx + Math.max(18, (tx - sx) / 2);
	return `M${sx},${Math.round(sy)} C${Math.round(midX)},${Math.round(sy)} ${Math.round(midX)},${Math.round(ty)} ${tx},${Math.round(ty)}`;
}

/**
 * 节点矩形 + 标签。
 *
 * ⭐ 标签构成（2026-10-05 用户要求「非常简洁且能表达清楚这个节点」）：
 *   `{带圈序号} {精简名称} {类型}`
 * - 序号用 ①②③ 表达「业务上的第几个」，**同一标签内**而不是另起一行
 * - 名称剥掉重复群组后缀（6 个「…· 森林偵探社」⇒ 群组名进图例，只出现一次）
 * - 类型默认不显示（颜色 + 图例已表达），`showType` 打开
 * - 错位节点（画布摆放与业务序不一致）描边加宽 + 角标，让「画布本身错了」可见
 */
function nodeRect(
	n: GvNode,
	box: Box,
	opts: {
		color?: string;
		emphasized?: boolean;
		seq?: number;
		label?: string;
		showType?: boolean;
		misplaced?: boolean;
	} = {},
): string {
	const p = paletteOf(n, opts.color);
	const st = statusShade(n, p);
	const mis = opts.misplaced === true;
	// ⭐ 配色走 CSS class（`cf`=fill,`cs`=stroke）而不是每节点内联 fill/stroke ——
	// 内联 63 次约 3.2KB，class 只需 63×13 字节。这是把 layout 从 23.6KB 压进 20KB 的关键。
	const cls = `cf${colorClass(p.fill)} cs${colorClass(st.stroke)}`;
	const parts: string[] = [];
	parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" class="${cls} n"${mis ? ' stroke-width="2"' : ""}/>`);
	const seq = opts.seq && opts.seq > 0 ? `${ordinal(opts.seq)} ` : "";
	const body = opts.label ?? n.title ?? n.id;
	const typeTxt = opts.showType ? ` ${n.type ?? ""}` : "";
	const maxChars = Math.max(4, Math.floor((box.w - 14) / 12));
	parts.push(
		`<text x="${box.x + 6}" y="${box.y + box.h / 2}" class="l">${esc(seq + clip(body, Math.max(2, maxChars - seq.length)) + typeTxt)}</text>`,
	);
	if (mis) {
		parts.push(`<text x="${box.x + box.w - 4}" y="${box.y + box.h / 2}" class="w" text-anchor="end">画布顺序</text>`);
	}
	return parts.join("");
}

/**
 * 颜色 → 短类名后缀。
 *
 * 7 档配色 × 3 档状态 = 有限集合 ⇒ 预生成类名比内联属性省 3KB+。
 * ⚠️ 未登记的颜色会回落到 `o`（默认灰）—— **不静默丢信息**：
 * 调`cssColorClasses()` 可查当前登记了哪些。
 */
const CSS_CLASSES = new Map<string, string>();
function colorClass(color: string): string {
	const hit = CSS_CLASSES.get(color);
	if (hit) return hit;
	const id = CSS_CLASSES.size;
	CSS_CLASSES.set(color, String.fromCharCode(97 + (id % 26)) + Math.floor(id / 26));
	return CSS_CLASSES.get(color)!;
}

/** 导出当前登记的 色⇒ 类名 映射（测试与调试用）。 */
export function cssColorClasses(): Record<string, string> {
	return Object.fromEntries(CSS_CLASSES);
}

// 让 expressive.svgHeader 能输出配色 class 规则（避免反向依赖）
registerColorClassMap(() => CSS_CLASSES);

/** 错位说明行（只在真的有错位时输出 —— 不制造噪音）。 */
function auditNoteSvg(
	misplaced: readonly { title: string; businessIndex: number; canvasIndex: number }[],
	compared: number,
): string {
	if (misplaced.length === 0) return "";
	const names = misplaced
		.slice(0, 4)
		.map((m) => `${clip(m.title, 14)}（应第${m.businessIndex}，画布第${m.canvasIndex}）`)
		.join("；");
	const more = misplaced.length > 4 ? ` 等 ${misplaced.length} 处` : "";
	return (
		`<g data-audit="misplaced"><rect x="8" y="8" width="${W - 16}" height="20" rx="4" fill="#FCEBEB" stroke="#A32D2D" stroke-width="0.5"/>` +
		`<text x="14" y="18" class="gv-warn" dominant-baseline="central">⚠ 有 ${misplaced.length} 个节点在画布上放错位（已按业务序重排）：${esc(names + more)}</text></g>`
	);
}

/** 超长标题截断（SVG 不换行，超宽会溢出 viewBox）。 */
function clip(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

// ══════════════════════════════════════════════════════════
// layout：二分图 + 箭头（依赖关系的默认载体）
// ══════════════════════════════════════════════════════════

export interface LayoutOpts {
	/** 是否画依赖边。`category` 关系下不画 —— 否则与 dependency 混同。 */
	drawEdges: boolean;
	/** 强调这些 id（如关键路径首节点）。 */
	emphasize?: readonly string[];
	colors?: Record<string, string | undefined>;
	/**
	 * 分组依据。影响**着色**（type/status/parentNode）**与行序**（同组相邻），
	 * 不改变「形状」—— 形状只由`view` 决定（正交性要求）。
	 */
	groupBy?: "type" | "status" | "parentNode";
	/** 标签里是否显示节点类型（默认否—— 颜色 + 图例已表达，写出来只是噪音）。 */
	showType?: boolean;
	/**
	 * 观察尺度：宏观（只画骨架）/ 中观（骨架+归属）/ 微观（全量）。
	 * ⚠️ 默认 `structure`（宏观）—— 「依赖」在用户嘴里就排除了「顺序」，
	 * 把image→image 的镜头顺序画成依赖箭头是主动误导。
	 */
	scope?: Scope;
	/** 拆分局部：只画该节点 `hops` 跳邻域（微观数据太多时的出口）。 */
	focus?: string;
	/** 邻域跳数，夹取到 [1,3]。 */
	hops?: number;
}

export function buildLayoutSvg(
	nodesIn: readonly GvNode[],
	edgesIn: readonly GvEdge[],
	opts: LayoutOpts,
): string {
	// ⭐ 先按 scope 裁边，再按 focus 裁节点（顺序不可颠倒：先裁边才知道邻域里有哪些边）
	const scope: Scope = opts.scope ?? "structure";
	const scopedEdges = opts.drawEdges ? filterEdgesByScope(nodesIn, edgesIn, scope) : [];
	let nodes = orderNodes(nodesIn);
	let edges = scopedEdges;
	let focusKeep: Set<string> | undefined;
	if (opts.focus !== undefined) {
		focusKeep = focusNeighborhood(nodes, edges, opts.focus, opts.hops ?? 1);
		nodes = nodesInNeighborhood(nodes, focusKeep);
		edges = edges.filter((e) => focusKeep!.has(e.source) && focusKeep!.has(e.target));
	}
	const groupBy = opts.groupBy ?? "type";
	// ⭐ groupBy 影响**行序**（同组相邻 ⇒ 一眼看出分组边界），
	// 但**先按业务序号排**再稳分组合并 —— 否则同组内的业务顺序会被打乱。
	// nodes/edges 已在函数开头按 scope + focus 处理完毕；这里只做 groupBy 的稳分组合并
	const groupKey = (n: GvNode) =>
		groupBy === "status" ? (n.status ?? "未标状态") : groupBy === "parentNode" ? (n.parentNode ?? "未归类") : (n.type ?? "default");
	if (groupBy !== "type") nodes = groupAdjacent(nodes, groupKey);

	const H = 40 + nodes.length * ROW_H + 24;
	const boxes = boxesFrom(
		nodes,
		() => PLOT_X,
		() => PLOT_W,
		(_, i) => 30 + i * ROW_H,
		() => 20,
	);
	const parts: string[] = [svgOpen(H)];

	if (opts.drawEdges) {
		// ⭐ 同源多出边起点沿源节点高度分散 —— 修「全部从同一点射出」的扫帚
		const bySource = new Map<string, string[]>();
		for (const e of edges) {
			if (!boxes.has(e.source) || !boxes.has(e.target)) continue; // 端点不在图内→丢弃（不编造）
			const arr = bySource.get(e.source) ?? [];
			arr.push(e.target);
			bySource.set(e.source, arr);
		}
		for (const [src, targets] of bySource) {
			const from = boxes.get(src)!;
			const ordered2 = orderNodes(
				targets.map((id) => nodes.find((n) => n.id === id)).filter((x): x is GvNode => Boolean(x)),
			);
			ordered2.forEach((target, i) => {
				const to = boxes.get(target.id)!;
				const isHi = (opts.emphasize ?? []).includes(src) || (opts.emphasize ?? []).includes(target.id);
				parts.push(
					`<path data-edge="1" d="${edgePath(from, to, i, ordered2.length)}" class="gv-e" marker-end="url(#gv-arrow${isHi ? "-hi" : ""})"${isHi ? ' stroke="#534AB7" stroke-width="2"' : ""}/>`,
				);
			});
		}
	}

	const emph = new Set(opts.emphasize ?? []);
	// ⭐ 与 tree 同一套：业务序号 + 精简标签 + 错位标记
	const audit = auditOrder(nodes);
	const misIds = new Set(audit.misplaced.map((m) => m.id));
	const labels = new Map(shortLabels(nodes).map(({ n, label }) => [n.id, label]));
	if (focusKeep) {
		// 局部视图必须自报家门，否则用户会误以为这就是全部
		parts.push(
			`<g data-focus="${esc(opts.focus ?? "")}" data-hops="${Math.max(1, Math.min(3, Math.floor(opts.hops ?? 1)))}">` +
				`<rect x="8" y="8" width="${W - 16}" height="20" rx="4" fill="#E6F1FB" stroke="#378ADD" stroke-width="0.5"/>` +
				`<text x="14" y="18" class="gv-info" dominant-baseline="central">局部视图：只看「${esc(clip(String(opts.focus), 20))}」的 ${Math.max(1, Math.min(3, Math.floor(opts.hops ?? 1)))} 跳邻域（${nodes.length} 个节点 / ${edges.length} 条边）· 用 focus 换节点可看别处</text></g>`,
		);
	}
	const note = auditNoteSvg(audit.misplaced, audit.compared);
	if (note) parts.push(note);
	let lastGroup: string | undefined;
	for (const n of nodes) {
		const g = groupKey(n);
		// 分组间隔线：同组相邻时给一条淡色分隔，groupBy 才有意义
		if (lastGroup !== undefined && g !== lastGroup) {
			const y = 30 + nodes.indexOf(n) * ROW_H - 4;
			parts.push(`<line x1="8" y1="${y}" x2="${W - 16}" y2="${y}" stroke="#D3D1C7" stroke-width="1" stroke-dasharray="2 3"/>`);
		}
		lastGroup = g;
		const mis = misIds.has(n.id);
		parts.push(
			`<g data-node="${esc(n.id)}" data-group="${esc(g)}"` +
				`${mis ? " data-x" : ""}>`,
		);
		parts.push(
			nodeRect(n, boxes.get(n.id)!, {
				color: opts.colors?.[n.id],
				emphasized: emph.has(n.id),
				seq: nodes.indexOf(n) + 1,
				label: labels.get(n.id),
				showType: opts.showType,
				misplaced: mis,
			}),
		);
		if (emph.has(n.id)) {
			parts.push(
				`<text x="${boxes.get(n.id)!.x + boxes.get(n.id)!.w - 6}" y="${boxes.get(n.id)!.y + boxes.get(n.id)!.h / 2}" class="gv-s" text-anchor="end" dominant-baseline="central">关键</text>`,
			);
		}
		parts.push("</g>");
	}
	const lg =
		groupBy === "type"
			? usedTypes(nodes)
			: groupBy === "status"
				? statusLegend(nodes)
				: groupLegend(nodes, groupBy);
	const sufs = [...commonSuffixes(nodes).keys()];
	parts.push(legendSvg(lg, 8, H - 14 - (lg.length + sufs.length) * 16));
	sufs.forEach((suf, i) => {
		parts.push(
			`<g data-group="${esc(suf)}"><rect x="8" y="${H - 14 - sufs.length * 16 + i * 16}" width="11" height="11" rx="2" fill="#F1EFE8" stroke="#888780" stroke-width="1"/>` +
				`<text x="24" y="${H - 14 - sufs.length * 16 + i * 16 + 9}" class="gvl">${esc(clip(suf, 16))}（全部节点共有）</text></g>`,
		);
	});
	// ⭐⭐ **header 必须在这里拼，不能在渲染开头。**
	// 配色 class 走 `colorClass()`，它在**渲染每个节点时**才把「颜色⇒短类名」登记进
	// 模块级 `CSS_CLASSES`；而 `svgHeader()` 内的 `buildCssRules()` 只读那个 Map。
	// ⇒ 若在开头调用，Map 还是空的，`<style>` 里**一条 .cf 规则都没有**，
	//   `rect` 拿不到 fill ⇒ SVG 默认 fill 是黑 ⇒ **整张卡片黑条、文字不可见**。
	//   2026-10-05 截图评审发现；躲过了 14/14 生产复测（当时只查字节数与边数，没查颜色）。
	// ⭐⭐ **svgTail 必须在所有节点渲染完之后**（配色 class 要等colorClass() 登记完）。
	// 详见 expressive.ts 的 svgTail 文档：提前调用 ⇒ `<style>` 无配色规则 ⇒ 节点全黑。
	parts.push(svgTail(H));
	parts.push("</svg>");
	return parts.join("");
}

/** 稳定地把同 key 的节点聚到一起（保持组内原序）。 */
function groupAdjacent<T>(list: readonly T[], keyOf: (n: T) => string): T[] {
	const buckets = new Map<string, T[]>();
	for (const n of list) {
		const k = keyOf(n);
		const arr = buckets.get(k) ?? [];
		arr.push(n);
		buckets.set(k, arr);
	}
	const out: T[] = [];
	for (const arr of buckets.values()) out.push(...arr);
	return out;
}

function statusLegend(nodes: readonly GvNode[]): Array<{ label: string; palette: Palette }> {
	const seen: string[] = [];
	for (const n of nodes) {
		const s = n.status ?? "未标状态";
		if (!seen.includes(s)) seen.push(s);
	}
	return seen.map((label) => ({ label, palette: NODE_PALETTE[label === "未标状态" ? "default" : "group"] }));
}

function groupLegend(nodes: readonly GvNode[], by: "parentNode"): Array<{ label: string; palette: Palette }> {
	const seen: string[] = [];
	for (const n of nodes) {
		const s = String(n[by] ?? "未归类");
		if (!seen.includes(s)) seen.push(s);
	}
	return seen.slice(0, 6).map((label) => ({ label, palette: NODE_PALETTE.group }));
}

// ══════════════════════════════════════════════════════════
// tree：层级 + 归属
// ══════════════════════════════════════════════════════════

const TREE_INDENT = 26;
const TREE_DEPTH_W = 150;

export function buildTreeSvg(nodesIn: readonly GvNode[], edgesIn: readonly GvEdge[]): string {
	const nodes = orderNodes(nodesIn);
	// ⭐ 根节点判定**必须看入边**，不能只看有没有 parentNode：
	// 「大纲 → 6 个 EP」这种结构里，大纲节点既无 parentNode、又是指向 4 个节点的那个，
	// 只看 parentNode 会把它误判成叶子、排到末尾（实测 bug：EP01..EP10 排在它前面）。
	const childOf = new Map<string, Set<string>>();
	const hasIncoming = new Set<string>();
	for (const e of edgesIn) {
		if (e.source === e.target) continue;
		const arr = childOf.get(e.source) ?? new Set<string>();
		arr.add(e.target);
		childOf.set(e.source, arr);
		hasIncoming.add(e.target);
	}
	// 显式 parentNode 优先（用户手动挂的层级比推断可靠）
	const explicitChild = new Map<string, string[]>();
	for (const n of nodes) {
		if (n.parentNode && nodes.some((x) => x.id === n.parentNode)) {
			const arr = explicitChild.get(n.parentNode) ?? [];
			arr.push(n.id);
			explicitChild.set(n.parentNode, arr);
		}
	}

	const childrenOf = new Map<string, GvNode[]>();
	const roots: GvNode[] = [];
	for (const n of nodes) {
		const explicit = explicitChild.get(n.id);
		const inferred = [...(childOf.get(n.id) ?? [])];
		const kids = [...new Set([...(explicit ?? []), ...inferred])]
			.map((id) => nodes.find((x) => x.id === id))
			// ⚠️ 必须先收窄再用 `.id`：`Boolean(x) && x.id !== n.id` 里 TS 不会跨 `&&` 收窄
			// （`x` 仍是 `GvNode | undefined`）⇒ 报 TS18048。
			.filter((x): x is GvNode => x !== undefined)
			.filter((x) => x.id !== n.id);
		if (kids.length > 0) childrenOf.set(n.id, kids);
		// 无子节点 ⇒ 叶子；叶子不是根，除非它也没有 parentNode
		const isLeaf = kids.length === 0;
		const hasExplicitParent = Boolean(n.parentNode && nodes.some((x) => x.id === n.parentNode));
		if (isLeaf && !hasExplicitParent) {
			//叶子但没挂到任何人 ⇒ 顶层（画在根层）
			roots.push(n);
		} else if (!isLeaf) {
			// 有子节点但自己被显式挂到别人下面 ⇒ 走 parentNode 分支，不当根
			if (hasExplicitParent) {
				// 交给显式 parent 的 childrenOf 处理（下一轮循环已建立）
			} else {
				roots.push(n);
			}
		}
	}
	// ⚠️ 子树内**必须按业务序号排**，不能按画布y：同一父节点下
	// 「EP05(y=500) 在 EP04(y=600) 之前」是画布的摆放问题，不是剧情顺序。
	// 根层已在下面单独处理（按画布位置 + 层级根优先）；子树直接用 orderNodes。
	for (const [k, arr] of childrenOf) childrenOf.set(k, orderNodes(arr));

	// 深度优先展开
	const rowsAll: Array<{ n: GvNode; depth: number }> = [];
	const seen = new Set<string>();
	const walk = (list: readonly GvNode[], depth: number) => {
		for (const n of list) {
			if (seen.has(n.id)) continue; // 环保护
			seen.add(n.id);
			rowsAll.push({ n, depth });
			walk(childrenOf.get(n.id) ?? [], depth + 1);
		}
	};
	// ⭐ 根节点排序：**有子节点（层级根）优先**，再按业务序号。
	// `orderNodes` 会把「无业务序号」的排到「有序号」之后 —— 那对平铺列表正确，
	// 但对树是错的：层级根（如「全劇大綱」，标题无编号）会掉到叶子后面，
	// 读起来像它属于最后那集（实测 bug）。
	const rootsOrdered = roots
		.map((n, i) => ({ n, i, hasKids: (childrenOf.get(n.id)?.length ?? 0) > 0 }))
		.sort((a, b) => {
			if (a.hasKids !== b.hasKids) return a.hasKids ? -1 : 1;
			return 0;
		})
		.map((x) => x.n);
	// ⭐ 根层排序三段（每段一个不可妥协的约束，按优先级）：
	//   ① 层级根（有子节点）— 无论有无业务序号，都排在所有叶子之前。
	//      理由：「全劇大綱」标题无编号，若按「有序号在前」会被甩到 EP01..EP06 后面，
	//      读起来像它属于最后一集 —— 这正是第一版实测到的 bug。
	//   ② 有业务序号的叶子 —— 按序号升序（EP04 在EP05 前，即使画布 y 相反）。
	//   ③ 无业务序号的叶子 —— 回落画布位置。
	const hasKids = (n: GvNode) => (childrenOf.get(n.id)?.length ?? 0) > 0;
	const kids = rootsOrdered.filter(hasKids);
	const leavesWithOrd = rootsOrdered.filter(
		(n) => !hasKids(n) && businessOrder(n.title) !== undefined,
	);
	const leavesNoOrd = rootsOrdered.filter((n) => !hasKids(n) && businessOrder(n.title) === undefined);
	const rootsFinal = [
		...kids.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0)),
		...leavesWithOrd.sort((a, b) => (businessOrder(a.title) ?? 0) - (businessOrder(b.title) ?? 0)),
		...leavesNoOrd.sort(
			(a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0),
		),
	];
	walk(rootsFinal, 0);
	const orphans = nodes.filter((n) => !seen.has(n.id));
	const ORPHAN = orphans.length > 0;
	if (ORPHAN) for (const n of orphans) rowsAll.push({ n, depth: 0 });

	const legendRows = usedTypes(nodes);
	// ⭐ 顺序校验 + 标签精简（用户要求：按业务序渲染，并指出画布上放错的）
	const audit = auditOrder(nodes);
	const misIds = new Set(audit.misplaced.map((m) => m.id));
	const labels = new Map(shortLabels(nodes).map(({ n, label }) => [n.id, label]));
	const H = 40 + rowsAll.length * ROW_H + (ORPHAN ? 24 : 0) + 24;
	const parts: string[] = [svgOpen(H)];
	const note = auditNoteSvg(audit.misplaced, audit.compared);
	if (note) {
		parts.push(note);
		// 有说明行时整体下移20px，避免与首行节点重叠
	}
	// 纵线（父子连线）
	for (let i = 0; i < rowsAll.length; i++) {
		const r = rowsAll[i];
		if (r.depth === 0) continue;
		const x = PLOT_X + r.depth * TREE_INDENT - 10;
		parts.push(`<path d="M${x},${30 + (i - 1) * ROW_H + ROW_H / 2} L${x},${30 + i * ROW_H + ROW_H / 2}" class="gv-e"/>`);
		parts.push(`<path d="M${x},${30 + i * ROW_H + ROW_H / 2} L${x + 8},${30 + i * ROW_H + ROW_H / 2}" class="gv-e" marker-end="url(#gv-arrow)"/>`);
	}
	if (ORPHAN) {
		parts.push(
			`<line x1="8" y1="${30 + rowsAll.length * ROW_H + 2}" x2="${W - 16}" y2="${30 + rowsAll.length * ROW_H + 2}" stroke="#D3D1C7" stroke-width="1"/>`,
			`<text x="8" y="${30 + (rowsAll.length + 0.7) * ROW_H}" class="gv-s">未归类（无 parentNode，挂在根下）</text>`,
		);
	}
	for (let i = 0; i < rowsAll.length; i++) {
		const { n, depth } = rowsAll[i];
		const x = PLOT_X + depth * TREE_INDENT;
		const box: Box = { id: n.id, x, y: 30 + i * ROW_H, w: TREE_DEPTH_W, h: 20, row: i };
		const isOrphan = ORPHAN && i >= rowsAll.length - orphans.length;
		const mis = misIds.has(n.id);
		parts.push(
			`<g data-node="${esc(n.id)}" data-depth="${depth}"` +
				`${isOrphan ? " data-o" : ""}${mis ? " data-x" : ""}>`,
		);
		parts.push(nodeRect(n, box, { seq: i + 1, label: labels.get(n.id), misplaced: mis }));
		parts.push("</g>");
	}
	const sufs = [...commonSuffixes(nodes).keys()];
	parts.push(legendSvg(legendRows, 8, H - 14 - (legendRows.length + sufs.length) * 16));
	// 被折叠的群组后缀在这里补回来 —— 标签里省掉了，信息不能丢
	sufs.forEach((suf, i) => {
		parts.push(
			`<g data-group="${esc(suf)}"><rect x="8" y="${H - 14 - sufs.length * 16 + i * 16}" width="11" height="11" rx="2" fill="#F1EFE8" stroke="#888780" stroke-width="1"/>` +
				`<text x="24" y="${H - 14 - sufs.length * 16 + i * 16 + 9}" class="gvl">${esc(clip(suf, 16))}（全部节点共有）</text></g>`,
		);
	});
	// ⭐⭐ **header 必须在这里拼，不能在渲染开头。**
	// 配色 class 走 `colorClass()`，它在**渲染每个节点时**才把「颜色⇒短类名」登记进
	// 模块级 `CSS_CLASSES`；而 `svgHeader()` 内的 `buildCssRules()` 只读那个 Map。
	// ⇒ 若在开头调用，Map 还是空的，`<style>` 里**一条 .cf 规则都没有**，
	//   `rect` 拿不到 fill ⇒ SVG 默认 fill 是黑 ⇒ **整张卡片黑条、文字不可见**。
	//   2026-10-05 截图评审发现；躲过了 14/14 生产复测（当时只查字节数与边数，没查颜色）。
	// ⭐⭐ **svgTail 必须在所有节点渲染完之后**（配色 class 要等colorClass() 登记完）。
	// 详见 expressive.ts 的 svgTail 文档：提前调用 ⇒ `<style>` 无配色规则 ⇒ 节点全黑。
	parts.push(svgTail(H));
	parts.push("</svg>");
	return parts.join("");
}

// ══════════════════════════════════════════════════════════
// timeline：一维顺序
// ══════════════════════════════════════════════════════════

export function buildTimelineFlowSvg(nodesIn: readonly GvNode[]): string {
	const nodes = orderNodes(nodesIn);
	const H = 40 + nodes.length * ROW_H + 34;
	const parts: string[] = [svgOpen(H)];
	nodes.forEach((n, i) => {
		const y = 30 + i * ROW_H;
		const p = paletteOf(n);
		const st = statusShade(n, p);
		parts.push(`<g data-node="${esc(n.id)}">`);
		parts.push(`<text x="8" y="${y + 13}" class="gv-t" dominant-baseline="central">${esc(clip(n.title ?? n.id, 12))}</text>`);
		parts.push(`<rect x="${PLOT_X}" y="${y}" width="${PLOT_W}" height="20" rx="5" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1"/>`);
		if (i < nodes.length - 1) {
			parts.push(`<path d="M${PLOT_X + 16},${y + 20} L${PLOT_X + 16},${y + ROW_H}" class="gv-e" marker-end="url(#gv-arrow)"/>`);
		}
		parts.push("</g>");
	});
	const lg = usedTypes(nodes);
	parts.push(legendSvg(lg, 8, H - 14 - lg.length * 16));
	// ⭐⭐ **header 必须在这里拼，不能在渲染开头。**
	// 配色 class 走 `colorClass()`，它在**渲染每个节点时**才把「颜色⇒短类名」登记进
	// 模块级 `CSS_CLASSES`；而 `svgHeader()` 内的 `buildCssRules()` 只读那个 Map。
	// ⇒ 若在开头调用，Map 还是空的，`<style>` 里**一条 .cf 规则都没有**，
	//   `rect` 拿不到 fill ⇒ SVG 默认 fill 是黑 ⇒ **整张卡片黑条、文字不可见**。
	//   2026-10-05 截图评审发现；躲过了 14/14 生产复测（当时只查字节数与边数，没查颜色）。
	// ⭐⭐ **svgTail 必须在所有节点渲染完之后**（配色 class 要等colorClass() 登记完）。
	// 详见 expressive.ts 的 svgTail 文档：提前调用 ⇒ `<style>` 无配色规则 ⇒ 节点全黑。
	parts.push(svgTail(H));
	parts.push("</svg>");
	return parts.join("");
}

// ══════════════════════════════════════════════════════════
// swimlane：阶段横轴 × 分组纵轴
// ══════════════════════════════════════════════════════════

const LANE_LABEL_W = 74;
const STAGE_COUNT = 5;

export function buildSwimlaneSvg(
	nodesIn: readonly GvNode[],
	edgesIn: readonly GvEdge[],
	groupBy: "type" | "status",
): string {
	const nodes = orderNodes(nodesIn);
	// 阶段：按业务序号切成 5 段；无序号时按 index 均分
	const laneKey = (n: GvNode) => String(n[groupBy] ?? "未分类");
	const laneNames: string[] = [];
	for (const n of nodes) {
		const k = laneKey(n);
		if (!laneNames.includes(k)) laneNames.push(k);
	}
	const laneRows = orderNodes(
		laneNames.map((k) => ({ id: k, title: k, type: k })),
	).map((n) => n.id);

	const stageOf = (i: number) => Math.min(STAGE_COUNT - 1, Math.floor((i / Math.max(1, nodes.length)) * STAGE_COUNT));
	const stageW = (W - LANE_LABEL_W - 16) / STAGE_COUNT;
	const laneH = 46;
	const headH = 26;
	const H = headH + 24 + laneRows.length * laneH + 30;
	const parts: string[] = [svgOpen(H)];

	// 阶段列头
	for (let s = 0; s < STAGE_COUNT; s++) {
		const x = LANE_LABEL_W + s * stageW;
		parts.push(
			`<g data-stage="${s}"><rect x="${x + 2}" y="8" width="${stageW - 4}" height="${headH - 10}" rx="4" fill="#E6F1FB" stroke="#85B7EB" stroke-width="1"/>` +
				`<text x="${x + stageW / 2}" y="${8 + (headH - 10) / 2}" class="gv-s" text-anchor="middle" dominant-baseline="central">阶段 ${s + 1}</text></g>`,
		);
	}

	const boxOf = new Map<string, Box>();
	// 泳道背景 + 标签
	laneRows.forEach((lane, li) => {
		const y = headH + 12 + li * laneH;
		parts.push(`<g data-lane="${esc(lane)}">`);
		parts.push(
			`<rect x="8" y="${y}" width="${W - 16}" height="${laneH - 6}" rx="6" fill="${li % 2 === 0 ? "#FAFBFC" : "#F5F6F8"}" stroke="#E6E8EB" stroke-width="0.5"/>`,
			`<text x="16" y="${y + (laneH - 6) / 2}" class="gv-t" dominant-baseline="central">${esc(clip(lane, 8))}</text>`,
		);
		parts.push("</g>");
	});

	// 节点：x 按阶段、y 按泳道
	for (const n of nodes) {
		const li = laneRows.indexOf(laneKey(n));
		if (li < 0) continue;
		const idxInLane = nodes.filter((m) => laneKey(m) === laneKey(n)).indexOf(n);
		const s = stageOf(nodes.indexOf(n));
		const x = LANE_LABEL_W + s * stageW + 6;
		const y = headH + 12 + li * laneH + 6 + Math.min(20, idxInLane * 0);
		const box: Box = { id: n.id, x, y, w: stageW - 14, h: 20, row: li };
		boxOf.set(n.id, box);
		parts.push(`<g data-node="${esc(n.id)}" data-stage="${s}">`);
		parts.push(nodeRect(n, box));
		parts.push("</g>");
	}

	// 流转箭头：按 edges（或按业务序号相邻）
	const arrowFrom: Array<[string, string]> = [];
	for (const e of edgesIn) if (boxOf.has(e.source) && boxOf.has(e.target)) arrowFrom.push([e.source, e.target]);
	if (arrowFrom.length === 0) {
		for (let i = 0; i < nodes.length - 1; i++) arrowFrom.push([nodes[i].id, nodes[i + 1].id]);
	}
	for (const [a, b] of arrowFrom) {
		const f = boxOf.get(a)!;
		const t = boxOf.get(b)!;
		const sx = f.x + f.w;
		const sy = f.y + f.h / 2;
		const tx = t.x;
		const ty = t.y + t.h / 2;
		const mx = Math.round(sx + Math.max(12, (tx - sx) / 2));
		parts.push(
			`<path data-edge="1" d="M${sx},${Math.round(sy)} C${mx},${Math.round(sy)} ${mx},${Math.round(ty)} ${tx},${Math.round(ty)}" class="gv-e" marker-end="url(#gv-arrow)"/>`,
		);
	}

	const lg = groupBy === "type" ? usedTypes(nodes) : laneRows.slice(0, 4).map((k) => ({ label: k, palette: NODE_PALETTE.default }));
	parts.push(legendSvg(lg, 8, H - 14 - lg.length * 16));
	// ⭐⭐ **header 必须在这里拼，不能在渲染开头。**
	// 配色 class 走 `colorClass()`，它在**渲染每个节点时**才把「颜色⇒短类名」登记进
	// 模块级 `CSS_CLASSES`；而 `svgHeader()` 内的 `buildCssRules()` 只读那个 Map。
	// ⇒ 若在开头调用，Map 还是空的，`<style>` 里**一条 .cf 规则都没有**，
	//   `rect` 拿不到 fill ⇒ SVG 默认 fill 是黑 ⇒ **整张卡片黑条、文字不可见**。
	//   2026-10-05 截图评审发现；躲过了 14/14 生产复测（当时只查字节数与边数，没查颜色）。
	// ⭐⭐ **svgTail 必须在所有节点渲染完之后**（配色 class 要等colorClass() 登记完）。
	// 详见 expressive.ts 的 svgTail 文档：提前调用 ⇒ `<style>` 无配色规则 ⇒ 节点全黑。
	parts.push(svgTail(H));
	parts.push("</svg>");
	return parts.join("");
}

// ══════════════════════════════════════════════════════════
// matrix：分类 × 状态
// ══════════════════════════════════════════════════════════

export function buildMatrixSvg(
	nodesIn: readonly GvNode[],
	rowBy: "type" | "status" | "parentNode",
	colBy: "type" | "status" | "parentNode",
): string {
	const nodes = nodesIn;
	const keyOf = (n: GvNode, by: typeof rowBy) => String(n[by] ?? "未分类");
	const rows: string[] = [];
	const cols: string[] = [];
	for (const n of nodes) {
		const r = keyOf(n, rowBy);
		if (!rows.includes(r)) rows.push(r);
		const c = keyOf(n, colBy);
		if (!cols.includes(c)) cols.push(c);
	}
	const cw = Math.floor((W - 150) / Math.max(1, cols.length));
	const ch = 30;
	const H = 50 + rows.length * ch + 30;
	const parts: string[] = [svgOpen(H)];
	// 列头
	cols.forEach((c, ci) => {
		parts.push(`<g data-col="${esc(c)}">`);
		parts.push(
			`<text x="${150 + ci * cw + cw / 2}" y="30" class="gv-s" text-anchor="middle" dominant-baseline="central">${esc(clip(c, Math.max(3, Math.floor(cw / 12))))}</text>`,
		);
		parts.push("</g>");
	});
	// 行 + 交叉格
	rows.forEach((r, ri) => {
		const y = 44 + ri * ch;
		parts.push(`<g data-row="${esc(r)}">`);
		parts.push(`<text x="8" y="${y + ch / 2}" class="gv-t" dominant-baseline="central">${esc(clip(r, 11))}</text>`);
		parts.push("</g>");
		cols.forEach((c, ci) => {
			const count = nodes.filter((n) => keyOf(n, rowBy) === r && keyOf(n, colBy) === c).length;
			// ⭐ 0 也画出来：空交叉本身是信息（这一类没有该状态的东西）
			const x = 150 + ci * cw;
			parts.push(
				`<g data-cell="${esc(r)}|${esc(c)}"><rect x="${x + 2}" y="${y + 2}" width="${cw - 4}" height="${ch - 4}" rx="4" fill="${count > 0 ? "#EEEDFE" : "#FAFBFC"}" stroke="${count > 0 ? "#7F77DD" : "#E6E8EB"}" stroke-width="0.5"/>` +
					`<text x="${x + cw / 2}" y="${y + ch / 2}" class="${count > 0 ? "gv-t" : "gv-s"}" text-anchor="middle" dominant-baseline="central">${count}</text></g>`,
			);
		});
	});
	parts.push(legendSvg([{ label: "非空格 = 有内容", palette: NODE_PALETTE.prompt }], 8, H - 26));
	// ⭐⭐ **header 必须在这里拼，不能在渲染开头。**
	// 配色 class 走 `colorClass()`，它在**渲染每个节点时**才把「颜色⇒短类名」登记进
	// 模块级 `CSS_CLASSES`；而 `svgHeader()` 内的 `buildCssRules()` 只读那个 Map。
	// ⇒ 若在开头调用，Map 还是空的，`<style>` 里**一条 .cf 规则都没有**，
	//   `rect` 拿不到 fill ⇒ SVG 默认 fill 是黑 ⇒ **整张卡片黑条、文字不可见**。
	//   2026-10-05 截图评审发现；躲过了 14/14 生产复测（当时只查字节数与边数，没查颜色）。
	// ⭐⭐ **svgTail 必须在所有节点渲染完之后**（配色 class 要等colorClass() 登记完）。
	// 详见 expressive.ts 的 svgTail 文档：提前调用 ⇒ `<style>` 无配色规则 ⇒ 节点全黑。
	parts.push(svgTail(H));
	parts.push("</svg>");
	return parts.join("");
}
