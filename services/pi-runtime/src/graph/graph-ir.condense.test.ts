import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { condenseLabel, graphIRFromGv, labelBudgetFor, labelWidth } from "./graph-ir.js";

/**
 * D3-2：文字提炼落地（节点身份标签不再靠渲染侧clip 截断）。
 *
 * ⭐⭐ 本轮修正了计划里的一个硬错误，值得记下来：
 * 计划 Task8 直接启用 `condenseLabel(…, LABEL_BUDGET=24)`，理由是「N8 禁止用截断
 * 代替提炼」。但 `LABEL_BUDGET=24` 单位宽 = 12 汉字，是**按 layout 的节点框宽**
 * （554px）定的，而各视图框宽差5 倍：
 *
 *   视图       框宽旧口径(汉字)  固定 24 单位(=12 汉字)  结果
 *   layout      554     45          12              **收紧 3.75 倍**
 *   tree        150     11          12              溢出（12 > 11）
 *   swimlane    112      8          12              **溢出 50%**
 *
 * 照计划执行会把承载 63 节点真实画布的主视图标签砍到 1/4，同时让窄框视图**溢出**。
 * ⇒ 改为**预算随框宽自适应**：`labelBudgetFor(boxWidth)`，且必须 ≤ 该框真能装的量。
 */

/**
 * 一个长度足以**超出 layout 预算（90 单位 = 45 汉字）**的标题 ⇒ 69 汉字 = 138 单位。
 *
 * ⚠️ 长度不是随便定的：必须 > 该视图预算，否则 `condenseLabel` 原样返回、
 *   `description` 也不写 ⇒ 测试会「因为数据不够长」而失败，测不到提炼逻辑。
 *   （我第一版写了 34 汉字 = 68 单位 < 90 预算，用例是假失败。）
 */
const LONG = "这".repeat(69);

test("R2：节点无 title 时 label 回落 id，且不是空串", () => {
	const ir = graphIRFromGv({
		view: "layout",
		relation: "category",
		nodes: [{ id: "n1" }],
		edges: [],
	});
	assert.equal(ir.nodes[0].label, "n1");
	assert.notEqual(ir.nodes[0].label, "");
});

test("超长标题：label 被提炼到预算内，原文完整保留在 description", () => {
	const budget = labelBudgetFor(554);
	const ir = graphIRFromGv({
		view: "layout",
		relation: "category",
		nodes: [{ id: "n1", title: LONG }],
		edges: [],
		labelBudget: budget,
	});
	assert.ok(labelWidth(ir.nodes[0].label) <= budget);
	assert.equal(ir.nodes[0].description, LONG);
});

test("⚠️ 不传 labelBudget ⇒ **不提炼**（显式的「框宽未知」语义，不是默认值）", () => {
	// 这条是API 陷阱，必须钉死：`labelBudget` 缺省走「原文」而不是 `LABEL_BUDGET`。
	// 若哪天有人改成「缺省 = LABEL_BUDGET」，layout 的长标题会被砍到 12 汉字
	// —— 正是 D3-2 要避免的退化，且**不报错**。
	const ir = graphIRFromGv({
		view: "layout",
		relation: "category",
		nodes: [{ id: "n1", title: LONG }],
		edges: [],
	});
	assert.equal(ir.nodes[0].label, LONG);
	assert.equal(ir.nodes[0].description, undefined);
});

test("⭐ 提炼只在超出**该框预算**时才发生：短标题原样保留", () => {
	// 「EP01」在 tree 的预算内 ⇒ 绝不能被提炼成「EP0…」（那是无意义的截断）
	const ir = graphIRFromGv({
		view: "tree",
		relation: "category",
		nodes: [{ id: "n1", title: "EP01" }],
		edges: [],
	});
	assert.equal(ir.nodes[0].label, "EP01");
	assert.equal(ir.nodes[0].description, undefined);
});

test("N8：节点身份标签不再被渲染侧 clip 截断", () => {
	const src = readFileSync(new URL("../tools/render-canvas-view.views.ts", import.meta.url), "utf8");
	// 只看 nodeRect —— 图例项 / 审计说明 / 矩阵行列头是**固定槽位装饰文本**，
	// 它们没有 description 可回落，超长就该截（N8 不管辖它们）。
	const nodeRectSrc = src.slice(src.indexOf("function nodeRect"), src.indexOf("\n}\n", src.indexOf("function nodeRect")));
	assert.equal(
		/\bclip\(/.test(nodeRectSrc),
		false,
		`nodeRect 仍在用 clip() 截断节点标签：\n${nodeRectSrc}`,
	);
	// 且必须真的用了提炼（不是把 clip 删了却不提炼）
	assert.match(nodeRectSrc, /condenseLabel\(/);
});

test("⛔ 装饰文本的 clip 必须保留（N8 不管辖它们，否则超长会溢出 viewBox）", () => {
	const src = readFileSync(new URL("../tools/render-canvas-view.views.ts", import.meta.url), "utf8");
	// 图例项 / 群组后缀 / 审计说明 / 矩阵行列头 —— 这些没有 description 回落
	assert.match(src, /clip\(suf, 16\)/);
	assert.match(src, /clip\(m\.title, 14\)/);
	assert.match(src, /clip\(r, 11\)/);
});