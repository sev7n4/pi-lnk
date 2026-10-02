import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDynamicBudget, classifyBlock } from "./dynamic-budget.js";

test("不超限：输出与输入 join 逐字节一致", () => {
	const blocks = ["[画布快照] a".repeat(10), "[I1=x.png] 图"].map((s) => s.slice(0, 50));
	const r = applyDynamicBudget(blocks, { totalChars: 10000 });
	assert.equal(r.blocks.join(""), blocks.join(""));
	assert.equal(Object.values(r.dropped).reduce((a, b) => a + b, 0), 0);
});

test("canvas 超限：保头保尾、含尾注、总长≤预算份额附近", () => {
	const big = "[画布快照]" + "节点甲。".repeat(2000) + "最新节点乙。".repeat(500);
	const r = applyDynamicBudget([big], { totalChars: 4800 }); // canvas 份额 60% → 2880
	const out = r.blocks[0];
	assert.ok(out.startsWith("[画布快照]"));
	assert.ok(out.includes("最新节点乙。"), "必须保尾");
	assert.ok(out.includes("可用 read_document 取回全文"));
	assert.ok(out.length <= 2880 + 200, "截断+尾注仍应在份额附近");
});

test("vision 超限：保头截断", () => {
	const big = "[I1=a.png]" + "识图文本".repeat(3000);
	const r = applyDynamicBudget([big], { totalChars: 4800 });
	assert.ok(r.blocks[0].includes("可用 read_document 取回全文"));
	assert.equal(r.dropped.vision, 1);
});

test("多块同 kind 共享份额：先到先得，后者截断", () => {
	// vision 份额 25% of 12000 = 3000：首块 1407 完整放行，余 1593 < 次块 2007 → 次块截断
	const a = "[I1=a.png]" + "甲".repeat(1397);
	const b = "[I2=b.png]" + "乙".repeat(1997);
	const r = applyDynamicBudget([a, b], { totalChars: 12000 });
	assert.equal(r.dropped.vision, 1);
	assert.ok(r.blocks[1].length < b.length, "第二块被截断而非丢弃");
});

test("byte-stable：同输入两次调用输出相同", () => {
	const blocks = ["[画布快照]" + "x".repeat(5000), "[I1=a.png]" + "y".repeat(2000)];
	assert.equal(
		applyDynamicBudget(blocks, { totalChars: 4800 }).blocks.join(""),
		applyDynamicBudget(blocks, { totalChars: 4800 }).blocks.join(""),
	);
});

test("空数组/全空块：不超限直通且 dropped 全零", () => {
	const r = applyDynamicBudget([], { totalChars: 4800 });
	assert.deepEqual(r.blocks, []);
	const r2 = applyDynamicBudget(["", "  "], { totalChars: 4800 });
	assert.equal(Object.values(r2.dropped).reduce((a, b) => a + b, 0), 0);
});

test("classifyBlock：标记命中与 general 兜底", () => {
	assert.equal(classifyBlock("[画布快照] xxx"), "canvas");
	assert.equal(classifyBlock("[I1=a.png] xxx"), "vision");
	assert.equal(classifyBlock("[侧栏素材] xxx"), "sidebar");
	assert.equal(classifyBlock("没有任何标记的普通块"), "general");
	assert.equal(classifyBlock("  [画布快照] 前导空白"), "canvas");
});

test("未知标记落 general：不丢块且计入 general 截断", () => {
	const big = "[自定义块]" + "长文本".repeat(3000);
	const r = applyDynamicBudget([big], { totalChars: 480 });
	assert.ok(r.blocks[0].includes("可用 read_document 取回全文"));
	assert.equal(r.dropped.general, 1);
});
