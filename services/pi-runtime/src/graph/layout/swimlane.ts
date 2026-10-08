import { orderNodes } from "../../tools/render-canvas-view.expressive.js";
import type { GvNode } from "../../tools/render-canvas-view.expressive.js";
import type { GraphIR, GraphIRNode } from "../graph-ir.js";
import { W, type GroupBox, type LaidOut, type PlacedEdge, type PlacedNode } from "./types.js";

/**
 * swimlane 视图的布局：GraphIR → 泳道行 + 阶段列 + 流转连线。
 *
 * 视图语义：横轴 = 阶段（按节点序均分成 `STAGE_COUNT` 段），
 * 纵轴 = 泳道（按 `groupBy` 分组）。节点框宽固定 ⇒ **同阶段的节点会重叠**，
 * 这是迁移前就有的行为（D3 才改），本任务逐字节保持。
 */

/** 泳道标签带宽度。 */
export const LANE_LABEL_W = 74;
/** 阶段列数。 */
export const STAGE_COUNT = 5;
/** 每个泳道行高。 */
export const LANE_H = 46;

/**
 * swimlane 的节点框宽（纯函数）。
 *
 * ⭐ 必须与 `layoutSwimlane` 内部用的 `stageW - 14` 同源：渲染层要先知道框宽才能
 *   按框宽算标签预算，而布局要IR 才能跑 —— 顺序上天然成环。把公式抽成函数，
 *   两处共用同一个定义，而不是各写一遍常量（那迟早漂移）。
 */
export function swimlaneNodeWidth(): number {
	return (W - LANE_LABEL_W - 16) / STAGE_COUNT - 14;
}
/** 阶段列头高度。 */
const HEAD_H = 26;
/** 泳道框比节点框多出来的高度（上下各 3）。 */
const LANE_PAD = 6;
/** 节点框在泳道内的水平内缩。 */
const NODE_INSET_X = 6;

function toGv(n: GraphIRNode): GvNode {
	return {
		id: n.id,
		...(n.type !== undefined ? { type: n.type } : {}),
		// ⭐ 用原始标题排序（业务序从标题推导），不用提炼后的 label。
		...(n.title !== undefined ? { title: n.title } : {}),
		...(n.status !== undefined ? { status: n.status } : {}),
		...(n.position !== undefined ? { position: n.position } : {}),
	};
}

export function layoutSwimlane(ir: GraphIR): LaidOut {
	const nodes = orderNodes(ir.nodes.map(toGv));
	const groupBy = ir.groupBy === "status" ? "status" : "type";

	// 泳道：先按出现顺序收集名字，再整体过一次业务序
	const laneKeyOf = (n: GvNode): string => String(n[groupBy] ?? "未分类");
	const laneNames: string[] = [];
	for (const n of nodes) {
		const k = laneKeyOf(n);
		if (!laneNames.includes(k)) laneNames.push(k);
	}
	const laneRows = orderNodes(laneNames.map((k) => ({ id: k, title: k, type: k }))).map((n) => n.id);

	const stageW = (W - LANE_LABEL_W - 16) / STAGE_COUNT;
	// 节点框宽统一走 `swimlaneNodeWidth()`，避免与渲染层预算计算出现两份公式
	const nodeW = swimlaneNodeWidth();
	// ⚠️ 阶段按**节点下标**均分，不是按业务序值 —— 迁移前就是这样。
	const stageOf = (i: number): number =>
		Math.min(STAGE_COUNT - 1, Math.floor((i / Math.max(1, nodes.length)) * STAGE_COUNT));
	const laneY = (li: number): number => HEAD_H + 12 + li * LANE_H;

	const groups: GroupBox[] = laneRows.map((key, li) => ({
		key,
		label: key,
		x: 8,
		y: laneY(li),
		w: W - 16,
		h: LANE_H - LANE_PAD,
	}));

	const irById = new Map(ir.nodes.map((n) => [n.id, n]));
	const laneIndex = new Map(laneRows.map((k, i) => [k, i]));
	const placed: PlacedNode[] = [];
	nodes.forEach((n, i) => {
		const li = laneIndex.get(laneKeyOf(n));
		if (li === undefined) return;
		const s = stageOf(i);
		const irn = irById.get(n.id);
		placed.push({
			id: n.id,
			x: LANE_LABEL_W + s * stageW + NODE_INSET_X,
			// ⚠️ 迁移前是 `+ Math.min(20, idxInLane * 0)` ⇒ 恒等于 0。
			//    保留「同泳道内全部重叠」这一行为，但把那个 0 直接写成常量 ——
			//    留着 `idxInLane * 0` 会让人以为「泳道内本来要错开、只是没生效」。
			y: laneY(li) + NODE_INSET_X,
			w: nodeW,
			h: 20,
			row: li,
			label: irn?.label ?? n.id,
			...(irn?.description !== undefined ? { description: irn.description } : {}),
			...(n.type !== undefined ? { type: n.type } : {}),
			...(ir.colors?.[n.id] !== undefined ? { color: ir.colors[n.id] } : {}),
			groupKey: laneKeyOf(n),
			// 阶段号：渲染层要写 `data-stage`，由布局层给出而非自己重算
			stage: s,
		});
	});

	// 流转箭头：显式边优先；一条可用边都没有时回落「按业务序相邻」。
	// ⚠️⏳ **D2 已知不一致，Task 9 收敛**：那个 fallback 等于宣称
	//   「画布顺序 = 流转顺序」，而IR 里并没有这条事实（C1判据的反例）。
	//   与迁移前逐字节相同 —— 本任务只把「串哪些」搬进布局层，使它可断言、可一处改。
	const ids = new Set(placed.map((p) => p.id));
	const edges: PlacedEdge[] = [];
	for (const e of ir.edges) {
		if (ids.has(e.source) && ids.has(e.target)) edges.push({ source: e.source, target: e.target, directed: true });
	}
	if (edges.length === 0) {
		for (let i = 0; i < nodes.length - 1; i++) {
			const a = nodes[i].id;
			const b = nodes[i + 1].id;
			if (ids.has(a) && ids.has(b)) edges.push({ source: a, target: b, directed: true });
		}
	}

	return {
		width: W,
		height: HEAD_H + 24 + laneRows.length * LANE_H + 30,
		nodes: placed,
		edges,
		groups,
		showType: ir.showType === true,
		...(ir.colors !== undefined ? { colors: ir.colors } : {}),
		flatOrder: nodes.map((n) => n.id),
		// 阶段列宽：渲染层画列头要用，不能自己再算一遍
		stageW,
	};
}

export type SwimlaneLaidOut = LaidOut & { stageW: number };