import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LABEL_BUDGET, condenseLabel, graphIRFromGv, isGraphView, labelWidth, resolveView } from "./graph-ir.js";

test("resolveView：topology 归一到 layout（legacy 不双计）", () => {
	assert.equal(resolveView("topology"), "layout");
	assert.equal(resolveView("layout"), "layout");
});

test("resolveView：table 保持行级视图，未知取值返回 undefined", () => {
	assert.equal(resolveView("table"), "table");
	assert.equal(isGraphView("table"), false);
	assert.equal(resolveView("nonsense"), undefined);
});

test("resolveView：topology 与 layout 产出同一 view（v1 Review Focus #4）", () => {
	assert.equal(resolveView("topology"), resolveView("layout"));
});

test("labelWidth：1 汉字 = 2 单位，1 拉丁 = 1 单位", () => {
	assert.equal(labelWidth("镜头"), 4);
	assert.equal(labelWidth("abcd"), 4);
	assert.equal(labelWidth("镜a"), 3);
});

test("condenseLabel：13 汉字压到预算内并加省略号", () => {
	// 预算 24 单位，省略号本身占 1 ⇒ 内容上限 23 单位 ⇒ 汉字 11 个（22 单位）。
	// 规格的「≤ 12 汉字」对**不需要截断**的标签成立（12×2 = 24 正好等于预算）；
	// 一旦要截断就得给省略号留位，否则总宽会超出预算 —— 那正是「溢出」的来源。
	const s = "一二三四五六七八九十甲乙丙丁";
	const out = condenseLabel(s);
	assert.equal(out, "一二三四五六七八九十甲…");
	assert.equal(labelWidth(out) <= LABEL_BUDGET, true);
});

test("condenseLabel：25 个拉丁字符压到 24 单位（23 字符 + 省略号）", () => {
	const s = "abcdefghijklmnopqrstuvwxy";
	const out = condenseLabel(s);
	assert.equal(out, "abcdefghijklmnopqrstuvw…".slice(0, 23) + "…");
	assert.equal(labelWidth(out), LABEL_BUDGET);
});

test("condenseLabel：12 个汉字不截断（正好等于预算）", () => {
	const s = "一二三四五六七八九十甲乙";
	assert.equal(condenseLabel(s), s);
	assert.equal(labelWidth(s), LABEL_BUDGET);
});

test("condenseLabel：预算内不动、空串返回空串", () => {
	assert.equal(condenseLabel("镜头一"), "镜头一");
	assert.equal(condenseLabel(""), "");
});

test("condenseLabel：先去掉首尾空白再计量（避免空格吃掉预算）", () => {
	assert.equal(condenseLabel("  镜头一  "), "镜头一");
});

test("graphIRFromGv：本阶段不提炼（label 原样），D2 逐字节不变的前提", () => {
	const ir = graphIRFromGv({ view: "layout", relation: "dependency", nodes: [{ id: "n1", title: "镜头 1" }], edges: [] });
	assert.equal(ir.nodes[0].label, "镜头 1");
	assert.equal(labelWidth(ir.nodes[0].label) <= LABEL_BUDGET, true);
});

test("graphIRFromGv：relation=category 时边的 kind 是 category（C1：方向由 IR 决定）", () => {
	const ir = graphIRFromGv({
		view: "layout",
		relation: "category",
		nodes: [{ id: "a" }, { id: "b" }],
		edges: [{ source: "a", target: "b" }],
	});
	assert.equal(ir.edges[0].kind, "category");
});
