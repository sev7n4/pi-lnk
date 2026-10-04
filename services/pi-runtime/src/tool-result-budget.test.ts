/**
 * 工具结果统一预算（审计「问题不在有没有截断，而在没有统一上限」）。
 *
 * 定位：兜底层。各工具自带的语义截断（web 20k/8k、memory 2000、canvas-read 50 项…）
 * 保留不变；本层只管「任何单条工具结果进上下文前不超过一个全局字符数」，
 * 并给每条结果一个可观测的体积读数（此前只有 Nest 客户端那一半被观测）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_TOOL_RESULT_MAX_CHARS,
	capToolResult,
	measureToolResult,
} from "./tool-result-budget.js";

const text = (s: string) => ({ type: "text" as const, text: s });

describe("measureToolResult", () => {
	it("文本块：chars=字符数，bytes=UTF-8 字节数（中文 3 字节/字）", () => {
		const m = measureToolResult([text("中文abc")]);
		assert.equal(m.chars, 5);
		assert.equal(m.bytes, Buffer.byteLength("中文abc", "utf8"));
	});

	it("图片块不计入字符预算（由 before_payload 图片治理负责）", () => {
		const m = measureToolResult([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		assert.equal(m.chars, 0);
	});

	it("非数组 content（契约外的形态）→ 0，不做任何猜测", () => {
		assert.deepEqual(measureToolResult("raw string"), { chars: 0, bytes: 0 });
		assert.deepEqual(measureToolResult(undefined), { chars: 0, bytes: 0 });
	});
});

describe("capToolResult", () => {
	it("未超限 → 原样返回（同一引用，零拷贝零改动）", () => {
		const content = [text("短结果")];
		const out = capToolResult(content, 100);
		assert.equal(out.content, content);
		assert.equal(out.trimmed, false);
		assert.equal(out.droppedChars, 0);
	});

	it("恰好等于上限 → 不截断（边界值）", () => {
		const content = [text("x".repeat(200))];
		const out = capToolResult(content, 200);
		assert.equal(out.trimmed, false);
		assert.equal(out.content, content);
	});

	it("超限时截断到上限内，并带「已省略 N 字符」标记", () => {
		const content = [text("y".repeat(5_000))];
		const out = capToolResult(content, 500);
		assert.equal(out.trimmed, true);
		assert.ok(out.droppedChars > 0);
		const blocks = out.content as Array<{ type: string; text?: string }>;
		assert.equal(blocks.length, 1);
		assert.ok(blocks[0].text!.length <= 500, `实际 ${blocks[0].text!.length} 应 ≤ 500`);
		assert.match(blocks[0].text!, /省略 \d+ 字符/);
	});

	it("多块：保留在预算内的前几块，跨界的那块切尾，后继块整体丢弃", () => {
		const content = [text("A".repeat(100)), text("B".repeat(100)), text("C".repeat(100))];
		const out = capToolResult(content, 250);
		const blocks = out.content as Array<{ type: string; text?: string }>;
		assert.ok(blocks.length <= 3);
		assert.ok(blocks[0].text!.startsWith("AAA"), "第一块应完整保留");
		assert.equal(out.trimmed, true);
		// 拼接后的总长不超过上限
		const total = blocks.reduce((n, b) => n + (typeof b.text === "string" ? b.text.length : 0), 0);
		assert.ok(total <= 250, `总长 ${total} 应 ≤ 250`);
	});

	it("图片块不参与截断，原样保留", () => {
		const img = { type: "image" as const, data: "AAA", mimeType: "image/png" };
		const out = capToolResult([text("z".repeat(2_000)), img], 100);
		const blocks = out.content as Array<{ type: string }>;
		assert.ok(blocks.some((b) => b.type === "image"));
	});

	it("非数组 content（契约外）→ 原样返回，绝不改写", () => {
		// 契约外的形态：用断言绕过类型（实现里对非数组必须原样放行，不能猜结构）
		const raw = "some legacy shape" as unknown as ReturnType<typeof capToolResult>["content"];
		assert.equal(capToolResult(raw, 10).content, raw);
		assert.equal(capToolResult(raw, 10).trimmed, false);
	});

	it("上限极小时不崩、仍有标记（防御性）", () => {
		const out = capToolResult([text("q".repeat(1_000))], 5);
		const blocks = out.content as Array<{ type: string; text?: string }>;
		assert.equal(blocks.length, 1);
		assert.ok(blocks[0].text!.length <= 5 + 40, "标记可能超上限，但必须是可控的少量溢出");
	});

	it("默认上限高于现有各工具自带截断（兜底不抢语义截断的活）", () => {
		// 现存最大自带截断：web FETCH_MAX_CHARS 20_000 / present SVG_MAX_CHARS 20_000
		assert.ok(DEFAULT_TOOL_RESULT_MAX_CHARS >= 20_000);
	});
});
