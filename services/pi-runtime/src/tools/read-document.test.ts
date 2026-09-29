import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReadDocumentTools, resolveRef } from "./read-document.js";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

type ToolResult = { content: { text: string }[]; details?: unknown };
function runTool(tool: LnkpiTool, params: unknown, tc: unknown = {}): Promise<ToolResult> {
	return tool.execute!("1", params as never, undefined as never, tc as never, undefined as never, undefined as never) as Promise<ToolResult>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function payload(out: ToolResult): any {
	return JSON.parse(out.content[0].text);
}

const att = (mediaType: string, extra: Record<string, unknown> = {}) => ({ mediaType, ...extra });

test("resolveRef：T/I/V/A 按 mediaType 计数，未知类型跳过", () => {
	const list = [att("text"), att("image"), att("text"), att("video", { id: "vid-9" }), att("weird")];
	assert.equal(resolveRef(list, "T1")?.index, 0);
	assert.equal(resolveRef(list, "T2")?.index, 2);
	assert.equal(resolveRef(list, "I1")?.index, 1);
	assert.equal(resolveRef(list, "V1")?.index, 3);
});

test("resolveRef：大小写不敏感 + id 精确匹配", () => {
	const list = [att("text", { id: "abc" })];
	assert.equal(resolveRef(list, "t1")?.key, "T1");
	assert.equal(resolveRef(list, "abc")?.index, 0);
	assert.equal(resolveRef(list, "T3"), null);
	assert.equal(resolveRef([], "T1"), null);
});

test("read_document：命中 text 素材返回全文 + 窗口字段", async () => {
	const tc = { sessionId: "s1", userId: "u1", attachments: [att("text", { label: "brief", text: "hello world" })] } as LnkpiToolContext;
	const [tool] = buildReadDocumentTools();
	const out = await runTool(tool, { ref: "T1" }, tc);
	const p = payload(out) as { ok: boolean; text: string; total_length: number; next_start_index: number | null; ref: string };
	assert.equal(p.ok, true);
	assert.equal(p.ref, "T1");
	assert.equal(p.text, "hello world");
	assert.equal(p.total_length, 11);
	assert.equal(p.next_start_index, null);
});

test("read_document：超 20k 截断 + start_index 续读（Review#2 越界夹取）", async () => {
	const body = "x".repeat(20_050);
	const tc = { sessionId: "s1", userId: "u1", attachments: [att("text", { text: body })] } as LnkpiToolContext;
	const [tool] = buildReadDocumentTools();
	const first = payload(await runTool(tool, { ref: "T1" }, tc)) as { text: string; next_start_index: number | null };
	assert.equal(first.text.length, 20_000);
	assert.equal(first.next_start_index, 20_000);
	const second = payload(await runTool(tool, { ref: "T1", start_index: 20_000 }, tc)) as { text: string; next_start_index: number | null };
	assert.equal(second.text.length, 50);
	assert.equal(second.next_start_index, null);
	const clamped = payload(await runTool(tool, { ref: "T1", start_index: -5 }, tc)) as { start_index: number; text: string };
	assert.equal(clamped.start_index, 0);
	assert.equal(clamped.text.length, 20_000);
});

test("read_document：未命中 → 清单兜底，超出预览窗口的正文不泄漏（Review#1）", async () => {
	// 预览 80 字（spec §5.1）会带正文开头，这是设计；Review#1 保证的是「不返回完整正文」——
	// 故构造 head 恰为 80 字 + 可识别的尾部标记，断言尾部标记不出现在响应里。
	const head = "A".repeat(80);
	const full = head + "-TAILMARKER-" + "尾".repeat(150);
	const tc = {
		sessionId: "s1",
		userId: "u1",
		attachments: [att("text", { text: full }), att("image", { url: "https://cdn/x.png" })],
	} as LnkpiToolContext;
	const [tool] = buildReadDocumentTools();
	const out = await runTool(tool, { ref: "T9" }, tc);
	assert.equal((payload(out) as { ok: boolean }).ok, false);
	assert.ok(!out.content[0].text.includes("TAILMARKER"), "预览窗口之外的正文不得出现在响应里");
	const list = (payload(out) as { attachments: { ref: string; mediaType: string; preview: string }[] }).attachments;
	assert.deepEqual(list.map((a) => a.ref), ["T1", "I1"]);
	assert.equal(list[0].mediaType, "text");
	assert.equal(list[0].preview, full.slice(0, 80));
});

test("read_document：非 text 素材给指引性错误；空文本报错（Review#3）", async () => {
	const [tool] = buildReadDocumentTools();
	const imgTc = { sessionId: "s1", attachments: [att("image", { url: "https://cdn/x.png" })] } as LnkpiToolContext;
	const img = payload(await runTool(tool, { ref: "I1" }, imgTc)) as { ok: boolean; error: string };
	assert.equal(img.ok, false);
	assert.match(img.error, /仅支持文本素材/);
	const emptyTc = { sessionId: "s1", attachments: [att("text", { text: "   " })] } as LnkpiToolContext;
	const empty = payload(await runTool(tool, { ref: "T1" }, emptyTc)) as { ok: boolean; error: string };
	assert.equal(empty.ok, false);
	assert.match(empty.error, /文本为空/);
});

test("read_document：无附件 / 缺 ref 参数 → 明确失败", async () => {
	const [tool] = buildReadDocumentTools();
	const none = payload(await runTool(tool, { ref: "T1" }, { sessionId: "s1" } as LnkpiToolContext)) as { ok: boolean; error: string };
	assert.equal(none.ok, false);
	assert.match(none.error, /没有侧栏参考素材/);
	await assert.rejects(() => runTool(tool, {}, { sessionId: "s1" } as LnkpiToolContext), /requires ref/);
	assert.equal(tool.tier, "read");
});
