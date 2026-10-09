import assert from "node:assert/strict";
import test from "node:test";

import { LABEL_BUDGET, condenseLabel, labelBudgetFor, labelWidth } from "./graph-ir.js";

/**
 * 标签预算必须**随节点框宽变化** —— 这是 D3-2 修正计划硬错误的核心。
 *
 * 背景：`LABEL_BUDGET=24` 单位宽（= 12 汉字 / 24 拉丁）当初是照 layout 的
 * 554px 框宽定的，但五个视图的框宽差 5 倍。固定用它会同时造成两类坏结果：
 *   - layout 收紧：45 汉字 → 12 汉字，主视图信息量掉到 1/4
 *   - 窄框溢出：tree(150px) 只装得下 11 汉字、swimlane(112px) 只装 8 个
 *
 * ⚠️ 这两条都**不会报错**：SVG 不换行，超宽只是视觉溢出；而收紧也不违反任何断言。
 * 所以必须有测试把它们钉住。
 */

/** 12px sans-serif 下 1 个单位宽 = 6px（汉字按 12px 记 2 单位）。 */
const UNIT_PX = 6;

test("预算随框宽单调递增，且恰好等于该框能装的单位宽", () => {
	// 用字面量而不是 LABEL_BUDGET —— 断言引用被测常量就是自证（见 D2 变异总结）
	assert.equal(labelBudgetFor(554), Math.floor((554 - 14) / UNIT_PX)); // 90
	assert.equal(labelBudgetFor(150), Math.floor((150 - 14) / UNIT_PX)); // 22.67 → 22
	assert.equal(labelBudgetFor(112), Math.floor((112 - 14) / UNIT_PX)); // 16.33 → 16
});

test("宽框不被全局上限封顶（LABEL_BUDGET 只在框宽未知时兜底）", () => {
	// ⚠️ 我一开始在这里写了 `assert.ok(labelBudgetFor(554) <= LABEL_BUDGET)`，
	//   那等于要求全局封顶 —— 而封顶正是「把layout 砍到 12 汉字」的退化本身。
	//   两条判据不可兼得，说明**上限这个前提本身就是错的**。
	//正确形态：预算 = 该框真能装的量，不额外封顶。
	assert.equal(labelBudgetFor(7200), Math.floor((7200 - 14) / UNIT_PX));
	// 框宽未知（非有限/ 负数）时才回落到全局默认
	assert.equal(labelBudgetFor(Number.NaN), 24);
	assert.equal(labelBudgetFor(-1), 24);
});

test("预算随框宽单调递增（窄框预算必须严格小于宽框）", () => {
	const widths = [112, 150, 300, 554, 720];
	for (let i = 1; i < widths.length; i++) {
		assert.ok(
			labelBudgetFor(widths[i]) > labelBudgetFor(widths[i - 1]),
			`${widths[i]}px 的预算 (${labelBudgetFor(widths[i])}) 未大于 ${widths[i - 1]}px 的 (${labelBudgetFor(widths[i - 1])})`,
		);
	}
});

test("tree 视图的 12 汉字不会溢出 150px 框（计划原方案在这里是溢出的）", () => {
	const budget = labelBudgetFor(150);
	const label = condenseLabel("第一集剧情大纲完整版", budget);
	// 提炼结果必须真的放得下
	assert.ok(labelWidth(label) <= budget, `提炼结果 ${labelWidth(label)} 单位 > 预算 ${budget}`);
	// 而 12 汉字（=24 单位）在 150px 框里放不下⇒ 预算不能是 24
	assert.ok(24 > budget, "若预算被抬到 24，12 汉字就会溢出 tree 框");
});

test("swimlane 的 112px 框比tree 更窄，预算必须更小", () => {
	assert.ok(labelBudgetFor(112) < labelBudgetFor(150));
	// 8 汉字 = 16 单位，刚好装满 112px 框；12 汉字 = 24 单位会溢出
	assert.equal(labelBudgetFor(112), 16);
});

test("layout 的 45 汉字不被收紧到 12 汉字（计划原方案会把主视图砍到 1/4）", () => {
	const budget = labelBudgetFor(554);
	// 45 汉字 = 90 单位，554px 框正好装得下
	assert.ok(labelWidth("一".repeat(45)) <= budget);
	// 提炼 45 汉字应当**原样返回**（预算之内 ⇒ 不提炼）
	assert.equal(condenseLabel("一".repeat(45), budget), "一".repeat(45));
});

test("中英混排按单位宽正确计量（不是按字符数）", () => {
	// 24 个拉丁字符 = 24 单位（未超 90 预算）
	assert.equal(condenseLabel("a".repeat(24), labelBudgetFor(554)), "a".repeat(24));
	// 13 个汉字 = 26 单位 > 22（tree 预算）⇒ 提炼
	const treeBudget = labelBudgetFor(150);
	const han = condenseLabel("一".repeat(13), treeBudget);
	assert.ok(labelWidth(han) <= treeBudget);
	assert.ok(han.endsWith("…"));
});

test("预算不足 1 单位时返回 0 而不是负数（否则 condenseLabel 会砍成空串）", () => {
	assert.equal(labelBudgetFor(4), 0);
	assert.equal(labelBudgetFor(14), 0);
	// condenseLabel 在budget=0 时不能产出 "…" 这种无意义结果
	assert.notEqual(condenseLabel("很长的标题", 0), "…");
});

test("非法框宽回落全局默认，不产出 NaN 预算", () => {
	assert.equal(labelBudgetFor(Number.NaN), 24);
	assert.equal(labelBudgetFor(-100), 24);
	assert.equal(Number.isFinite(labelBudgetFor(Number.POSITIVE_INFINITY)), true);
});