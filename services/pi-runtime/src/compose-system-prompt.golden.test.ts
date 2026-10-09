/**
 * composeSystemPrompt 的 golden / 回归测试（审计 P2「无上下文快照测试」）。
 *
 * 为什么单独一份：既有 `session-keys.test.ts` 的 composeSystemPrompt 用例**全部走
 * budget=undefined 分支**（5 个用例无一传 budget），`dynamic-budget.test.ts` 测的是
 * applyDynamicBudget 纯函数 —— 两者之间的**集成层**（预算开关 × 回调 × 静态段拼接）
 * 此前零覆盖。报告 P2 原话：system prompt 没有任何 golden 回归，改装配逻辑无法挡回归。
 *
 * 本文件钉死两件事：
 * 1. **不变式**（从设计推导，不是从实现抄）：静态段恒在最前、预算关闭/开启在不截断时
 *    逐字节一致、截断必带尾注、空块不产生回调、byte-stable。
 * 2. **golden 串**：短输入逐字符比对；长输入用 sha256 前缀钉死（挡无意识漂移）。
 *
 * ⚠️ golden 值只允许在**有意变更装配逻辑**时更新，且必须同步改本文件头说明改了什么。
 *
 * golden 变更史：
 * - 2026-10-09 C1（spec 2026-10-09-task-tool-design.md §3.4）：dynamic-budget 新增
 *   "todo" kind（份额 5%，从 canvas 0.55→0.50 挪出，总和 1.0 不变量保持）——跨压缩
 *   任务清单块需要独立预算分类，canvas 截断点随份额变化 ⇒ 「混合四 kind」golden 摘要
 *   由 4d78fe37b10388a1 → 2f045e7dd9f49fb4。结构不变式（静态段最前/总量上界）不变。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { composeSystemPrompt } from "./session-manager.js";

/** golden 摘要：取 sha256 前 16 位（够挡漂移，又不至于让测试文件被几千字符淹没）。 */
function digest(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/** 收集 budget 回调，便于断言「按 kind 计数」而非只断言「被调用过」。 */
function recorder() {
	const drops: Array<{ kind: string }> = [];
	let unknownKind = 0;
	return {
		budget: {
			totalChars: 0, // 各用例自行覆盖
			onDrop: (kind: string) => drops.push({ kind }),
			onUnknownKind: () => {
				unknownKind += 1;
			},
		},
		drops,
		get unknownKind() {
			return unknownKind;
		},
		countOf(kind: string) {
			return drops.filter((d) => d.kind === kind).length;
		},
	};
}

// ── 真实生产块首标记（C1 hotfix 约定，与 dynamic-budget.test.ts 保持一致）────────
const CANVAS = "当前画布摘要：\n";
const VISION = "【侧栏参考图解析】\n";
const SIDEBAR = "侧栏参考素材：\n";
const MEMORY = "## 长期记忆（用户历史偏好，供参考）\n";

describe("composeSystemPrompt golden：不截断场景（逐字符串比对）", () => {
	it("golden：短输入 + 预算开启但未超限 = 逐字符期望串", () => {
		const out = composeSystemPrompt("RULES", [CANVAS + '{"nodes":[]}'], { totalChars: 48_000 });
		assert.equal(out, 'RULES\n\n当前画布摘要：\n{"nodes":[]}');
	});

	it("golden：多块按序拼接，分隔符为两个换行", () => {
		const out = composeSystemPrompt("RULES", [CANVAS + "A", SIDEBAR + "B", MEMORY + "- m"], {
			totalChars: 48_000,
		});
		assert.equal(out, `RULES\n\n${CANVAS}A\n\n${SIDEBAR}B\n\n${MEMORY}- m`);
	});

	it("回退保证：预算开启与关闭，在不截断时输出逐字节一致", () => {
		const blocks = [CANVAS + "A", SIDEBAR + "B", MEMORY + "- m"];
		const off = composeSystemPrompt("RULES", blocks);
		const on = composeSystemPrompt("RULES", blocks, { totalChars: 48_000 });
		assert.equal(on, off, "预算开启不得改变不超限块的输出（byte-stable 回退）");
	});

	it("回退保证：不传 budget 时与超小预算但内容极短也一致（空块被过滤）", () => {
		assert.equal(composeSystemPrompt("RULES", ["", "  ", CANVAS + "A"]), `RULES\n\n${CANVAS}A`);
	});
});

describe("composeSystemPrompt golden：截断场景（不变式 + 摘要）", () => {
	it("静态段恒在最前：即使动态块被截断，稳定前缀也不被推到后面", () => {
		const big = CANVAS + "节点".repeat(3000);
		const out = composeSystemPrompt("RULES", [big], { totalChars: 480 });
		assert.ok(out.startsWith("RULES\n\n"), "静态段必须仍是最前");
		assert.ok(out.indexOf("RULES") < out.indexOf(CANVAS), "RULES 必须先于动态块出现");
	});

	it("canvas 超限：输出含 kind 定制尾注，且不承诺 read_document", () => {
		const big = CANVAS + "节点".repeat(3000);
		const out = composeSystemPrompt("RULES", [big], { totalChars: 480 });
		assert.match(out, /已截断/);
		assert.doesNotMatch(out, /read_document/, "画布摘要不是附件，不得承诺 read_document");
	});

	it("sidebar 超限：尾注保留 read_document 承诺（素材是附件）", () => {
		const big = SIDEBAR + "素材".repeat(3000);
		const out = composeSystemPrompt("RULES", [big], { totalChars: 480 });
		assert.match(out, /read_document/);
	});

	it("byte-stable：同输入两次调用输出逐字符相同", () => {
		const blocks = [CANVAS + "甲".repeat(5000), VISION + "乙".repeat(2000), MEMORY + "- " + "丙".repeat(2000)];
		const a = composeSystemPrompt("RULES", blocks, { totalChars: 4800 });
		const b = composeSystemPrompt("RULES", blocks, { totalChars: 4800 });
		assert.equal(a, b);
	});

	it("golden 摘要：混合四 kind + 未知块的整串摘要钉死", () => {
		const blocks = [
			CANVAS + "甲".repeat(9000),
			VISION + "乙".repeat(9000),
			SIDEBAR + "丙".repeat(9000),
			MEMORY + "- " + "丁".repeat(9000),
			"[未知标记]" + "戊".repeat(9000),
		];
		const out = composeSystemPrompt("RULES", blocks, { totalChars: 4800 });
		// 结构不变式（先于摘要断言，防止「把现状录成 golden」式假绿）
		assert.ok(out.startsWith("RULES\n\n"));
		assert.ok(out.length <= 4800 + 5 * 200, `总量上界失守：${out.length}`);
		assert.equal(digest(out), "2f045e7dd9f49fb4", "golden 摘要漂移 —— 若是有意改动，请更新并说明");
	});
});

describe("composeSystemPrompt：budget 回调接线（此前的零覆盖区）", () => {
	it("onDrop 按 kind 计数：canvas 与 vision 各一次，sidebar 未超限不计", () => {
		const r = recorder();
		const out = composeSystemPrompt(
			"RULES",
			[CANVAS + "甲".repeat(3000), VISION + "乙".repeat(3000), SIDEBAR + "短素材"],
			{ totalChars: 2000, onDrop: r.budget.onDrop, onUnknownKind: r.budget.onUnknownKind },
		);
		assert.ok(out.length > 0);
		assert.equal(r.countOf("canvas"), 1, "canvas 块超限应计一次");
		assert.equal(r.countOf("vision"), 1, "vision 块超限应计一次");
		assert.equal(r.countOf("sidebar"), 0, "sidebar 未超限不得计数");
	});

	it("onUnknownKind：general 块数 = 回调次数（每块一次，与是否截断无关）", () => {
		// ⚠️ general 份额为 0，cap 只有 MIN_BLOCK_CHARS=80 保底 —— 用例必须用「短于 80 字」
		// 的未识别块，否则会先触发截断、落进 dropped.general，就验证不了「与截断无关」这一点。
		const r = recorder();
		composeSystemPrompt("RULES", ["[未知A]" + "甲".repeat(20), CANVAS + "短摘要", "[未知B]短"], {
			totalChars: 48_000,
			onDrop: r.budget.onDrop,
			onUnknownKind: r.budget.onUnknownKind,
		});
		assert.equal(r.unknownKind, 2, "两个未识别块应各触发一次告警");
		assert.equal(r.drops.length, 0, "不超限时不应产生任何 drop");
	});

	it("general 长块（>80 字保底）截断时同时计 drop 与 unknown kind", () => {
		const r = recorder();
		composeSystemPrompt("RULES", ["[未知A]" + "甲".repeat(200)], {
			totalChars: 48_000,
			onDrop: r.budget.onDrop,
			onUnknownKind: r.budget.onUnknownKind,
		});
		assert.equal(r.countOf("general"), 1, "超保底的未识别块应计一次 general 截断");
		assert.equal(r.unknownKind, 1, "同时应触发一次约定漂移告警");
	});

	it("空/空白动态块：不触发任何回调", () => {
		const r = recorder();
		const out = composeSystemPrompt("RULES", ["", "  "], {
			totalChars: 480,
			onDrop: r.budget.onDrop,
			onUnknownKind: r.budget.onUnknownKind,
		});
		assert.equal(out, "RULES");
		assert.equal(r.drops.length, 0);
		assert.equal(r.unknownKind, 0, "被过滤掉的空块不得计入约定漂移告警");
	});

	it("回调未注入时安全：只有 onDrop 缺失不得抛错", () => {
		const big = CANVAS + "甲".repeat(3000);
		assert.doesNotThrow(() => composeSystemPrompt("RULES", [big], { totalChars: 480 }));
		assert.doesNotThrow(() =>
			composeSystemPrompt("RULES", [big], { totalChars: 480, onUnknownKind: () => {} }),
		);
	});
});
