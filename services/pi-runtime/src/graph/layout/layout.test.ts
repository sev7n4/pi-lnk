import { strict as assert } from "node:assert";
import { test } from "node:test";
import { graphIRFromGv } from "../graph-ir.js";
import { layoutLayout } from "./layout.js";

function irOf(
	nodes: Array<{ id: string; title?: string; type?: string }>,
	relation: "dependency" | "category" = "dependency",
	edges: Array<{ source: string; target: string }> = [],
	scope?: "structure" | "ownership" | "detail",
) {
	return graphIRFromGv({ view: "layout", relation, nodes, edges, ...(scope ? { scope } : {}) });
}

test("R1：单节点不除零，坐标全部有限", () => {
	const l = layoutLayout(irOf([{ id: "n1", title: "只有一个" }]));
	assert.equal(l.nodes.length, 1);
	for (const n of l.nodes) {
		assert.equal(Number.isFinite(n.x), true);
		assert.equal(Number.isFinite(n.y), true);
		assert.ok(n.w > 0 && n.h > 0, `w/h 必须为正：${n.w}×${n.h}`);
	}
});

test("R1：零节点不抛错，宽高是有限值而不是 NaN", () => {
	const l = layoutLayout(irOf([]));
	assert.equal(l.nodes.length, 0);
	assert.equal(Number.isNaN(l.width), false);
	assert.equal(Number.isNaN(l.height), false);
});

test("R3：label 含 & 与 <script> 时原样进 label（转义属渲染层职责，布局层不得提前破坏）", () => {
	const raw = "a & b <script>alert(1)</script>";
	const l = layoutLayout(irOf([{ id: "n1", title: raw }]));
	assert.equal(l.nodes[0].label, raw);
});

test("C1：relation=category 时**不画边**（无向 ⇒ 自然不会有箭头）", () => {
	// 既有设计：category 下画边会与 dependency 混同 ⇒ 一条都不画。
	// 「无向关系不得带箭头」在这里以「不产出边」的形式满足。
	const l = layoutLayout(
		irOf([{ id: "n1" }, { id: "n2" }], "category", [{ source: "n1", target: "n2" }]),
	);
	assert.equal(l.edges.length, 0);
	assert.equal(l.edges.every((e) => e.directed === false), true);
});

test("C1：relation=dependency 时边是有向的", () => {
	// scope=detail（全量）：默认 scope=structure 会按两端类型裁边，
	// 无 type 的节点对会被裁掉 —— 那条规则与方向无关，别让它干扰本用例。
	const l = layoutLayout(
		irOf([{ id: "n1" }, { id: "n2" }], "dependency", [{ source: "n1", target: "n2" }], "detail"),
	);
	assert.equal(l.edges.length, 1);
	assert.equal(l.edges[0].directed, true);
});

test("节点顺序、seq 与行 y 一致（布局产出的顺序就是绘制顺序）", () => {
	const l = layoutLayout(irOf([{ id: "a" }, { id: "b" }, { id: "c" }]));
	assert.deepEqual(
		l.nodes.map((n) => n.id),
		["a", "b", "c"],
	);
	assert.deepEqual(
		l.nodes.map((n) => n.seq),
		[1, 2, 3],
	);
	assert.ok(l.nodes[1].y > l.nodes[0].y);
	assert.ok(l.nodes[2].y > l.nodes[1].y);
});

test("端点不在图内的边被丢弃（不编造）", () => {
	const l = layoutLayout(irOf([{ id: "n1" }], "dependency", [{ source: "n1", target: "不存在" }]));
	assert.equal(l.edges.length, 0);
});
