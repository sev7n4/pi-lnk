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
import { condenseLabel, graphIRFromGv, labelBudgetFor, labelWidth } from "../graph/graph-ir.js";
import { layoutLayout } from "../graph/layout/layout.js";
import { layoutTimelineFlow } from "../graph/layout/timeline.js";
import { LANE_LABEL_W, STAGE_COUNT, layoutSwimlane, swimlaneNodeWidth } from "../graph/layout/swimlane.js";
import { layoutMatrix } from "../graph/layout/matrix.js";
import { TREE_DEPTH_W, layoutTree } from "../graph/layout/tree.js";
import { LABEL_W, PLOT_W, PLOT_X, ROW_H, W, edgePath } from "../graph/layout/types.js";
import {
	type GvEdge,
	type GvNode,
	type Palette,
	type Scope,
	type FocusAnchor,
	AGGREGATE_THRESHOLD,
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

// ⭐ W / ROW_H / LABEL_W / PLOT_X / PLOT_W / edgePath 已迁到 `graph/layout/types.ts`
// （坐标的唯一来源）。此处改为 import —— 两处各留一份常量迟早漂移。

/** 单个节点的外接框（供连线端点计算）。 */
interface Box {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	row: number;
}


// `edgePath` 已迁到 `graph/layout/types.ts`（几何的唯一来源）。

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
	const typeTxt = opts.showType ? ` ${n.type ?? ""}` : "";
	// ⭐⭐ N8：节点身份标签**不再 clip 截断**，改用 IR 提炼后的 `label`。
	//   提炼在 `graphIRFromGv` 完成（按本视图节点框宽算预算），原文进 `description`。
	//   ⚠️ 只有**没给 label** 时才现场提炼兜底（正常路径不会走到 —— 那是把
	//   「预算」的责任又推回渲染层，正是 D2 迁移要消除的方向倒流）。
	const body = opts.label ?? condenseLabel(n.title ?? n.id, labelBudgetFor(box.w));
	parts.push(`<text x="${box.x + 6}" y="${box.y + box.h / 2}" class="l">${esc(seq + body + typeTxt)}</text>`);
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

/**
 * 节点框里最终显示的标签：**先剥群组后缀，再按框宽提炼**。
 *
 * ⭐⭐ 两步的顺序不能反，而且**两步都必须做**：
 *  - `shortLabels` 剥掉「所有节点共有」的后缀（`…· 森林偵探社` ⇒ 群组名进图例只出现一次）。
 *    它可能把一个 20 字标题缩成 4 字 ⇒ **先提炼会把本该保住的字砍掉**。
 *  - `condenseLabel` 保证剩下的文本符合预算。它不认得群组后缀。
 *  少任何一步都会出问题：只提炼 → 后缀还在，框被撑爆；只剥后缀 → 长标题溢出。
 *
 * ⚠️ 迁移前是`clip(body, (box.w - 14) / 12 - seq.length)`：**按字符数**截，
 *   对中英混排算不准（汉字实际 12px/字、拉丁约 6px，按字符一刀切必然过度截断）。
 *   现在按单位宽算，中英混排也能装满。
 */
function nodeLabels(
	nodes: readonly GvNode[],
	boxWidthPx: number,
	opts: { seqOf?: (n: GvNode) => number | undefined; showType?: boolean } = {},
): Map<string, string> {
	const full = labelBudgetFor(boxWidthPx);
	return new Map(
		shortLabels(nodes).map(({ n, label }) => {
			// ⭐ 前缀（序号 `① ` / 类型 ` prompt`）也占框内宽度 ⇒ 必须从预算里扣掉。
			//   迁移前是 `maxChars - seq.length`：只扣了序号、**没扣类型** ⇒
			//   `showType` 打开时会把标签顶出框右缘。
			//
			// ⚠️ 类型预留必须**按视图条件化**：`showType` 只有 layout 传，
			//   tree / swimlane 的 `nodeRect` 从不传 ⇒ 无条件扣会让窄框视图
			//   白白少 2 个字（swimlane 112px 框从 8 汉字掉到 5 汉字）。
			const seq = opts.seqOf?.(n);
			const reserved =
				labelWidth(seq ? `${ordinal(seq)} ` : "") +
				(opts.showType === true ? labelWidth(` ${n.type ?? ""}`) : 0);
			return [n.id, condenseLabel(label, full - reserved)] as const;
		}),
	);
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
	/**
	 * 局部视图的出线策略（默认 `spread`）。
	 * 见 `FocusAnchor` 文档：只硬编码一种会让「看清谁连谁」与「看整体规模」互相冲突。
	 */
	focusAnchor?: FocusAnchor;
}

export function buildLayoutSvg(
	nodesIn: readonly GvNode[],
	edgesIn: readonly GvEdge[],
	opts: LayoutOpts,
): string {
	// ⭐ 坐标与方向**全部来自布局层**：本函数只负责把它们画出来（D2 的迁移边界）。
	const ir = graphIRFromGv({
		view: "layout",
		relation: opts.drawEdges ? "dependency" : "category",
		nodes: nodesIn,
		edges: edgesIn,
		// ⭐ 预算按**本视图节点框宽**算，不是全局 24 单位 —— layout 框宽 554px，
		//   能装 45 汉字；套24 单位（12 汉字）会把主视图信息量砍到 1/4（D3-2 实测）。
		labelBudget: labelBudgetFor(PLOT_W),
		groupBy: opts.groupBy,
		scope: opts.scope,
		showType: opts.showType,
		colors: opts.colors,
		emphasize: opts.emphasize,
		...(opts.focus !== undefined
			? { focus: opts.focus, hops: opts.hops, focusAnchor: opts.focusAnchor }
			: {}),
	});
	const laid = layoutLayout(ir);
	// 图例 / 标签精简 / 错位审计需要**完整**的 GvNode 字段 ⇒ 按布局产出的顺序取回。
	const byId = new Map(nodesIn.map((n) => [n.id, n]));
	const nodes = laid.nodes.map((p) => byId.get(p.id)!);
	const boxes = new Map(laid.nodes.map((p) => [p.id, p]));
	const edges = laid.edges;
	const aggSources = new Set(laid.aggSources ?? []);
	const H = laid.height;
	const anchor: FocusAnchor = opts.focusAnchor ?? "spread";
	const groupBy = opts.groupBy ?? "type";
	const parts: string[] = [svgOpen(H)];

	if (opts.drawEdges) {
		// ⭐ 同源多出边起点沿源节点高度分散 —— 修「全部从同一点射出」的扫帚
		const bySource = new Map<string, string[]>();
		for (const e of edges) {
			// 端点不在图内→丢弃（不编造）—— 布局层已过滤，这里再兜一次
			if (!boxes.has(e.source) || !boxes.has(e.target)) continue;
			const arr = bySource.get(e.source) ?? [];
			arr.push(e.target);
			bySource.set(e.source, arr);
		}
		for (const [src, targets] of bySource) {
			const from = boxes.get(src)!;
			const ordered2 = orderNodes(
				targets.map((id) => byId.get(id)).filter((x): x is GvNode => Boolean(x)),
			);
			// ⭐ `aggregate`：出边超阈值时聚合成单箭头 + 计数（其余边**不画**，不静默丢弃——
			// 计数与阈值都写在图上，用户知道还有多少条没画）
			if (anchor === "aggregate" && aggSources.has(src) && ordered2.length > AGGREGATE_THRESHOLD) {
				const midY = from.y + from.h / 2;
				const toX = PLOT_X;
				// ⚠️ 聚合说明画在**节点左侧的空白带**（PLOT_X 左边那一列）。
				// 之前画在 `from.x + from.w + 8`（节点右侧），而那里已经是绘图区右边界
				// （实测 x=712 > 画布宽 720）⇒ 文字被裁掉，用户只看到「个下游（已聚合…）」。
				const label = `→ ${ordered2.length} 个下游`;
				const labelX = Math.max(4, toX - 8 - label.length * 6);
				parts.push(
					`<path d="M${from.x + from.w},${Math.round(midY)} L${toX},${Math.round(midY)}" class="gv-e" marker-end="url(#gv-arrow)"/>` +
						`<text x="${labelX}" y="${Math.round(midY)}" class="gv-s" text-anchor="end" dominant-baseline="central">${esc(label)}</text>`,
				);
				continue;
			}
			// ⭐ `bus`：出边超阈值时，节点右侧加一条垂直汇流条，每条边从条上不同 y 出发
			const useBus = anchor === "bus" && ordered2.length > AGGREGATE_THRESHOLD;
			if (useBus) {
				const busX = from.x + from.w + 10;
				const y0 = from.y + 4;
				const y1 = from.y + from.h - 4;
				parts.push(
					`<path d="M${from.x + from.w},${Math.round(from.y + from.h / 2)} L${busX},${Math.round(from.y + from.h / 2)}" class="gv-e"/>` +
						`<path d="M${busX},${Math.round(y0)} L${busX},${Math.round(y1)}" class="gv-e"/>`,
				);
			}
			ordered2.forEach((target, i) => {
				const to = boxes.get(target.id)!;
				const isHi = (opts.emphasize ?? []).includes(src) || (opts.emphasize ?? []).includes(target.id);
				// bus 策略：起点改到汇流条上按序错开（否则仍从同一点射出）
				const d = useBus
					? edgePath({ ...from, x: from.x + from.w + 10, w: 0, y: from.y + 4, h: from.h - 8 }, to, i, ordered2.length)
					: edgePath(from, to, i, ordered2.length);
				parts.push(
					`<path data-edge="1" d="${d}" class="gv-e" marker-end="url(#gv-arrow${isHi ? "-hi" : ""})"${isHi ? ' stroke="#534AB7" stroke-width="2"' : ""}/>`,
				);
			});
		}
	}

	const emph = new Set(opts.emphasize ?? []);
	// ⭐ 与 tree 同一套：业务序号 + 精简标签 + 错位标记
	// 错位判定与节点顺序都由布局层给出（laid.audit），渲染层不重新推导。
	const audit = laid.audit!;
	const misIds = new Set(audit.misplaced.map((m) => m.id));
	// 序号占宽必须从预算里扣：`nodeLabels` 需要知道每个节点的 seq
	const seqById = new Map(laid.nodes.map((p) => [p.id, p.seq] as const));
	const labels = nodeLabels(nodes, PLOT_W, {
		seqOf: (n) => seqById.get(n.id),
		showType: opts.showType,
	});
	if (laid.focus !== undefined) {
		// 局部视图必须自报家门，否则用户会误以为这就是全部
		//
		// ⭐ **用节点标题而不是 id**（2026-10-05 UX 评审）：
		// 原来显示 `prompt-179091292046…` —— 卡片里每个节点都写着
		// 「《森林偵探社》EP01《長老之死》· 資產表」，唯独说明行给一串无意义字符。
		// 用户读卡片第一眼认的是标题，说明行就该与卡片**用同一个名字**。
		//
		// 标题过长时裁剪并**保留 id 尾部**（`…· 資產表（…-46）`）：
		// 用户要换 focus 中心时需要能报出 id，尾部 6 位足够定位且不干扰阅读。
		const focusId = String(laid.focus.id);
		const titleRaw = labels.get(focusId) ?? focusId;
		const hopsShown = laid.focus.hops;
		const isTitle = titleRaw !== focusId;
		const name = isTitle
			? clip(titleRaw, 26) + (titleRaw.length > 26 ? `（…${focusId.slice(-6)}）` : "")
			: `${focusId}（该节点没有标题）`;
		parts.push(
			`<g data-focus="${esc(focusId)}" data-hops="${hopsShown}">` +
				`<rect x="8" y="8" width="${W - 16}" height="20" rx="4" fill="#E6F1FB" stroke="#378ADD" stroke-width="0.5"/>` +
				`<text x="14" y="18" class="gv-info" dominant-baseline="central">局部视图：只看「${esc(name)}」的 ${hopsShown} 跳邻域（${nodes.length} 个节点 / ${edges.length} 条边）· 换 focus 看别处</text></g>`,
		);
	}
	const note = auditNoteSvg(audit.misplaced, audit.compared);
	if (note) parts.push(note);
	let lastGroup: string | undefined;
	for (const p of laid.nodes) {
		const n = byId.get(p.id)!;
		const g = p.groupKey ?? "default";
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
			nodeRect(n, boxes.get(p.id)!, {
				color: p.color,
				emphasized: p.emphasized === true,
				seq: p.seq,
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

// ⭐ 行序、缩进、父子 trunk 的坐标全部在 `graph/layout/tree.ts`（`TREE_INDENT` /
// `TREE_DEPTH_W` 也搬过去了）。本函数只画 —— 与 layout 视图同一条迁移边界。

export function buildTreeSvg(nodesIn: readonly GvNode[], edgesIn: readonly GvEdge[]): string {
	// 预算按tree 的节点框宽（150px ⇒ 22 单位 ≈ 11 汉字）
	const ir = graphIRFromGv({
		view: "tree",
		relation: "category",
		nodes: nodesIn,
		edges: edgesIn,
		labelBudget: labelBudgetFor(TREE_DEPTH_W),
	});
	const laid = layoutTree(ir);
	const byId = new Map(nodesIn.map((n) => [n.id, n]));
	// 图例 / 标签精简需要**完整**的 GvNode 字段，且要按**平铺序**（不是行序）。
	const nodes = (laid.flatOrder ?? laid.nodes.map((p) => p.id)).map((id) => byId.get(id)!);
	const H = laid.height;
	const orphans = laid.nodes.filter((p) => p.orphan === true).length;
	const ORPHAN = orphans > 0;
	const audit = laid.audit!;
	const misIds = new Set(audit.misplaced.map((m) => m.id));
	const treeSeq = new Map(laid.nodes.map((p) => [p.id, p.seq] as const));
	// tree 从不显示类型（`nodeRect` 不传 showType）⇒ 不做类型预留
	const labels = nodeLabels(nodes, TREE_DEPTH_W, { seqOf: (n) => treeSeq.get(n.id) });
	const parts: string[] = [svgOpen(H)];
	// ⭐ 顺序校验说明（用户要求：按业务序渲染，并指出画布上放错的）
	const note = auditNoteSvg(audit.misplaced, audit.compared);
	if (note) {
		parts.push(note);
		// 有说明行时整体下移20px，避免与首行节点重叠
	}
	// 纵线（父子连线）—— 坐标由布局层给出，渲染层不按 depth 反推缩进
	for (const t of laid.trunks) {
		parts.push(`<path d="M${t.x},${t.yTop} L${t.x},${t.yBottom}" class="gv-e"/>`);
		// ⭐ 箭头只由 `directed`（来自 IR 的 containment 语义）决定，渲染层不自行决定（C1）
		if (t.directed) {
			parts.push(`<path d="M${t.x},${t.yBottom} L${t.armTo},${t.yBottom}" class="gv-e" marker-end="url(#gv-arrow)"/>`);
		}
	}
	if (ORPHAN) {
		const bodyRows = laid.nodes.length - orphans;
		parts.push(
			`<line x1="8" y1="${30 + bodyRows * ROW_H + 2}" x2="${W - 16}" y2="${30 + bodyRows * ROW_H + 2}" stroke="#D3D1C7" stroke-width="1"/>`,
			`<text x="8" y="${30 + (bodyRows + 0.7) * ROW_H}" class="gv-s">未归类（无 parentNode，挂在根下）</text>`,
		);
	}
	for (const p of laid.nodes) {
		const n = byId.get(p.id)!;
		const box: Box = { id: n.id, x: p.x, y: p.y, w: p.w, h: p.h, row: p.row };
		parts.push(
			`<g data-node="${esc(n.id)}" data-depth="${p.depth ?? 0}"` +
				`${p.orphan ? " data-o" : ""}${misIds.has(n.id) ? " data-x" : ""}>`,
		);
		parts.push(
			nodeRect(n, box, {
				seq: p.seq,
				label: labels.get(n.id),
				color: p.color,
				misplaced: misIds.has(n.id),
			}),
		);
		parts.push("</g>");
	}
	const legendRows = usedTypes(nodes);
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
	// ⭐ 行序、纵坐标、行间连线全部来自 `graph/layout/timeline.ts`。
	// timeline 的标签画在**左侧标签带**里（x=8起），不是节点框内 ⇒ 预算按标签带宽度算
	const laid = layoutTimelineFlow(
		graphIRFromGv({
			view: "timeline",
			relation: "category",
			nodes: nodesIn,
			edges: [],
			labelBudget: labelBudgetFor(LABEL_W),
		}),
	);
	const byId = new Map(nodesIn.map((n) => [n.id, n]));
	// 图例吃**平铺序**（与 tree 同理：迁移前是 `orderNodes(nodesIn)`）。
	const nodes = (laid.flatOrder ?? laid.nodes.map((p) => p.id)).map((id) => byId.get(id)!);
	const H = laid.height;
	const parts: string[] = [svgOpen(H)];
	for (const p of laid.nodes) {
		const n = byId.get(p.id)!;
		const pal = paletteOf(n, p.color);
		const st = statusShade(n, pal);
		parts.push(`<g data-node="${esc(n.id)}">`);
		parts.push(`<text x="8" y="${p.y + 13}" class="gv-t" dominant-baseline="central">${esc(clip(p.label, 12))}</text>`);
		parts.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="5" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1"/>`);
		parts.push("</g>");
	}
	// ⏳ 方向语义尚未收敛到 IR（Task 9）：布局层给的是「相邻行有向连线」，
	//   迁移前则是渲染层按 `i < len-1` 自行判定 —— 行为逐字节相同，判据已前移。
	for (const t of laid.trunks) {
		parts.push(`<path d="M${t.x},${t.yTop} L${t.x},${t.yBottom}" class="gv-e"${t.directed ? ' marker-end="url(#gv-arrow)"' : ""}/>`);
	}
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

export function buildSwimlaneSvg(
	nodesIn: readonly GvNode[],
	edgesIn: readonly GvEdge[],
	groupBy: "type" | "status",
): string {
	// ⭐ 泳道行、阶段列、节点框、流转连线全部来自 `graph/layout/swimlane.ts`。
	const ir = graphIRFromGv({
		view: "swimlane",
		relation: edgesIn.length > 0 ? "dependency" : "category",
		nodes: nodesIn,
		edges: edgesIn,
		groupBy,
		// 节点框宽 = stageW − 14（112px ⇒ 16 单位 ≈ 8 汉字）
		labelBudget: labelBudgetFor(swimlaneNodeWidth()),
	});
	const laid = layoutSwimlane(ir);
	const byId = new Map(nodesIn.map((n) => [n.id, n]));
	// 图例吃**平铺序**（与 tree / timeline 同理）。
	const nodes = (laid.flatOrder ?? laid.nodes.map((p) => p.id)).map((id) => byId.get(id)!);
	const swimSeq = new Map(laid.nodes.map((p) => [p.id, p.seq] as const));
	const swimLabels = nodeLabels(nodes, swimlaneNodeWidth(), { seqOf: (n) => swimSeq.get(n.id) });
	const stageW = laid.stageW!;
	const H = laid.height;
	const headH = 26;
	const parts: string[] = [svgOpen(H)];

	// 阶段列头
	for (let s = 0; s < STAGE_COUNT; s++) {
		const x = LANE_LABEL_W + s * stageW;
		parts.push(
			`<g data-stage="${s}"><rect x="${x + 2}" y="8" width="${stageW - 4}" height="${headH - 10}" rx="4" fill="#E6F1FB" stroke="#85B7EB" stroke-width="1"/>` +
				`<text x="${x + stageW / 2}" y="${8 + (headH - 10) / 2}" class="gv-s" text-anchor="middle" dominant-baseline="central">阶段 ${s + 1}</text></g>`,
		);
	}

	// 泳道背景 + 标签
	for (const g of laid.groups) {
		parts.push(`<g data-lane="${esc(g.key)}">`);
		parts.push(
			`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="6" fill="${laid.groups.indexOf(g) % 2 === 0 ? "#FAFBFC" : "#F5F6F8"}" stroke="#E6E8EB" stroke-width="0.5"/>`,
			`<text x="16" y="${g.y + g.h / 2}" class="gv-t" dominant-baseline="central">${esc(clip(g.key, 8))}</text>`,
		);
		parts.push("</g>");
	}

	// 节点
	for (const p of laid.nodes) {
		const n = byId.get(p.id)!;
		const box: Box = { id: n.id, x: p.x, y: p.y, w: p.w, h: p.h, row: p.row };
		parts.push(`<g data-node="${esc(n.id)}" data-stage="${p.stage ?? 0}">`);
		// ⭐ 标签走 `nodeLabels`（剥后缀 + 按框宽提炼），与 layout/tree 同一套。
		//   迁移前这里不传 label，`nodeRect` 直接用 `n.title` ⇒ 靠内部 clip 截断，
		//   既绕过提炼也按字符数算不准中英混排。
		parts.push(nodeRect(n, box, { label: swimLabels.get(n.id) }));
		parts.push("</g>");
	}

	// 流转箭头：连线形状在渲染层，但「串哪些」由布局层决定。
	// ⏳ 方向语义尚未收敛到 IR（Task 9）：无边时的相邻 fallback 仍在。
	for (const e of laid.edges) {
		const f = laid.nodes.find((p) => p.id === e.source);
		const t = laid.nodes.find((p) => p.id === e.target);
		if (!f || !t) continue;
		const sx = f.x + f.w;
		const sy = f.y + f.h / 2;
		const tx = t.x;
		const ty = t.y + t.h / 2;
		const mx = Math.round(sx + Math.max(12, (tx - sx) / 2));
		parts.push(
			`<path data-edge="1" d="M${sx},${Math.round(sy)} C${mx},${Math.round(sy)} ${mx},${Math.round(ty)} ${tx},${Math.round(ty)}" class="gv-e"${e.directed ? ' marker-end="url(#gv-arrow)"' : ""}/>`,
		);
	}

	const lg =
		groupBy === "type"
			? usedTypes(nodes)
			: laid.groups.slice(0, 4).map((g) => ({ label: g.key, palette: NODE_PALETTE.default }));
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
	// ⭐ 行列、列宽、格子坐标、图例位置全部来自 `graph/layout/matrix.ts`。
	const laid = layoutMatrix(
		// matrix 不在节点框里画标题（格子里是计数）⇒ 不传 labelBudget
		graphIRFromGv({ view: "matrix", relation: "category", nodes: nodesIn, edges: [] }),
		rowBy,
		colBy,
	);
	const m = laid.matrix;
	const H = laid.height;
	const parts: string[] = [svgOpen(H)];
	// 列头
	m.cols.forEach((c, ci) => {
		parts.push(`<g data-col="${esc(c)}">`);
		parts.push(
			`<text x="${m.labelW + ci * m.cw + m.cw / 2}" y="${m.colLabelY}" class="gv-s" text-anchor="middle" dominant-baseline="central">${esc(clip(c, Math.max(3, Math.floor(m.cw / 12))))}</text>`,
		);
		parts.push("</g>");
	});
	// 行 + 交叉格：**逐行交错**输出（行标签紧跟本行的格子）。
	// ⭐ 不能拆成「所有行标签」+「所有格子」两段 —— 那会改变 SVG 里元素的先后顺序，
	//   视觉上等价但**字节不同** ⇒ D2 的验收判据是逐字节不变。
	for (const r of m.rows) {
		parts.push(`<g data-row="${esc(r)}">`);
		parts.push(
			`<text x="8" y="${m.firstRowY + m.rows.indexOf(r) * m.ch + m.ch / 2}" class="gv-t" dominant-baseline="central">${esc(clip(r, 11))}</text>`,
		);
		parts.push("</g>");
		for (const cell of m.cells.filter((c) => c.row === r)) {
			// ⭐ 0 也画出来：空交叉本身是信息（这一类没有该状态的东西）
			const on = cell.count > 0;
			parts.push(
				`<g data-cell="${esc(cell.row)}|${esc(cell.col)}"><rect x="${cell.x + 2}" y="${cell.y + 2}" width="${cell.w}" height="${cell.h}" rx="4" fill="${on ? "#EEEDFE" : "#FAFBFC"}" stroke="${on ? "#7F77DD" : "#E6E8EB"}" stroke-width="0.5"/>` +
					`<text x="${cell.x + m.cw / 2}" y="${cell.y + m.ch / 2}" class="${on ? "gv-t" : "gv-s"}" text-anchor="middle" dominant-baseline="central">${cell.count}</text></g>`,
			);
		}
	}
	parts.push(legendSvg([{ label: "非空格 = 有内容", palette: NODE_PALETTE.prompt }], 8, m.legendY));
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
