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
