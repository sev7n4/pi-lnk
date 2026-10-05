import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDynamicBudget, classifyBlock } from "./dynamic-budget.js";

// ── 块首标记 = 真实生产约定（C1 hotfix）────────────────────────────────
// canvas: pi-prompt-assembler.service.ts:192 `当前画布摘要：\n{JSON}`
// vision: sidebar-vision.ts:137 `【侧栏参考图解析】`
// sidebar: sidebar-block.ts:45 `侧栏参考素材：`
// memory: agent.service.ts `## 长期记忆（用户历史偏好，供参考）`

test("classifyBlock：真实生产块首命中与 general 兜底", () => {
	assert.equal(classifyBlock("当前画布摘要：\n{\"nodes\":[]}"), "canvas");
	assert.equal(classifyBlock("【侧栏参考图解析】\n摘要：x"), "vision");
	assert.equal(classifyBlock("侧栏参考素材：\nI1=a.png"), "sidebar");
	assert.equal(classifyBlock("## 长期记忆（用户历史偏好，供参考）\n- 条目"), "memory");
	assert.equal(classifyBlock("没有任何标记的普通块"), "general");
	assert.equal(classifyBlock("  当前画布摘要：前导空白"), "canvas");
});

test("不超限：输出与输入 join 逐字节一致", () => {
	const blocks = ["当前画布摘要：\n{\"nodes\":[]}".padEnd(50, "x"), "侧栏参考素材：\nI1=a.png"];
	const r = applyDynamicBudget(blocks, { totalChars: 10000 });
	assert.equal(r.blocks.join(""), blocks.join(""));
	assert.equal(Object.values(r.dropped).reduce((a, b) => a + b, 0), 0);
});

test("canvas 超限：保头保尾、含尾注、总长≤预算份额附近（份额 55%）", () => {
	const big = "当前画布摘要：\n" + JSON.stringify({ nodes: "节点甲".repeat(2000) }) + "最新节点乙".repeat(500);
	const r = applyDynamicBudget([big], { totalChars: 4800 }); // canvas 0.55 → 2640
	const out = r.blocks[0];
	assert.ok(out.startsWith("当前画布摘要："));
	assert.ok(out.includes("最新节点乙"), "必须保尾");
	assert.ok(out.includes("已截断"), "必须含截断尾注");
	assert.ok(out.length <= 2640 + 200, "截断+尾注仍应在份额附近");
});

test("canvas 尾注不承诺 read_document（M3：画布摘要不是附件）", () => {
	const big = "当前画布摘要：\n" + "节点甲。".repeat(2000);
	const out = applyDynamicBudget([big], { totalChars: 480 }).blocks[0];
	assert.doesNotMatch(out, /read_document/);
});

test("vision 超限：保头截断（份额 25%）", () => {
	const big = "【侧栏参考图解析】\n摘要：" + "识图文本".repeat(3000);
	const r = applyDynamicBudget([big], { totalChars: 4800 });
	assert.ok(r.blocks[0].includes("已截断"));
	assert.equal(r.dropped.vision, 1);
});

test("sidebar 超限：保头截断，尾注保留 read_document 承诺（M3：素材是附件）", () => {
	const big = "侧栏参考素材：\n" + "素材内容".repeat(2000);
	const out = applyDynamicBudget([big], { totalChars: 480 }).blocks[0];
	assert.ok(out.startsWith("侧栏参考素材："));
	assert.match(out, /read_document/);
	assert.equal(applyDynamicBudget([big], { totalChars: 480 }).dropped.sidebar, 1);
});

test("memory 超限：独立 kind（份额 10%），不落 general（I2）", () => {
	const big = "## 长期记忆（用户历史偏好，供参考）\n- " + "记忆条目".repeat(1000);
	const r = applyDynamicBudget([big], { totalChars: 4800 });
	assert.equal(r.dropped.memory, 1);
	assert.equal(r.dropped.general, 0);
});

test("多块同 kind 共享份额：先到先得，后者截断", () => {
	const a = "【侧栏参考图解析】\n" + "甲".repeat(1397); // vision 25% of 12000 = 3000
	const b = "【侧栏参考图解析】\n" + "乙".repeat(1997);
	const r = applyDynamicBudget([a, b], { totalChars: 12000 });
	assert.equal(r.dropped.vision, 1);
	assert.ok(r.blocks[1].length < b.length, "第二块被截断而非丢弃");
});

test("I1：同 kind 份额耗尽后，后续块仍保留 ≥80 字（不再 1 字符）", () => {
	const a = "【侧栏参考图解析】\n" + "甲".repeat(2900); // 几乎吃满 3000
	const b = "【侧栏参考图解析】\n" + "乙".repeat(2000);
	const r = applyDynamicBudget([a, b], { totalChars: 12000 });
	const outB = r.blocks[1];
	assert.ok(outB.startsWith("【侧栏参考图解析】"));
	const noteLen = outB.length - outB.replace(/（本段已截断[^\n]*$/, "").length;
	assert.ok(outB.length - noteLen >= 80, `正文保底 ≥80，实际 ${outB.length - noteLen}`);
});

test("general（真未知标记）：cap=保底 80，计 general 截断", () => {
	const big = "[自定义标记]" + "长文本".repeat(3000);
	const r = applyDynamicBudget([big], { totalChars: 480 });
	assert.ok(r.blocks[0].length >= 80);
	assert.ok(r.blocks[0].includes("已截断"));
	assert.equal(r.dropped.general, 1);
});

test("byte-stable：同输入两次调用输出相同", () => {
	const blocks = [
		"当前画布摘要：\n" + "x".repeat(5000),
		"【侧栏参考图解析】\n" + "y".repeat(2000),
		"## 长期记忆（用户历史偏好，供参考）\n- z".padEnd(2100, "z"),
	];
	assert.equal(
		applyDynamicBudget(blocks, { totalChars: 4800 }).blocks.join(""),
		applyDynamicBudget(blocks, { totalChars: 4800 }).blocks.join(""),
	);
});

test("空数组/全空块：不超限直通且 dropped 全零", () => {
	assert.deepEqual(applyDynamicBudget([], { totalChars: 4800 }).blocks, []);
	const r2 = applyDynamicBudget(["", "  "], { totalChars: 4800 });
	assert.equal(Object.values(r2.dropped).reduce((a, b) => a + b, 0), 0);
});

test("M1：多块混合总量上界 ≤ totalChars + 4×(保底+尾注余量)", () => {
	const blocks = [
		"当前画布摘要：\n" + "甲".repeat(9000),
		"【侧栏参考图解析】\n" + "乙".repeat(9000),
		"侧栏参考素材：\n" + "丙".repeat(9000),
		"## 长期记忆（用户历史偏好，供参考）\n- " + "丁".repeat(9000),
		"[未知标记]" + "戊".repeat(9000),
	];
	const out = applyDynamicBudget(blocks, { totalChars: 4800 }).blocks.join("");
	assert.ok(out.length <= 4800 + 5 * 200, `总量上界失守：${out.length}`);
});

test("M2：记忆块走 memory 份额（10%）而非 canvas 份额（55%）", () => {
	// 同样的长度放在 memory 块与 canvas 块上，截断线必须不同——
	// 否则「kind 分类生效」这条判据就是恒真的（两个 kind 恰好同份额时它也成立）。
	const body = "甲".repeat(900);
	const mem = "## 长期记忆（用户历史偏好，供参考）\n- " + body; // memory 10% → 480
	const can = "当前画布摘要：\n" + body; // canvas 55% → 2640
	assert.ok(mem.length > 480 && can.length > 480, "两块都应超过各自份额");
	assert.ok(applyDynamicBudget([mem], { totalChars: 4800 }).dropped.memory === 1, "记忆块应超 memory 份额");
	assert.ok(applyDynamicBudget([can], { totalChars: 4800 }).dropped.canvas === 0, "同长度画布块不该超 canvas 份额");
});

// ── §8.1 case 4：预算截断尾注（组装管线契约，进 PR 门禁）────────────────

test("case4：未超限块零改动直通（byte-stable 前提）", () => {
	const short = "## 长期记忆（用户历史偏好，供参考）\n- 短条目";
	const r = applyDynamicBudget([short], { totalChars: 10000 });
	// 逐字节原样、无附加键（不是「重新拼一遍碰巧一样」）
	assert.deepEqual(r.blocks, [short]);
	assert.equal(r.dropped.memory, 0);
	// 反例对照：同kind 的长块在紧预算下必须被截断——否则上一条是恒真的（截断逻辑压根没跑）。
	// ⚠️ 反例块必须 > MIN_BLOCK_CHARS(80)：allow 有 80 字保底，短块在任何预算下都不截断。
	const longish = "## 长期记忆（用户历史偏好，供参考）\n- " + "长".repeat(300);
	const cut = applyDynamicBudget([longish], { totalChars: 100 });
	assert.equal(cut.dropped.memory, 1);
	assert.notDeepEqual(cut.blocks, [longish]);
});

test("case4b：超限块必带 kind 定制的截断尾注", () => {
	const long = "## 长期记忆（用户历史偏好，供参考）\n" + "长".repeat(5000);
	const r = applyDynamicBudget([long], { totalChars: 100 });
	assert.equal(r.dropped.memory, 1);
	assert.ok(r.blocks[0].includes("已截断"));
	// memory 块不是 attachments ⇒ 尾注不得承诺 read_document（dynamic-budget M3 决策）
	assert.ok(!r.blocks[0].includes("read_document"));
	// 反例对照：同kind 的尾注不得与 sidebar 的相同，否则「按 kind 定制」这条判据形同虚设
	const sidebar = applyDynamicBudget(["侧栏参考素材：\n" + "长".repeat(5000)], { totalChars: 100 }).blocks[0]!;
	assert.ok(sidebar.includes("read_document"));
	assert.notEqual(r.blocks[0].slice(-80), sidebar.slice(-80));
});

/**
 * Review Focus #5：记忆内容里本身可能含 `## 长期记忆` 字样（用户就是在讨论这个概念），
 * `classifyBlock` 用 `trimStart().startsWith()` 判断会被误导。
 *
 * ⚠️ 这里**记录既有行为**而不是改语义：startsWith 是已被上方测试锁定的约定
 * （前导空白也要能命中，见"真实生产块首命中与 general 兜底"那条）。
 * 记录它的目的是让实施者知道**注入侧必须做转义**（例如不把用户原文直接放在行首）。
 */
test("Review Focus #5：内容含「## 长期记忆」字样时的块类型归属", () => {
	// 既有行为：内容以该字样开头 ⇒ classifyBlock 判为 memory（份额 10%）
	assert.equal(classifyBlock("## 长期记忆\n- 我说过我喜欢蓝色"), "memory");
	// 字样在**开头之后** ⇒ 不被判成 memory（canvas 走 startsWith 首命中）
	assert.equal(classifyBlock("当前画布摘要：\n{\"nodes\":[{\"title\":\"关于长期记忆的讨论\"}]}"), "canvas");
	// ⚠️ 已知局限（记录事实，非期望）：字样出现在开头时 canvas 块会被误判为 memory。
	// 这不是 bug 而是 startsWith 约定的代价——修复应在注入侧（不要让用户原文落在行首）。
	assert.equal(classifyBlock("关于长期记忆的讨论：\n正文"), "general");
});

