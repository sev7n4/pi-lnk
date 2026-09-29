import { test } from "node:test";
import assert from "node:assert/strict";
import { stripImageBlocks } from "./sse-sanitize.js";

const withImage = {
	toolName: "run_image_generation",
	isError: false,
	result: {
		content: [
			{ type: "text", text: '{"ok":true}' },
			{ type: "image", data: "AAAA".repeat(1000), mimeType: "image/png" },
		],
		details: { actions: [{ type: "update_node" }] },
	},
};

test("Review Focus ⑦：image block 被替换为轻量描述符，text/details 原样保留", () => {
	const out = stripImageBlocks(withImage) as typeof withImage;
	const content = out.result.content as Array<Record<string, unknown>>;
	assert.equal(content.length, 2);
	assert.deepEqual(content[0], { type: "text", text: '{"ok":true}' });
	assert.equal(content[1].type, "image");
	assert.equal(content[1].mimeType, "image/png");
	assert.equal(content[1].omitted, true);
	assert.equal(content[1].bytes, 3000); // 4000 base64 字符 → 3000 字节
	assert.equal("data" in content[1], false, "base64 不得残留");
	assert.deepEqual(out.result.details, { actions: [{ type: "update_node" }] });
	assert.equal(out.toolName, "run_image_generation");
});

test("无图 / 无 result / 非数组 content → 返回原引用（零开销，off 下一字节不变）", () => {
	const noResult = { toolName: "get_node" };
	assert.equal(stripImageBlocks(noResult), noResult);
	const textOnly = { result: { content: [{ type: "text", text: "x" }] } };
	assert.equal(stripImageBlocks(textOnly), textOnly);
	const weird = { result: { content: "not-an-array" } };
	assert.equal(stripImageBlocks(weird), weird);
});

test("message_start / message_end：evt.message.content[] 里的 image 被替换，text 原样保留", () => {
	const data = "BBBB".repeat(800); // 3200 base64 字符 → 2400 字节
	const evt = {
		lane: "main",
		message: {
			role: "toolResult",
			content: [
				{ type: "text", text: '{"ok":true}' },
				{ type: "image", data, mimeType: "image/jpeg" },
			],
		},
	};
	const out = stripImageBlocks(evt) as typeof evt;
	assert.notEqual(out, evt, "有图时必须重建");
	const content = out.message.content as Array<Record<string, unknown>>;
	assert.equal(out.message.role, "toolResult");
	assert.deepEqual(content[0], { type: "text", text: '{"ok":true}' });
	assert.equal(content[1].type, "image");
	assert.equal(content[1].mimeType, "image/jpeg");
	assert.equal(content[1].omitted, true);
	assert.equal(content[1].bytes, 2400);
	assert.equal("data" in content[1], false, "base64 不得残留");
	assert.equal(out.lane, "main");
	// 输入未被改动：原 data 仍在输入对象上
	assert.equal(evt.message.content[1].data, data);
});

test("turn_end：toolResults[] 仅剥离含图条目，无图条目保持原引用，其它字段原样", () => {
	const noImageResult = { toolName: "get_node", content: [{ type: "text", text: "no image here" }] };
	const evt = {
		lane: "main",
		runId: "r1",
		message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		toolResults: [
			{
				toolName: "run_image_generation",
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "CCCC".repeat(50), mimeType: "image/png" },
				],
			},
			noImageResult,
			{
				toolName: "run_image_generation",
				content: [
					{ type: "text", text: "b" },
					{ type: "image", data: "DDDD".repeat(10), mimeType: "image/webp" },
				],
			},
		],
	};
	const out = stripImageBlocks(evt) as typeof evt;
	assert.notEqual(out, evt);
	assert.equal(out.toolResults.length, 3);
	const [first, second, third] = out.toolResults as Array<{
		content: Array<Record<string, unknown>>;
	}>;
	assert.equal("data" in first.content[1], false);
	assert.equal(first.content[1].mimeType, "image/png");
	assert.equal(first.content[1].bytes, 150); // 200 base64 字符 → floor(200*3/4)
	assert.equal(second, noImageResult, "无图条目必须保持原引用");
	assert.deepEqual(second.content, [{ type: "text", text: "no image here" }]);
	assert.equal(third.content[1].mimeType, "image/webp");
	assert.equal("data" in third.content[1], false);
	// 非 content 字段（message / runId / lane）原样
	assert.equal(out.runId, "r1");
	assert.equal(out.lane, "main");
	assert.deepEqual(out.message, { role: "assistant", content: [{ type: "text", text: "done" }] });
	// 输入未被改动
	assert.equal(evt.toolResults[0].content[1].type, "image");
});

test("全事件无图（message + toolResults 均纯文本）→ 返回同一引用（assert.equal）", () => {
	const evt = {
		lane: "main",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		toolResults: [{ content: [{ type: "text", text: "x" }] }, { content: [] }],
	};
	assert.equal(stripImageBlocks(evt), evt);
});

test("不改输入：调用后原对象的 data 字符串仍在", () => {
	const data = "EEEE".repeat(100);
	const evt = {
		result: { content: [{ type: "text", text: "t" }, { type: "image", data, mimeType: "image/png" }] },
	};
	const before = JSON.stringify(evt);
	stripImageBlocks(evt);
	assert.equal(evt.result.content[1].data, data);
	assert.equal(JSON.stringify(evt), before, "输入必须逐字节不变");
});
