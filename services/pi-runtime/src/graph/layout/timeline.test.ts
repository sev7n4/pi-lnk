import { strict as assert } from "node:assert";
import { test } from "node:test";
import { graphIRFromGv } from "../graph-ir.js";
import { ROW_H } from "./types.js";
import { layoutTimelineFlow } from "./timeline.js";

test("timeline：节点按业务序纵向排列，y 单调递增", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({ view: "timeline", relation: "category", nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }], edges: [] }),
	);
	assert.equal(l.nodes.length, 3);
	assert.ok(l.nodes[1].y > l.nodes[0].y);
	assert.ok(l.nodes[2].y > l.nodes[1].y);
	assert.equal(l.nodes[1].y - l.nodes[0].y, ROW_H);
	// ⭐ 绝对 y 也要断言：只查「行间距」的话，整列一起下移 1px 是等价变异、测不出来。
	assert.deepEqual(
		l.nodes.map((n) => n.y),
		[30, 30 + ROW_H, 30 + 2 * ROW_H],
	);
});

test("timeline：按业务序号排，不按传入顺序（EP10 必须排在 EP05 之后）", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({
			view: "timeline",
			relation: "category",
			nodes: [
				{ id: "a", title: "EP10" },
				{ id: "b", title: "EP05" },
				{ id: "c", title: "EP02" },
			],
			edges: [],
		}),
	);
	// ⭐ 必须按**数值**比较：`EP02<EP10<EP05` 在字符串序下成立但业务上错。
	assert.deepEqual(
		l.nodes.map((n) => n.id),
		["c", "b", "a"],
	);
});

test("R1：零节点的 timeline 高度为有限值（不得 NaN）", () => {
	const l = layoutTimelineFlow(graphIRFromGv({ view: "timeline", relation: "category", nodes: [], edges: [] }));
	assert.equal(Number.isFinite(l.height), true);
	assert.equal(l.nodes.length, 0);
});

test("R1：单节点的 timeline 高度有限且不为 0", () => {
	const l = layoutTimelineFlow(graphIRFromGv({ view: "timeline", relation: "category", nodes: [{ id: "only" }], edges: [] }));
	assert.equal(Number.isFinite(l.height), true);
	assert.ok(l.height > 0);
});

test("C1：trunk 只串 IR 里真实存在的有向边，不按相邻行自作主张", () => {
	// ⭐ D2 遗留的反例：3 个节点只给a→b 一条边，现状仍串两段（row 1、row 2），
	//   等于宣称「b→c 也是流转关系」—— 而 IR 里并没有这条事实。
	//   Task 9 起方向来自 IR：只有 a→b 有 ⇒ 只有 row 1 一段，且 row 2 不存在。
	const l = layoutTimelineFlow(
		graphIRFromGv({
			view: "timeline",
			relation: "dependency",
			nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
			edges: [{ source: "a", target: "b" }],
		}),
	);
	assert.deepEqual(
		l.trunks!.map((t) => t.row),
		[1],
	);
	assert.equal(l.trunks![0].directed, true);
});

test("C1：category 关系下 timeline 不带箭头（无向关系不得画箭头）", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({
			view: "timeline",
			relation: "category",
			nodes: [{ id: "a" }, { id: "b" }],
			edges: [{ source: "a", target: "b" }],
		}),
	);
	// 线还在（顺序仍表达），只是没有方向
	assert.equal(l.trunks!.length, 1);
	assert.equal(l.trunks![0].directed, false);
});

test("C1：没有边就没有 trunk（不再按相邻行兜底）", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({ view: "timeline", relation: "dependency", nodes: [{ id: "a" }, { id: "b" }], edges: [] }),
	);
	assert.deepEqual(l.trunks, []);
});

test("单节点 / 零节点不产生 trunk（否则会有一段指向虚空的箭头）", () => {
	const one = layoutTimelineFlow(
		graphIRFromGv({ view: "timeline", relation: "category", nodes: [{ id: "a" }], edges: [] }),
	);
	assert.equal(one.trunks!.length, 0);
	const zero = layoutTimelineFlow(graphIRFromGv({ view: "timeline", relation: "category", nodes: [], edges: [] }));
	assert.equal(zero.trunks!.length, 0);
});

test("trunk 竖线固定落在绘图区左侧 16px、半径 6px（渲染层不该重算这两个数）", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({
			view: "timeline",
			relation: "dependency",
			nodes: [{ id: "a" }, { id: "b" }],
			// ⭐ C1 起 trunk 只由边产生 ⇒ 几何用例也必须给边，否则测的是「空数组」
			edges: [{ source: "a", target: "b" }],
		}),
	);
	const t = l.trunks![0];
	assert.equal(t.x, 16);
	assert.equal(t.yBottom - t.yTop, 6);
	// 起点是本行框底部（y+20），终点是下一行框顶部（y+ROW_H）
	const byId = new Map(l.nodes.map((n) => [n.id, n]));
	assert.equal(t.yTop, byId.get("a")!.y + 20);
	assert.equal(t.yBottom, byId.get("b")!.y);
});

test("flatOrder 存在（图例吃平铺序，不是行序）", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({ view: "timeline", relation: "category", nodes: [{ id: "a" }, { id: "b" }], edges: [] }),
	);
	assert.deepEqual(l.flatOrder, ["a", "b"]);
});

test("row 从 0 起、seq 从 1 起连续（渲染层用 seq 画圈号）", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({ view: "timeline", relation: "category", nodes: [{ id: "a" }, { id: "b" }], edges: [] }),
	);
	assert.deepEqual(
		l.nodes.map((n) => [n.row, n.seq]),
		[
			[0, 1],
			[1, 2],
		],
	);
});

test("高度公式固定：40 + 行数*ROW_H + 34（图例位置依赖它）", () => {
	const mk = (k: number) =>
		layoutTimelineFlow(
			graphIRFromGv({
				view: "timeline",
				relation: "category",
				nodes: Array.from({ length: k }, (_, i) => ({ id: `n${i}` })),
				edges: [],
			}),
		);
	assert.equal(mk(0).height, 40 + 0 + 34);
	assert.equal(mk(3).height, 40 + 3 * ROW_H + 34);
});

test("type / colors 透传（配色是按 type 取的，IR 丢了就画不出多色）", () => {
	const l = layoutTimelineFlow(
		graphIRFromGv({
			view: "timeline",
			relation: "category",
			nodes: [
				{ id: "a", type: "prompt", title: "甲" },
				{ id: "b", type: "image", title: "乙" },
			],
			edges: [],
			colors: { b: "#00FF00" },
		}),
	);
	assert.equal(l.nodes.find((n) => n.id === "a")!.type, "prompt");
	assert.equal(l.nodes.find((n) => n.id === "b")!.color, "#00FF00");
});