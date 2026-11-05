/**
 * 契约镜像测试（canvas-write.contract-mirror.test.ts 先例）：read-media.ts 的
 * resolveSidebarRefLocal 与 packages/shared resolveSidebarRef 逐语义一致。
 * fixture 与 packages/shared/src/sidebarAttachments.test.ts 的 VISP S-7 describe 完全同源；
 * 改任一侧实现必须同步另一侧与本文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSidebarRefLocal } from "./read-media.js";

const atts = [
	{ text: "产品文案", mediaType: "text" },
	{ url: "http://h:8888/api/uploads/u1/a.png", mediaType: "image" },
	{ url: "http://h:8888/api/uploads/u1/b.jpg", mediaType: "image" },
	{ url: "http://h:8888/api/uploads/u1/c.mp4", mediaType: "video" },
];

test("mirror 1a: I1/I2 → 对应图片 url（跨 mediaType 计数正确）", () => {
	assert.equal(resolveSidebarRefLocal(atts, "I1"), "http://h:8888/api/uploads/u1/a.png");
	assert.equal(resolveSidebarRefLocal(atts, "I2"), "http://h:8888/api/uploads/u1/b.jpg");
});

test("mirror 1b: 脏输入容忍（小写/空白）", () => {
	assert.equal(resolveSidebarRefLocal(atts, " i1 "), "http://h:8888/api/uploads/u1/a.png");
});

test("mirror 1c: 非图片 ref / 越界 / 非法形态 → null", () => {
	assert.equal(resolveSidebarRefLocal(atts, "T1"), null);
	assert.equal(resolveSidebarRefLocal(atts, "V1"), null);
	assert.equal(resolveSidebarRefLocal(atts, "I9"), null);
	assert.equal(resolveSidebarRefLocal(atts, "n_abc"), null);
	assert.equal(resolveSidebarRefLocal(atts, ""), null);
});

test("mirror 1d: 附件缺 url → null", () => {
	assert.equal(resolveSidebarRefLocal([{ mediaType: "image" }], "I1"), null);
});
