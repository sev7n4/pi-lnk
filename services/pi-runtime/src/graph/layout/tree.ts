import { auditOrder, businessOrder, orderNodes } from "../../tools/render-canvas-view.expressive.js";
import type { GvEdge, GvNode } from "../../tools/render-canvas-view.expressive.js";
import type { GraphIR, GraphIRNode } from "../graph-ir.js";
import { PLOT_X, ROW_H, W, type LaidOut, type PlacedNode, type Trunk } from "./types.js";

/**
 * tree 视图的布局：GraphIR → 行序 + 缩进 + 父子trunk。
 *
 * ⭐ 本函数**不产出任何字符串**：父子连线（trunk）的坐标也在这里算完 ——
 * 渲染层若自己按 `depth * TREE_INDENT` 反推x，那就是第二份缩进逻辑，
 * 改 `TREE_INDENT` 只会改到一半（Task 3 在 layout 视图上学到的教训）。
 *
 * ⛔ 迁移期判据「对外输出逐字节不变」：每一步都与原`buildTreeSvg` 逐行对应，
 *    包括看起来像 bug 的地方（根层三段排序、`kids.sort` 用画布 y）。
 */

/** 每层缩进。 */
export const TREE_INDENT = 26;
/** 节点框宽。 */
export const TREE_DEPTH_W = 150;
/** 竖线相对本层 x 的左移量。 */
const TRUNK_GAP = 10;
/** 竖线底端向节点框伸出的横臂长度（从竖线 x 起算）。 */
const TRUNK_ARM = 8;
/** 孤儿分隔区比正文多留的高度。 */
const ORPHAN_PAD = 24;

/** 保持业务序的稳定排序（`orderNodes` 需要 `GvNode` 的 `position`）。 */
function toGv(n: GraphIRNode): GvNode {
	return {
		id: n.id,
		...(n.type !== undefined ? { type: n.type } : {}),
		// ⭐ 用**原始标题**排序，不用提炼后的 label：业务序从标题推导，
		// 用 label 会在 D3-2 打开提炼后静默改变顺序。
		...(n.title !== undefined ? { title: n.title } : {}),
		...(n.status !== undefined ? { status: n.status } : {}),
		...(n.parentNode !== undefined ? { parentNode: n.parentNode } : {}),
		...(n.position !== undefined ? { position: n.position } : {}),
	};
}

export function layoutTree(ir: GraphIR): LaidOut & { trunks: Trunk[] } {
	const all = ir.nodes.map(toGv);
	// 边只用来推断父子（显式 `parentNode` 优先于推断）
	const edges: readonly GvEdge[] = ir.edges.map((e) => ({ source: e.source, target: e.target }));
	// ⭐ 根节点判定**必须看入边**，不能只看有没有 parentNode：
	// 「大纲 → 6 个 EP」这种结构里，大纲节点既无 parentNode、又是指向 4 个节点的那个，
	// 只看 parentNode 会把它误判成叶子、排到末尾（实测 bug：EP01..EP10 排在它前面）。
	const childOf = new Map<string, Set<string>>();
	for (const e of edges) {
		if (e.source === e.target) continue;
		const arr = childOf.get(e.source) ?? new Set<string>();
		arr.add(e.target);
		childOf.set(e.source, arr);
	}
	const byId = new Map(all.map((n) => [n.id, n]));
	// 显式 parentNode 优先（用户手动挂的层级比推断可靠）
	const explicitChild = new Map<string, string[]>();
	for (const n of all) {
		if (n.parentNode && byId.has(n.parentNode)) {
			const arr = explicitChild.get(n.parentNode) ?? [];
			arr.push(n.id);
			explicitChild.set(n.parentNode, arr);
		}
	}

	const childrenOf = new Map<string, GvNode[]>();
	const roots: GvNode[] = [];
	for (const n of all) {
		const explicit = explicitChild.get(n.id);
		const inferred = [...(childOf.get(n.id) ?? [])];
		const kids = [...new Set([...(explicit ?? []), ...inferred])]
			.map((id) => byId.get(id))
			// ⚠️ 必须先收窄再用 `.id`：`Boolean(x) && x.id !== n.id` 里 TS 不会跨 `&&` 收窄
			//（`x` 仍是 `GvNode | undefined`）⇒ 报 TS18048。
			.filter((x): x is GvNode => x !== undefined)
			.filter((x) => x.id !== n.id);
		if (kids.length > 0) childrenOf.set(n.id, kids);
		// 无子节点 ⇒ 叶子；叶子不是根，除非它也没有 parentNode
		const isLeaf = kids.length === 0;
		const hasExplicitParent = Boolean(n.parentNode && byId.has(n.parentNode));
		if (isLeaf && !hasExplicitParent) {
			// 叶子但没挂到任何人 ⇒ 顶层（画在根层）
			roots.push(n);
		} else if (!isLeaf) {
			// 有子节点但自己被显式挂到别人下面 ⇒ 走 parentNode 分支，不当根
			if (!hasExplicitParent) roots.push(n);
		}
	}
	// ⚠️ 子树内**必须按业务序号排**，不能按画布y：同一父节点下
	// 「EP05(y=500) 在 EP04(y=600) 之前」是画布的摆放问题，不是剧情顺序。
	for (const [k, arr] of childrenOf) childrenOf.set(k, orderNodes(arr));

	// 深度优先展开
	const rows: Array<{ n: GvNode; depth: number }> = [];
	const seen = new Set<string>();
	const walk = (list: readonly GvNode[], depth: number) => {
		for (const n of list) {
			if (seen.has(n.id)) continue; // 环保护
			seen.add(n.id);
			rows.push({ n, depth });
			walk(childrenOf.get(n.id) ?? [], depth + 1);
		}
	};
	// ⭐ 根节点排序：**有子节点（层级根）优先**。`orderNodes` 会把「无业务序号」的排到
	// 「有序号」之后 —— 那对平铺列表正确，但对树是错的：层级根（如「全劇大綱」，标题无编号）
	// 会掉到叶子后面，读起来像它属于最后那集（实测 bug）。
	const rootsOrdered = roots
		.map((n) => ({ n, hasKids: (childrenOf.get(n.id)?.length ?? 0) > 0 }))
		.sort((a, b) => (a.hasKids === b.hasKids ? 0 : a.hasKids ? -1 : 1))
		.map((x) => x.n);
	// 根层排序三段（每段一个不可妥协的约束，按优先级）：
	//   ① 层级根（有子节点）—— 无论有无业务序号，都排在所有叶子之前。
	//   ② 有业务序号的叶子 —— 按序号升序（EP04 在 EP05 前，即使画布 y 相反）。
	//   ③ 无业务序号的叶子 —— 回落画布位置。
	const hasKids = (n: GvNode) => (childrenOf.get(n.id)?.length ?? 0) > 0;
	const kids = rootsOrdered.filter(hasKids);
	const leavesWithOrd = rootsOrdered.filter((n) => !hasKids(n) && businessOrder(n.title) !== undefined);
	const leavesNoOrd = rootsOrdered.filter((n) => !hasKids(n) && businessOrder(n.title) === undefined);
	const rootsFinal = [
		...kids.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0)),
		...leavesWithOrd.sort((a, b) => (businessOrder(a.title) ?? 0) - (businessOrder(b.title) ?? 0)),
		...leavesNoOrd.sort(
			(a, b) =>
				(a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0),
		),
	];
	walk(rootsFinal, 0);
	const orphans = all.filter((n) => !seen.has(n.id));
	const ORPHAN = orphans.length > 0;
	if (ORPHAN) for (const n of orphans) rows.push({ n, depth: 0 });

	const audit = auditOrder(all);
	const misIds = new Set(audit.misplaced.map((m) => m.id));
	const irById = new Map(ir.nodes.map((n) => [n.id, n]));
	const H = 40 + rows.length * ROW_H + (ORPHAN ? ORPHAN_PAD : 0) + 24;
	const placed: PlacedNode[] = rows.map(({ n, depth }, i) => {
		const irn = irById.get(n.id);
		const isOrphan = ORPHAN && i >= rows.length - orphans.length;
		return {
			id: n.id,
			x: PLOT_X + depth * TREE_INDENT,
			y: 30 + i * ROW_H,
			w: TREE_DEPTH_W,
			h: 20,
			row: i,
			label: irn?.label ?? n.id,
			...(irn?.description !== undefined ? { description: irn.description } : {}),
			seq: i + 1,
			...(misIds.has(n.id) ? { misplaced: true } : {}),
			...(n.type !== undefined ? { type: n.type } : {}),
			...(ir.colors?.[n.id] !== undefined ? { color: ir.colors[n.id] } : {}),
			depth,
			...(isOrphan ? { orphan: true } : {}),
		};
	});

	// 父子 trunk：`depth > 0` 的行从上一行垂下来，再向右伸进自己的框。
	// ⭐ 方向（箭头）由 IR 的 containment 语义决定，不由渲染层自行决定（C1）。
	const trunks: Trunk[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (rows[i].depth === 0) continue;
		trunks.push({
			row: i,
			x: PLOT_X + rows[i].depth * TREE_INDENT - TRUNK_GAP,
			yTop: 30 + (i - 1) * ROW_H + ROW_H / 2,
			yBottom: 30 + i * ROW_H + ROW_H / 2,
			// ⚠️ 从**竖线 x** 起算（不是从节点框左边缘往回）——
			// 两者差TRUNK_GAP，写成后者会让横臂短 2px。
			armTo: PLOT_X + rows[i].depth * TREE_INDENT - TRUNK_GAP + TRUNK_ARM,
			directed: true,
		});
	}

	return {
		width: W,
		height: H,
		nodes: placed,
		// tree 的父子关系**不是** edges：它由 parentNode + 入边推断而来，
		// 端点是层级而非依赖 ⇒ 不放进 `edges`，否则渲染层会把 containment 画成依赖。
		edges: [],
		groups: [],
		showType: ir.showType === true,
		...(ir.colors !== undefined ? { colors: ir.colors } : {}),
		// ⭐ 图例 / 标签精简吃的是**平铺序**（迁移前是 `orderNodes(nodesIn)`），
		// 不是 DFS 行序 —— 否则图例项与群组后缀的排列会静默改变。
		flatOrder: orderNodes(all).map((n) => n.id),
		audit: { misplaced: audit.misplaced, compared: audit.compared },
		trunks,
	};
}