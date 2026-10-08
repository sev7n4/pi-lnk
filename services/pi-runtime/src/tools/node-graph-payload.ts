/**
 * `node_graph` 载荷构造器（2026-10-07）：把 `get-canvas-layout` **原样**转成 nodes/edges。
 *
 * ## 为什么不复用 `render-canvas-view.expressive.ts` 的 build* 函数
 *
 * 那些函数在做**投影**（把节点排成 bipartite 图 / 树 / 时间线 / 泳道），
 * 会**丢弃画布原始位置**并按业务序号重排 —— 那适合"生成一张说明图"，
 * 但不适合"看看我画布上现在是什么"。
 *
 * `node_graph` 的唯一职责是**透传**：
 * - `position` 直接给前端节点图库（拖动才可能写回，服务端只读）；
 * - `parentNode` 直接映射成 `groupId`（分组框）；
 * - `parentNode` 同时也是一条隐含的层级边 ⇒ 显式转成 `edges`，前端可选择画或不画。
 *
 * 排序契约：**不做业务序号重排**（与 expressive 层相反）。理由见上——节点图靠坐标定位，
 * 重排会与用户看到的画布不一致，而"卡片与画布不一致"是这类投影最被诟病的地方。
 */
import type { GvEdge, GvNode } from "./render-canvas-view.expressive.js";
import type { NodeGraphEdge, NodeGraphNode, NodeGraphPayload } from "./types-node-graph.js";

/**
 * 节点数上限（防御性）。
 *
 * ⚠️ 不设硬上限会让一张巨大画布把 SSE 撑爆；设太小会"静默丢内容"。
 * 取 200：远大于正常画布（实测几十个），又能让单条 SSE 保持在合理体积。
 */
export const NODE_GRAPH_MAX_NODES = 200;

/** layout 端点可能给的形状（宽松：只取我们要的字段，其余忽略）。 */
export interface CanvasLayoutLike {
	nodes?: unknown;
	edges?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object";
}

/** 节点 id 规范化：`group-*` 保留，其余按原样。 */
function normalizeNodeId(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const id = raw.trim();
	return id.length > 0 ? id : null;
}

/** 状态白名单（**不认识的 status 一律当 idle**，不编造语义）。 */
function normalizeStatus(raw: unknown): NodeGraphNode["status"] {
	if (raw === "running" || raw === "failed") return raw;
	// 生产里出现过 "重生中" / "生成中" 这类中文状态（用户截图实测）⇒ 归到 running。
	if (typeof raw === "string" && /重生|生成中|处理中|running/i.test(raw)) return "running";
	return "idle";
}

/**
 * 把单个 layout 节点转成 `node_graph` 节点。
 * ⚠️ **不编造**：缺 id 的直接丢弃（记进 `dropped`），缺 title 时留空串（前端显示 id）。
 */
export function toNodeGraphNode(raw: unknown): { node: NodeGraphNode | null; dropped: boolean } {
	if (!isRecord(raw)) return { node: null, dropped: true };
	const id = normalizeNodeId(raw.id);
	if (!id) return { node: null, dropped: true };

	const pos = isRecord(raw.position) ? raw.position : undefined;
	const x = typeof pos?.x === "number" ? pos.x : undefined;
	const y = typeof pos?.y === "number" ? pos.y : undefined;

	const w = typeof raw.width === "number" ? raw.width : undefined;
	const h = typeof raw.height === "number" ? raw.height : undefined;

	const parentId = normalizeNodeId(raw.parentNode);

	const node: NodeGraphNode = {
		id,
		type: typeof raw.type === "string" && raw.type.length > 0 ? raw.type : "text",
		title: typeof raw.title === "string" ? raw.title : "",
	};
	if (x !== undefined && y !== undefined) node.position = { x, y };
	if (w !== undefined && h !== undefined) node.size = { width: w, height: h };
	if (parentId) node.groupId = parentId;
	const st = normalizeStatus(raw.status);
	if (st !== "idle") node.status = st;
	return { node, dropped: false };
}

/** 把 layout 边转成 `node_graph` 边（source/target 都必须在 nodes 集合里，否则丢弃）。 */
export function toNodeGraphEdges(raw: unknown, nodeIds: Set<string>): NodeGraphEdge[] {
	const out: NodeGraphEdge[] = [];
	if (!Array.isArray(raw)) return out;
	for (const e of raw as unknown[]) {
		if (!isRecord(e)) continue;
		const source = normalizeNodeId(e.source);
		const target = normalizeNodeId(e.target);
		// ⚠️ 不做「缺节点就补空节点」—— 那是编造。直接丢，前端不知道即可。
		if (!source || !target) continue;
		if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
		const edge: NodeGraphEdge = { source, target };
		if (typeof e.label === "string" && e.label.length > 0) edge.label = e.label;
		out.push(edge);
	}
	return out;
}

/**
 * 主入口：layout → `node_graph` 载荷。
 *
 * ⚠️ `parentNode` 会额外产出一条**层级边**（分组 → 成员），因为它是画布上真实存在的从属关系；
 * 前端若只想显示 `edges` 里的显式连线，可以在渲染时按 `edge.kind` 过滤（见下）。
 */
export function buildNodeGraphPayload(
	layout: CanvasLayoutLike | GvNode[] | unknown,
	title?: string,
): NodeGraphPayload {
	// ⚠️ 三种形态都要认：裸数组/ {nodes,edges} / {data:{nodes,edges}}。
	//   之前写成「先判layout.nodes 再判 layout.data」⇒ 当 data 里才有 nodes 时会拿到undefined，
	//   断言 `Array.isArray(undefined)` 为false ⇒ 静默走空数组分支（测试直接抓到）。
	const inner: Record<string, unknown> = isRecord(layout)
		? isRecord((layout as { data?: unknown }).data)
			? ((layout as { data: Record<string, unknown> }).data)
			: layout
		: {};
	const nodesRaw: unknown = Array.isArray(layout)
		? layout
		: Array.isArray(inner.nodes)
			? inner.nodes
			: [];
	const edgesRaw: unknown = Array.isArray(layout) ? [] : Array.isArray(inner.edges) ? inner.edges : [];
	// ⚠️ 收敛为数组（`nodesRaw` 声明是 unknown：tsc 不接受直接 .length / 直接 for..of）。
	const nodesArr: unknown[] = Array.isArray(nodesRaw) ? nodesRaw : [];

	const nodes: NodeGraphNode[] = [];
	const droppedNodeIds: string[] = [];
	let invalidCount = 0;
	for (const raw of nodesArr) {
		if (nodes.length >= NODE_GRAPH_MAX_NODES) {
			// 超限：记下被丢的 id（若有），前端可提示"部分节点未显示"
			const id = isRecord(raw) ? normalizeNodeId(raw.id) : null;
			if (id) droppedNodeIds.push(id);
			continue;
		}
		const { node, dropped } = toNodeGraphNode(raw);
		if (!node) {
			invalidCount += 1;
			continue;
		}
		nodes.push(node);
	}
const totalNodeCount = nodesArr.length;

	const ids = new Set(nodes.map((n) => n.id));
	const edges = toNodeGraphEdges(edgesRaw, ids);

	const payload: NodeGraphPayload = { type: "node_graph", nodes, edges };
	if (title) payload.title = title;
	if (droppedNodeIds.length > 0) payload.droppedNodeIds = droppedNodeIds;
	if (totalNodeCount !== nodes.length) payload.totalNodeCount = totalNodeCount;
	if (invalidCount > 0) {
		// ⚠️ 无 id 的节点没有可记的 id ⇒ 用计数表达"有 N 个节点无法识别"，不静默。
		payload.droppedNodeIds = [...(payload.droppedNodeIds ?? []), `<${invalidCount} 个无 id 节点>`];
	}
	return payload;
}