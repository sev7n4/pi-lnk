import { orderNodes } from "../../tools/render-canvas-view.expressive.js";
import type { GvNode } from "../../tools/render-canvas-view.expressive.js";
import { edgeDirected } from "../edge-direction.js";
import type { GraphIR, GraphIRNode } from "../graph-ir.js";
import { W, type GroupBox, type LaidOut, type PlacedEdge, type PlacedNode } from "./types.js";

/**
 * swimlane 视图的布局：GraphIR → 泳道行 + 阶段列 + 流转连线。
 *
 * 视图语义：横轴 = 阶段（按节点序均分成 `STAGE_COUNT` 段），
 * 纵轴 = 泳道（按 `groupBy` 分组）。
 *
 * ⭐ D3-1 修正（2026-10-09）：同一个「泳道 × 阶段」格子里的多个节点**纵向错开**，
 *   泳道行高按该泳道的最大格子占用数自适应。
 *   迁移前的 `Math.min(20, idxInLane * 0)` 恒为 0 ⇒ 同格节点**完全重叠**，
 *   26 个节点只露出 10 个位置（16 个被盖住）且不报错 —— 典型的静默降级。
 *
 * ⛔ 单节点/格时必须与迁移前**逐字节一致**：`laneHeight(1) = 32 < 46` ⇒ 取下限 46。
 *   这样小画布（黄金快照的 5 节点用例）不受影响，diff 只落在真有多节点的场景。
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
/** 节点框在泳道内的水平内缩（纵向也用同一个值，与迁移前一致）。 */
const NODE_INSET_X = 6;
/** 节点框高。 */
const NODE_H = 20;
/** 同格内相邻节点框的垂直间隙。 */
const NODE_GAP = 4;

/**
 * 泳道行高：由该泳道内**最挤的那个格子**决定。
 *
 * ⭐ `slot = 1` 时算出 32 < 46 ⇒ 取 `LANE_H` 下限 ⇒ 单节点/格与迁移前逐字节一致。
 */
export function laneHeight(maxSlot: number): number {
	const slot = Math.max(1, Math.floor(maxSlot));
	return Math.max(LANE_H, slot * NODE_H + (slot - 1) * NODE_GAP + NODE_INSET_X * 2);
}

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
	const laneIndex = new Map(laneRows.map((k, i) => [k, i]));
	// 先统计每个「泳道 × 阶段」格子的节点数 —— 行高与格内偏移都依赖它
	const cellOf = nodes.map((n, i) => {
		const li = laneIndex.get(laneKeyOf(n));
		return li === undefined ? undefined : { li, s: stageOf(i) };
	});
	const cellCount = new Map<string, number>();
	for (const c of cellOf) {
		if (!c) continue;
		const k = `${c.li}|${c.s}`;
		cellCount.set(k, (cellCount.get(k) ?? 0) + 1);
	}
	const laneHs = laneRows.map((_, li) => {
		let slot = 1;
		for (let s = 0; s < STAGE_COUNT; s++) slot = Math.max(slot, cellCount.get(`${li}|${s}`) ?? 0);
		return laneHeight(slot);
	});
	// 行高不再固定 ⇒ y 必须**累加**，不能用 `li * LANE_H`
	const laneY = (li: number): number => HEAD_H + 12 + laneHs.slice(0, li).reduce((a, b) => a + b, 0);

	const groups: GroupBox[] = laneRows.map((key, li) => ({
		key,
		label: key,
		x: 8,
		y: laneY(li),
		w: W - 16,
		h: laneHs[li] - LANE_PAD,
	}));

	const irById = new Map(ir.nodes.map((n) => [n.id, n]));
	const placed: PlacedNode[] = [];
	const cellSeen = new Map<string, number>();
	nodes.forEach((n, i) => {
		const c = cellOf[i];
		if (!c) return;
		const { li, s } = c;
		// 格内序号 ⇒ 纵向错开（D3-1）。迁移前这里是恒 0 ⇒ 同格节点完全重叠。
		const k = `${li}|${s}`;
		const idxInCell = cellSeen.get(k) ?? 0;
		cellSeen.set(k, idxInCell + 1);
		const irn = irById.get(n.id);
		placed.push({
			id: n.id,
			x: LANE_LABEL_W + s * stageW + NODE_INSET_X,
			y: laneY(li) + NODE_INSET_X + idxInCell * (NODE_H + NODE_GAP),
			w: nodeW,
			h: NODE_H,
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

	// C1：流转箭头**只**来自 IR 的边，方向由 `edgeDirected` 决定。
	//   ⛔ 不再回落「按业务序相邻」—— 那等于宣称「画布顺序 = 流转顺序」，
	//   而 IR 里并没有这条事实（迁移前就是这个行为）。
	//   无向边仍然画连线，只是不带箭头。
	const ids = new Set(placed.map((p) => p.id));
	const edges: PlacedEdge[] = [];
	for (const e of ir.edges) {
		if (ids.has(e.source) && ids.has(e.target)) {
			edges.push({ source: e.source, target: e.target, directed: edgeDirected(ir, e) });
		}
	}

	return {
		width: W,
		// ⭐ 行高不再固定 ⇒ 总高必须**累加** `laneHs`，不能 `laneRows.length * LANE_H`
		height: HEAD_H + 24 + laneHs.reduce((a, b) => a + b, 0) + 30,
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