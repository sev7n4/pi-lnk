import { strict as assert } from "node:assert";
import { test } from "node:test";
import { graphIRFromGv } from "../graph-ir.js";
import { LANE_H, LANE_LABEL_W, STAGE_COUNT, laneHeight, layoutSwimlane } from "./swimlane.js";

const MIX = [
	{ id: "a", type: "prompt", title: "甲" },
	{ id: "b", type: "prompt", title: "乙" },
	{ id: "c", type: "image", title: "丙" },
];

test("泳道行序：按 type 分组，组序用业务序（无序号时回落首次出现）", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [], groupBy: "type" }),
	);
	assert.deepEqual(
		l.groups.map((g) => g.key),
		["prompt", "image"],
	);
});

test("阶段列：固定 5 列，节点 x 按阶段落位（同阶段的 x 相同）", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [], groupBy: "type" }),
	);
	assert.equal(STAGE_COUNT, 5);
	// 阶段按**下标均分**：`floor(i/3 * 5)` ⇒ i=0→0、i=1→1、i=2→3 ⇒ 3 个不同阶段
	assert.deepEqual(
		l.nodes.map((n) => n.stage),
		[0, 1, 3],
	);
	assert.equal(new Set(l.nodes.map((n) => n.x)).size, 3);
	// x 严格随阶段递增
	const byStage = [...l.nodes].sort((a, b) => a.stage! - b.stage!);
	assert.equal(byStage[0].x < byStage[1].x && byStage[1].x < byStage[2].x, true);
	// ⭐ 泳道**背景框**横跨全宽（从 x=8 起），只有节点框在标签带右侧
	assert.equal(l.groups[0].x, 8);
	assert.equal(l.groups[0].w, 720 - 16);
	assert.equal(byStage[0].x >= LANE_LABEL_W, true);
	// ⭐ 节点框宽 = 阶段宽 − 14（两侧各留 7）。用字面量断言，别用 stageW 自证。
	assert.equal(l.stageW, (720 - 74 - 16) / 5);
	for (const n of l.nodes) assert.equal(n.w, 126 - 14);
});

test("节点 y 按泳道行累加（同泳道同y，跨泳道差一个泳道高）", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [], groupBy: "type" }),
	);
	const byLane = new Map(l.nodes.map((n) => [n.id, n]));
	const inPrompt = [byLane.get("a")!, byLane.get("b")!];
	const inImage = byLane.get("c")!;
	// 同泳道内 idxInLane * 0 ⇒ 全部重叠在同一 y（迁移前就是这个行为）
	assert.equal(inPrompt[0].y, inPrompt[1].y);
	// ⭐ 差值用**字面量**而不是 LANE_H 常量：写 `LANE_H` 就是拿被测对象验自己，
	//   常量一改测试跟着改，永远绿。
	assert.equal(inImage.y - inPrompt[0].y, 46);
	assert.equal(LANE_H, 46);
	// ⭐ 绝对 y 也要断言：只测「行间距」的话整列一起下移是等价变异、测不出来。
	assert.equal(inPrompt[0].y, 26 + 12 + 6);
	assert.equal(inImage.y, 26 + 12 + 46 + 6);
});

test("R1：零节点的 swimlane 高度有限（不得 NaN），泳道为空", () => {
	const l = layoutSwimlane(graphIRFromGv({ view: "swimlane", relation: "category", nodes: [], edges: [] }));
	assert.equal(Number.isFinite(l.height), true);
	assert.equal(l.groups.length, 0);
	assert.equal(l.nodes.length, 0);
});

test("R1：单节点的 swimlane 坐标有限", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: [{ id: "only" }], edges: [] }),
	);
	assert.equal(Number.isFinite(l.height), true);
	assert.equal(Number.isFinite(l.nodes[0].x), true);
	assert.equal(Number.isFinite(l.nodes[0].y), true);
	assert.ok(l.height > 0);
});

test("C1：显式边照画，且没有「按业务序相邻」的兜底", () => {
	const withEdge = layoutSwimlane(
		graphIRFromGv({
			view: "swimlane",
			relation: "dependency",
			nodes: MIX,
			edges: [{ source: "a", target: "c" }],
			groupBy: "type",
		}),
	);
	assert.deepEqual(
		withEdge.edges.map((e) => [e.source, e.target]),
		[["a", "c"]],
	);
	assert.equal(withEdge.edges[0].directed, true);
	// ⭐ 无边 ⇒ **一条都不画**。D2 之前会回落成 a→b、b→c 两段，
	//   等于宣称「画布顺序 = 流转顺序」—— IR 里并没有这条事实（C1 反例）。
	const noEdge = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "dependency", nodes: MIX, edges: [], groupBy: "type" }),
	);
	assert.deepEqual(noEdge.edges, []);
});

test("C1：category 关系下 swimlane 的边不画箭头", () => {
	const l = layoutSwimlane(
		graphIRFromGv({
			view: "swimlane",
			relation: "category",
			nodes: MIX,
			edges: [{ source: "a", target: "c" }],
			groupBy: "type",
		}),
	);
	assert.equal(l.edges.length, 1);
	assert.equal(l.edges[0].directed, false);
});

test("端点不存在的边被丢弃（不编造节点），且不因此触发兜底", () => {
	const l = layoutSwimlane(
		graphIRFromGv({
			view: "swimlane",
			relation: "dependency",
			nodes: MIX,
			edges: [{ source: "a", target: "ghost" }],
			groupBy: "type",
		}),
	);
	// ⭐ 过滤后剩 0 条可用边。D2 之前这会走 fallback 串 a→b、b→c；
	//   Task 9 起必须**保持为空** —— 「边端点不存在」不等于「这些节点按序相连」。
	assert.deepEqual(l.edges, []);
});

test("groupBy=status 时泳道按 status 分（不是 type）", () => {
	const l = layoutSwimlane({
		view: "swimlane",
		relation: "category",
		nodes: [
			{ id: "a", type: "prompt", status: "done", label: "甲", sourceKind: "canvas" },
			{ id: "b", type: "image", status: "todo", label: "乙", sourceKind: "canvas" },
		],
		edges: [],
		groupBy: "status",
	});
	assert.deepEqual(
		l.groups.map((g) => g.key).sort(),
		["done", "todo"],
	);
});

test("groupBy 缺省时按 type 分（迁移前调用点传的就是 groupBy ?? type）", () => {
	const l = layoutSwimlane(graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [] }));
	assert.deepEqual(
		l.groups.map((g) => g.key),
		["prompt", "image"],
	);
});

test("节点带groupKey（渲染层画泳道边界与 data-group 用，不重新推导）", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [], groupBy: "type" }),
	);
	const byId = new Map(l.nodes.map((n) => [n.id, n]));
	assert.equal(byId.get("a")!.groupKey, "prompt");
	assert.equal(byId.get("c")!.groupKey, "image");
});

test("高度公式固定：headH + 24 + 泳道数*laneH + 30（阶段列头位置依赖它）", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [], groupBy: "type" }),
	);
	// ⭐ 同样用字面量，别用 LANE_H 自证
	assert.equal(l.height, 26 + 24 + 2 * 46 + 30);
});

test("泳道 y 与首个节点 y 差 6px（背景框比节点框高 6）", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [], groupBy: "type" }),
	);
	const first = l.groups[0];
	const inFirst = l.nodes.find((n) => n.groupKey === first.key)!;
	assert.equal(inFirst.y - first.y, 6);
	assert.equal(first.h, 40);
});

test("flatOrder 存在（图例吃平铺序，不是节点行序）", () => {
	const l = layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MIX, edges: [], groupBy: "type" }),
	);
	assert.equal(l.flatOrder!.length, 3);
	assert.equal(new Set(l.flatOrder).size, 3);
});

// ══════════════════════════════════════════════════════════
// D3-1：同格纵向错开（修复「26 个节点只露出 10 个位置」）
// ══════════════════════════════════════════════════════════

/** 26 个节点：2 种 type（a 9 个 / b 17 个），下标均分到 5 个阶段。 */
const MANY = Array.from({ length: 26 }, (_, i) => ({
	id: `n${i}`,
	title: `节点 ${i}`,
	type: i % 3 === 0 ? "a" : "b",
}));

function manyLaid() {
	return layoutSwimlane(
		graphIRFromGv({ view: "swimlane", relation: "category", nodes: MANY, edges: [], groupBy: "type" }),
	);
}

test("D3-1：laneHeight 单节点/格仍是 46（⇐ 与迁移前逐字节一致的前提）", () => {
	// ⭐ 用字面量：slot=1 算出 32，被下限 46 兜住 ⇒ 小画布的行高、y、总高都不变
	assert.equal(laneHeight(1), 46);
	assert.equal(laneHeight(0), 46);
	assert.equal(laneHeight(2), 2 * 20 + 1 * 4 + 12);
	assert.equal(laneHeight(4), 4 * 20 + 3 * 4 + 12);
});

test("D3-1：同泳道同阶段的节点纵向错开 24px（20 高 + 4 间隙）", () => {
	const l = manyLaid();
	const byId = new Map(l.nodes.map((n) => [n.id, n]));
	// 泳道 a 的前两个节点（i=0 / i=3）同落阶段 0
	const a0 = byId.get("n0")!;
	const a3 = byId.get("n3")!;
	assert.equal(a0.stage, a3.stage);
	assert.equal(a3.y - a0.y, 24);
	// x 相同（同阶段）⇒ 错开只能靠 y
	assert.equal(a3.x, a0.x);
});

test("D3-1：26 个节点占 26 个不同的位置（修复前只有 10 个）", () => {
	const l = manyLaid();
	assert.equal(l.nodes.length, 26);
	const spots = new Set(l.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
	assert.equal(spots.size, 26);
});

test("D3-1：错开后节点仍在自己的泳道框内，不越界压到下一泳道", () => {
	const l = manyLaid();
	for (const g of l.groups) {
		const inLane = l.nodes.filter((n) => n.groupKey === g.key);
		for (const n of inLane) {
			assert.ok(n.y >= g.y, `${n.id} 顶部越出泳道 ${g.key}`);
			assert.ok(n.y + n.h <= g.y + g.h, `${n.id} 底部越出泳道 ${g.key}`);
		}
	}
	// 相邻泳道之间不留负间隙
	const sorted = [...l.groups].sort((a, b) => a.y - b.y);
	for (let i = 1; i < sorted.length; i++) {
		assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h, "泳道之间出现重叠");
	}
});

test("D3-1：总高改为累加各行高（a 泳道最大 2 格 / b 泳道最大 4 格）", () => {
	const l = manyLaid();
	// ⭐ 字面量：26(head) + 24 + [56, 104] + 30
	assert.equal(l.height, 26 + 24 + 56 + 104 + 30);
	// 第二条泳道的起点 = 第一条泳道结束（不再是 li * 46）
	assert.equal(l.groups[1].y - l.groups[0].y, 56);
	// ⭐ 绝对 y 也要断言：只测差值的话「整列一起下移」是等价变异、测不出来
	assert.equal(l.nodes.find((n) => n.groupKey === "a")!.y, 26 + 12 + 6);
	assert.equal(l.nodes.find((n) => n.groupKey === "b")!.y, 26 + 12 + 56 + 6);
});

test("D3-1：只动 y，节点集合与顺序不变", () => {
	const l = manyLaid();
	assert.deepEqual(
		l.nodes.map((n) => n.id),
		MANY.map((n) => n.id),
	);
	assert.equal(l.flatOrder!.length, 26);
});