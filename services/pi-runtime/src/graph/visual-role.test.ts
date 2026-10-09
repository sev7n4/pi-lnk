import { strict as assert } from "node:assert";
import { test } from "node:test";
import { graphIRFromGv } from "./graph-ir.js";
import { ACCENT_MAX_RATIO, visualRoles } from "./visual-role.js";

/**
 * mark 通道 + 视觉角色。
 *
 * ⭐ 本文件的存在前提：`GraphIRNode.mark` **有真实输入**（`overlay.kind=severity`
 * 经 `graphIRFromGv({ marks })` 写入）。通道没接通时 `visualRoles` 恒返回
 * `muted`，写它就是死代码 —— 所以第一条测的是通道本身。
 */

function irWith(marks: Record<string, { kind: string; level: number }>, n = 10) {
	return graphIRFromGv({
		view: "layout",
		relation: "dependency",
		nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `节点 ${i}`, type: "a" })),
		edges: [],
		marks,
	});
}

test("阈值本身：ACCENT_MAX_RATIO = 0.1（业界共识，不是计划的 20%）", () => {
	assert.equal(ACCENT_MAX_RATIO, 0.1);
});

test("通道：marks 写进 IR 节点的 mark，没有条目的节点没有 mark", () => {
	const ir = irWith({ n3: { kind: "severity", level: 2 } });
	assert.deepEqual(ir.nodes[3].mark, { kind: "severity", level: 2 });
	assert.equal(ir.nodes[0].mark, undefined);
});

test("R5：全部节点都带 mark 时，强调色仍 ≤ 总数 10%", () => {
	const ir = irWith(
		Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}`, { kind: "severity", level: i }])),
		10,
	);
	const roles = visualRoles(ir);
	const accent = [...roles.values()].filter((r) => r === "accent").length;
	// ⭐ 字面量：ceil(10 * 0.1) = 1
	assert.equal(accent, 1);
	// 最高的那个被选中
	assert.equal(roles.get("n9"), "accent");
});

test("26 节点全标 ⇒ 只强调 3 个（ceil(26*0.1)）", () => {
	const ir = irWith(
		Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`n${i}`, { kind: "severity", level: 1 }])),
		26,
	);
	const accent = [...visualRoles(ir).values()].filter((r) => r === "accent").length;
	assert.equal(accent, 3);
});

test("mark 缺失 ⇒ 回落点缀色 primary，不是 accent（无标注就没有重点可言）", () => {
	const ir = irWith({});
	assert.equal(visualRoles(ir).get("n0"), "primary");
	assert.equal([...visualRoles(ir).values()].filter((r) => r === "accent").length, 0);
});

test("既无 mark 又无 type ⇒ muted（最弱一级）", () => {
	const ir = graphIRFromGv({
		view: "layout",
		relation: "category",
		nodes: [{ id: "n0", title: "无类型" }],
		edges: [],
	});
	assert.equal(visualRoles(ir).get("n0"), "muted");
});

test("level = 0 不算标注（有 mark 但不该被强调）", () => {
	const ir = irWith({ n0: { kind: "severity", level: 0 } });
	assert.equal(visualRoles(ir).get("n0"), "primary");
	assert.equal([...visualRoles(ir).values()].filter((r) => r === "accent").length, 0);
});

test("按 level 降序取，不是按 id 或输入顺序", () => {
	const ir = irWith(
		{ n0: { kind: "severity", level: 1 }, n5: { kind: "severity", level: 9 }, n7: { kind: "severity", level: 5 } },
		10,
	);
	const roles = visualRoles(ir);
	assert.equal(roles.get("n5"), "accent");
	assert.equal(roles.get("n7"), "primary");
	assert.equal(roles.get("n0"), "primary");
});

test("只有 1 个节点带 mark ⇒ 它就是唯一被强调的（cap 至少 1）", () => {
	const ir = irWith({ n2: { kind: "severity", level: 1 } }, 26);
	const roles = visualRoles(ir);
	assert.equal(roles.get("n2"), "accent");
	assert.equal([...roles.values()].filter((r) => r === "accent").length, 1);
});

test("R1：空图不抛错，返回空 Map", () => {
	const ir = graphIRFromGv({ view: "layout", relation: "category", nodes: [], edges: [] });
	assert.equal(visualRoles(ir).size, 0);
});

test("角色覆盖每个节点（不多不少）", () => {
	const ir = irWith({ n1: { kind: "severity", level: 3 } }, 7);
	const roles = visualRoles(ir);
	assert.equal(roles.size, 7);
	assert.deepEqual([...roles.keys()].sort(), ir.nodes.map((n) => n.id).sort());
});
