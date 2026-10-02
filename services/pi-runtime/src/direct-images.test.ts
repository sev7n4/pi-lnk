import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateImageTokens, toImageContents } from "./direct-images.js";

const IMG = (data: string, name = "a.png", mimeType = "image/png") => ({ name, mimeType, data });

test("undefined → undefined（不发送空数组）", () => {
	assert.equal(toImageContents(undefined), undefined);
});

test("空数组 → undefined", () => {
	assert.equal(toImageContents([]), undefined);
});

test("全空 data → undefined（Review Focus 1：空直通请求跳过 images）", () => {
	assert.equal(toImageContents([IMG("")]), undefined);
	assert.equal(toImageContents([IMG("   ")]), undefined);
});

test("正常映射：{name,mimeType,data} → {type:'image',data,mimeType}，name 不进 contents", () => {
	const out = toImageContents([IMG("QUJD", "pic.png", "image/png")]);
	assert.deepEqual(out, [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
});

test("混合有效/空 data：只保留有效图", () => {
	const out = toImageContents([IMG(""), IMG("QQ==", "b.jpg", "image/jpeg")]);
	assert.deepEqual(out, [{ type: "image", data: "QQ==", mimeType: "image/jpeg" }]);
});

test("estimateImageTokens 随 data 长度单调不减", () => {
	const small = estimateImageTokens("A".repeat(4000));
	const big = estimateImageTokens("A".repeat(400000));
	assert.ok(big > small, `big(${big}) 应大于 small(${small})`);
	assert.ok(small > 0);
});
