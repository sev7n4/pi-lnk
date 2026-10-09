import { strict as assert } from "node:assert";
import { test } from "node:test";
import { graphIRFromGv } from "../graph-ir.js";
import { layoutTree, TREE_DEPTH_W, TREE_INDENT } from "./tree.js";

test("根节点判定看入边：无 parentNode 但指向别人的节点排在根层第一位", () => {
	// ⭐ 回归用例：判据若只看 `parentNode`，「大纲」会被当成叶子排到 EP 后面
	//   （第一版实测 bug）。这里断言的是**行序**，不是坐标。
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [
				{ id: "outline" },
				{ id: "ep01", parentNode: "outline" },
				{ id: "ep02", parentNode: "outline" },
			],
			edges: [
				{ source: "outline", target: "ep01" },
				{ source: "outline", target: "ep02" },
			],
		}),
	);
	assert.equal(l.nodes[0].id, "outline");
	assert.equal(l.nodes[0].depth, 0);
});

test("层级缩进：depth 决定 x，缩进步长是 TREE_INDENT", () => {
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [
				{ id: "root" },
				{ id: "kid", parentNode: "root" },
				{ id: "grand", parentNode: "kid" },
			],
			edges: [],
		}),
	);
	const by = new Map(l.nodes.map((n) => [n.id, n]));
	assert.equal(by.get("root")!.depth, 0);
	assert.equal(by.get("kid")!.depth, 1);
	assert.equal(by.get("grand")!.depth, 2);
	assert.equal(by.get("kid")!.x - by.get("root")!.x, TREE_INDENT);
	assert.equal(by.get("kid")!.w, TREE_DEPTH_W);
});

test("子树按业务序排，不按画布 y（画布放错不该改剧情顺序）", () => {
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [
				{ id: "root", title: "大纲" },
				// 画布上EP05 在 EP04 上面（y 更小），业务序上 EP04 在前
				{ id: "a", title: "EP05", parentNode: "root", position: { x: 0, y: 100 } },
				{ id: "b", title: "EP04", parentNode: "root", position: { x: 0, y: 200 } },
			],
			edges: [],
		}),
	);
	assert.deepEqual(
		l.nodes.map((n) => n.id),
		["root", "b", "a"],
	);
});

test("根层三段排序：有子节点的层级根 → 有序号的叶子 → 无序号的叶子（回落画布位置）", () => {
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [
				{ id: "leafOrd2", title: "EP02", position: { x: 0, y: 900 } },
				{ id: "leafNoOrdB", title: "无序号乙", position: { x: 0, y: 500 } },
				{ id: "leafOrd1", title: "EP01", position: { x: 0, y: 800 } },
				{ id: "leafNoOrdA", title: "无序号甲", position: { x: 0, y: 100 } },
				{ id: "hier", title: "全劇大綱" },
				{ id: "underHier", parentNode: "hier" },
			],
			edges: [],
		}),
	);
	assert.deepEqual(
		l.nodes.map((n) => n.id),
		["hier", "underHier", "leafOrd1", "leafOrd2", "leafNoOrdA", "leafNoOrdB"],
	);
});

test("三段互斥：每个根层节点恰好进一个段（否则 rootsFinal 会重复，walk 的 seen 会静默吞掉）", () => {
	//⚠️ 这条是上一条的**前提**：变异把 `leavesNoOrd` 放宽成「所有非层级根」时，
	//   行序看起来不变（重复项被 `seen` 去重），快照也照样绿 —— 是个等价变异。
	//   只有断言「id 唯一 + 全部节点都在」才抓得住这类悄悄劣化。
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [
				{ id: "hier", title: "大纲" },
				{ id: "k1", parentNode: "hier" },
				{ id: "ordOnly", title: "EP01", position: { x: 0, y: 300 } },
				{ id: "noOrdOnly", title: "无序号", position: { x: 0, y: 100 } },
			],
			edges: [],
		}),
	);
	const ids = l.nodes.map((n) => n.id);
	assert.equal(new Set(ids).size, ids.length, `出现重复节点：${ids.join(",")}`);
	assert.equal(ids.length, 4);
});

test("孤儿节点：parentNode 成环时排到末尾分隔区并标 orphan", () => {
	// ⭐ 孤儿**只能**由 `parentNode` 成环产生：只要父节点存在且自身可达，
	//   DFS 就一定能走到它（无父无子的节点是根层，不是孤儿）。
	//所以这里必须用互相 parentNode 的环，而不是「孤立节点」—— 后者测的是根层。
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [{ id: "a", parentNode: "b" }, { id: "b", parentNode: "a" }, { id: "normal" }],
			edges: [],
		}),
	);
	const ids = l.nodes.map((n) => n.id);
	assert.equal(ids.length, 3);
	// normal 走根层；成环的两个进孤儿区，排在末尾
	assert.equal(ids[0], "normal");
	assert.equal(l.nodes.filter((n) => n.orphan === true).length, 2);
	assert.equal(l.nodes[1].orphan, true);
	assert.equal(l.nodes[2].orphan, true);
	// 孤儿区高度要留出来，否则分隔线会压在最后一个节点上
	assert.equal(l.height, 40 + 3 * 26 + 24 + 24);
});

test("自环不产生子节点（否则根层判定会被自己绑架）", () => {
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [{ id: "a" }, { id: "b" }],
			edges: [
				{ source: "a", target: "a" },
				{ source: "a", target: "b" },
			],
		}),
	);
	assert.equal(l.nodes[0].id, "a");
	assert.equal(l.nodes[1].id, "b");
	assert.equal(l.nodes[1].depth, 1);
});

test("环保护：互相指向的两个节点不会死循环也不会重复", () => {
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [{ id: "a" }, { id: "b" }],
			edges: [
				{ source: "a", target: "b" },
				{ source: "b", target: "a" },
			],
		}),
	);
	assert.equal(l.nodes.length, 2);
	assert.equal(new Set(l.nodes.map((n) => n.id)).size, 2);
});

test("R1：单节点的树不抛错、坐标有限", () => {
	const l = layoutTree(graphIRFromGv({ view: "tree", relation: "category", nodes: [{ id: "only" }], edges: [] }));
	assert.equal(l.nodes.length, 1);
	assert.equal(Number.isFinite(l.nodes[0].x), true);
	assert.equal(Number.isFinite(l.height), true);
});

test("R1：零节点的树高度有限（不得 NaN）", () => {
	const l = layoutTree(graphIRFromGv({ view: "tree", relation: "category", nodes: [], edges: [] }));
	assert.equal(l.nodes.length, 0);
	assert.equal(Number.isFinite(l.height), true);
});

test("C1：tree 的父子连线是有向的（containment 语义 ⇒ 箭头由 IR 决定，不由渲染层猜）", () => {
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [{ id: "root" }, { id: "kid", parentNode: "root" }],
			edges: [],
		}),
	);
	// tree 的 trunk 是「渲染期按 depth 现连」的，不是从 edges 派生的 ⇒ 这里给不出 edges
	assert.equal(l.edges.length, 0);
	// 但 trunk 必须由布局层提供，而不是渲染层自己数 depth
	assert.equal(l.trunks!.length, 1);
	assert.equal(l.trunks![0].directed, true);
});

test("trunk 横臂从竖线 x 向右伸 8px，终点正好抵住子节点框左边缘", () => {
	// ⭐ 这两个数都参与**视觉正确性**：横臂短了箭头就够不到框，长了会穿进框里。
	//   竖线 x = 层 x − TRUNK_GAP（10），框左边缘 = 层 x ⇒ 横臂必须正好补上这 10px。
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [{ id: "root" }, { id: "kid", parentNode: "root" }],
			edges: [],
		}),
	);
	const by = new Map(l.nodes.map((n) => [n.id, n]));
	const t = l.trunks![0];
	const kidX = by.get("kid")!.x;
	assert.equal(t.x, kidX - 10);
	assert.equal(t.armTo, t.x + 8);
	assert.equal(Number.isFinite(t.yTop), true);
	assert.equal(Number.isFinite(t.yBottom), true);
});

test("colors 从 IR 透传到布局产物（渲染层直接消费，不重新推导）", () => {
	const l = layoutTree(
		graphIRFromGv({
			view: "tree",
			relation: "category",
			nodes: [
				{ id: "a", type: "outline", title: "甲" },
				{ id: "b", type: "ep", title: "乙" },
			],
			edges: [{ source: "a", target: "b" }],
			colors: { a: "#FF0000" },
		}),
	);
	// ⛔ 此处原有一条 `assert.equal(l.showType, false)`，随 `show_type` 参数删除而移除
	//   （2026-10-09）：该参数从未真正生效，删它对布局产物**零**影响。
	//   保留 colors 与 type 的断言 —— 它们才是这条测试真正的覆盖面。
	assert.equal(l.colors!["a"], "#FF0000");
	assert.equal(l.nodes.find((n) => n.id === "a")!.color, "#FF0000");
	assert.equal(l.nodes.find((n) => n.id === "b")!.type, "ep");
});