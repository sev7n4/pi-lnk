import {
	AGGREGATE_THRESHOLD,
	SPREAD_PER_EDGE,
	auditOrder,
	filterEdgesByScope,
	focusNeighborhood,
	nodesInNeighborhood,
	orderNodes,
} from "../../tools/render-canvas-view.expressive.js";
import type { GvEdge, GvNode } from "../../tools/render-canvas-view.expressive.js";
import { edgeDirected } from "../edge-direction.js";
import type { GraphIR, GraphIRNode } from "../graph-ir.js";
import { PLOT_W, PLOT_X, ROW_H, W, type LaidOut, type PlacedEdge, type PlacedNode } from "./types.js";

/** 分组键只取这三个字段 —— GvNode 与 GraphIRNode 都满足，避免来回转换。 */
interface GroupFields {
	type?: string;
	status?: string;
	parentNode?: string;
}

/**
 * layout 视图（依赖图）的布局：GraphIR → 坐标。
 *
 * ⭐ 本函数**不产出任何字符串**：渲染层（`buildLayoutSvg`）只消费坐标与方向。
 * ⛔ 迁移期判据是「对外输出逐字节不变」—— 所以这里的每一步都与原实现逐行对应，
 *    包括看起来像 bug 的地方（如分组分隔线用 `ROW_H` 而非变高后的行高）。
 */

/** 稳定地把同 key 的节点聚到一起（保持组内原序）。 */
export function groupAdjacent<T>(list: readonly T[], keyOf: (n: T) => string): T[] {
	const buckets = new Map<string, T[]>();
	for (const n of list) {
		const k = keyOf(n);
		const arr = buckets.get(k) ?? [];
		arr.push(n);
		buckets.set(k, arr);
	}
	return [...buckets.values()].flat();
}

/** IR 节点 → GvNode（仅供排序 / 邻域等既有 helper 复用，不进渲染）。 */
function toGv(n: GraphIRNode): GvNode {
	return {
		id: n.id,
		...(n.type !== undefined ? { type: n.type } : {}),
		// ⭐ 用**原始标题**排序，不是提炼后的 label：业务序（businessOrder）从标题推导，
		// 用 label 会在 D3-2 打开提炼后改变排序（那是一次静默的行为变化）。
		...(n.title !== undefined ? { title: n.title } : {}),
		...(n.status !== undefined ? { status: n.status } : {}),
		...(n.parentNode !== undefined ? { parentNode: n.parentNode } : {}),
		// ⭐ `position` 必须带上：`orderNodes` / `auditOrder` 的次级排序键是画布 y/x。
		// 漏掉它不会报错（多数用例原地下标恰好同序）⇒ 静默的排序行为变化。
		...(n.position !== undefined ? { position: n.position } : {}),
	};
}

export function layoutLayout(ir: GraphIR): LaidOut {
	const gvNodes = ir.nodes.map(toGv);
	const gvEdges: GvEdge[] = ir.edges.map((e) => ({ source: e.source, target: e.target }));

	// ⭐ 先按 scope 裁边，再按 focus 裁节点（顺序不可颠倒：先裁边才知道邻域里有哪些边）
	const scope = ir.scope ?? "structure";
	const drawEdges = ir.relation === "dependency";
	let edges = drawEdges ? filterEdgesByScope(gvNodes, gvEdges, scope) : [];
	let nodes = orderNodes(gvNodes);
	let focusKeep: Set<string> | undefined;
	if (ir.focus !== undefined) {
		focusKeep = focusNeighborhood(nodes, edges, ir.focus, ir.hops ?? 1);
		nodes = nodesInNeighborhood(nodes, focusKeep);
		edges = edges.filter((e) => focusKeep!.has(e.source) && focusKeep!.has(e.target));
	}

	const groupBy = ir.groupBy ?? "type";
	const groupKeyOf = (n: GroupFields): string =>
		groupBy === "status"
			? (n.status ?? "未标状态")
			: groupBy === "parentNode"
				? (n.parentNode ?? "未归类")
				: (n.type ?? "default");
	if (groupBy !== "type") nodes = groupAdjacent(nodes, groupKeyOf);

	const anchor = ir.focusAnchor ?? "spread";
	// ⚠️ 出度要**所有策略都算**（不是只有 aggregate）—— spread 也要靠它决定焦点行拉多高。
	const outDeg = new Map<string, number>();
	for (const e of edges) outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
	const aggSources = new Set([...outDeg.entries()].filter(([, c]) => c > AGGREGATE_THRESHOLD).map(([k]) => k));

	const rowHeight = (id: string): number => {
		if (anchor !== "spread" || !focusKeep) return ROW_H;
		if (!focusKeep.has(id)) return ROW_H;
		const d = (outDeg.get(id) ?? 0) + 1;
		return Math.max(ROW_H, d * SPREAD_PER_EDGE);
	};
	// 先算每行高度，再累加出 y —— 变高行会把后续行整体下移
	const rowHs = nodes.map((n) => rowHeight(n.id));
	const H = 40 + rowHs.reduce((a, b) => a + b, 0) + 24;
	const rowY: number[] = [];
	{
		let acc = 0;
		for (let i = 0; i < nodes.length; i++) {
			rowY[i] = 30 + acc;
			acc += rowHs[i];
		}
	}

	const irById = new Map(ir.nodes.map((n) => [n.id, n]));
	const emph = new Set(ir.emphasize ?? []);
	const audit = auditOrder(nodes);
	const misIds = new Set(audit.misplaced.map((m) => m.id));

	const placed: PlacedNode[] = nodes.map((n, i) => {
		const irn = irById.get(n.id);
		return {
			id: n.id,
			x: PLOT_X,
			y: rowY[i],
			w: PLOT_W,
			h: rowHs[i],
			row: i,
			label: irn?.label ?? n.id,
			...(irn?.description !== undefined ? { description: irn.description } : {}),
			seq: i + 1,
			...(misIds.has(n.id) ? { misplaced: true } : {}),
			...(n.type !== undefined ? { type: n.type } : {}),
			...(ir.colors?.[n.id] !== undefined ? { color: ir.colors[n.id] } : {}),
			groupKey: groupKeyOf(irn ?? { type: n.type, status: n.status, parentNode: n.parentNode }),
			...(emph.has(n.id) ? { emphasized: true } : {}),
		};
	});

	// 端点不在图内 ⇒ 丢弃（不编造），与原实现一致
	const ids = new Set(placed.map((p) => p.id));
	const irEdgeByKey = new Map(ir.edges.map((e) => [`${e.source}\u0000${e.target}`, e]));
	const placedEdges: PlacedEdge[] = edges
		.filter((e) => ids.has(e.source) && ids.has(e.target))
		.map((e) => {
			// ⭐ 方向来自 IR 的 `edge.kind`（C1），不是 `ir.relation`：
			//   一图多关系时只看 relation 会抹掉个别的边方向。
			const ire = irEdgeByKey.get(`${e.source}\u0000${e.target}`);
			return {
				source: e.source,
				target: e.target,
				// 边若不在 IR 里（理论上不会发生），保守不画箭头而不是画一个假的
				directed: ire !== undefined && edgeDirected(ir, ire),
				isHi: emph.has(e.source) || emph.has(e.target),
			};
		});

	return {
		width: W,
		height: H,
		nodes: placed,
		edges: placedEdges,
		groups: [],
		showType: ir.showType === true,
		...(ir.colors !== undefined ? { colors: ir.colors } : {}),
		...(ir.emphasize !== undefined ? { emphasize: ir.emphasize } : {}),
		audit: { misplaced: audit.misplaced, compared: audit.compared },
		aggSources: [...aggSources],
		...(ir.focus !== undefined ? { focus: { id: ir.focus, hops: Math.max(1, Math.min(3, Math.floor(ir.hops ?? 1))) } } : {}),
	};
}
