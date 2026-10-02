import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateImagesForSummary } from "./compaction-images.js";

type Part = { type: string; text?: string; data?: string; mimeType?: string };
type Msg = { role: string; content: Part[] };

const imgPart = (data = "QUJD", mimeType = "image/png"): Part => ({ type: "image", data, mimeType });

test("有 [I1=] 标记：侧注恢复编号与文件名", () => {
	const msg: Msg = { role: "user", content: [{ type: "text", text: "看这张图 [I1=a.png]" }, imgPart()] };
	const out = annotateImagesForSummary([msg]) as Msg[];
	assert.equal(out.length, 1);
	const texts = out[0].content.filter((p) => p.type === "text").map((p) => p.text ?? "");
	assert.ok(
		texts.some((t) => t.includes("[图片 I1: a.png | image/png |") && t.includes("read_document")),
		JSON.stringify(texts),
	);
});

test("无标记：占位用 I?（不抛错，Review Focus 3）", () => {
	const msg: Msg = { role: "user", content: [{ type: "text", text: "看图" }, imgPart()] };
	const out = annotateImagesForSummary([msg]) as Msg[];
	const texts = out[0].content.filter((p) => p.type === "text").map((p) => p.text ?? "");
	assert.ok(texts.some((t) => t.includes("[图片 I?: 图片 | image/png |")), JSON.stringify(texts));
});

test("纯文本消息零变换（保持原引用）", () => {
	const textOnly: Msg = { role: "user", content: [{ type: "text", text: "纯文本" }] };
	const assistant: Msg = { role: "assistant", content: [{ type: "text", text: "答" }] };
	const out = annotateImagesForSummary([textOnly, assistant]) as Msg[];
	assert.equal(out, undefined, "无图片消息时应返回 undefined（零变换直通）");
});

test("输入数组与消息对象不被 mutate", () => {
	const content: Part[] = [{ type: "text", text: "看图 [I2=b.png]" }, imgPart()];
	const msg: Msg = { role: "user", content };
	const snapshot = JSON.stringify(msg);
	const out = annotateImagesForSummary([msg]) as Msg[];
	assert.equal(JSON.stringify(msg), snapshot, "原消息不变");
	assert.notEqual(out[0], msg, "输出是副本");
	assert.equal(out[0].content.length, 3, "副本追加侧注 part");
});

test("混合：有图消息变换、纯文本消息保持原引用", () => {
	const textOnly: Msg = { role: "user", content: [{ type: "text", text: "纯文本" }] };
	const withImg: Msg = { role: "user", content: [{ type: "text", text: "图 [I1=a.png]" }, imgPart()] };
	const out = annotateImagesForSummary([textOnly, withImg]) as Msg[];
	assert.equal(out[0], textOnly, "纯文本消息保持原引用");
	assert.notEqual(out[1], withImg);
});
