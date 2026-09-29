import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMemoryTools, MEMORY_CONTENT_MAX, MEMORY_RECALL_DEFAULT, MEMORY_RECALL_MAX } from "./memory.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

type ToolResult = { content: { text: string }[]; details?: unknown };
function runTool(tool: LnkpiTool, params: unknown, tc: unknown = {}): Promise<ToolResult> {
	return tool.execute!("1", params as never, undefined as never, tc as never, undefined as never, undefined as never) as Promise<ToolResult>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function payload(out: ToolResult): any {
	return JSON.parse(out.content[0].text);
}

type Capture = { path?: string; body?: unknown; calls: number };
function fakeClient(capture: Capture = { calls: 0 }, reply: unknown = {}): NestClient {
	return {
		post: async (path: string, body: unknown) => {
			capture.path = path;
			capture.body = body;
			capture.calls += 1;
			return reply;
		},
	} as unknown as NestClient;
}

const tc = { sessionId: "s1", userId: "u1" } as LnkpiToolContext;
const find = (tools: LnkpiTool[], name: string) => tools.find((t) => t.name === name)!;

test("memory：schema 不暴露 userId/sessionId（toolContext 安全模型锁）", () => {
	const tools = buildMemoryTools(fakeClient());
	const schema = JSON.stringify(tools.map((t) => t.parameters));
	assert.ok(!schema.includes("userId"));
	assert.ok(!schema.includes("sessionId"));
	assert.equal(find(tools, "save_memory").tier, "write_light");
	assert.equal(find(tools, "recall_memory").tier, "read");
});

test("save_memory：userId 缺失 → 抛错且不发请求（Review#4 fail-closed）", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture));
	await assert.rejects(() => runTool(find(tools, "save_memory"), { content: "x" }, { sessionId: "s1" } as LnkpiToolContext), /requires userId/);
	assert.equal(capture.calls, 0);
});

test("recall_memory：userId 缺失 → 抛错且不发请求（spec §10 fail-closed 回归锁）", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture));
	await assert.rejects(
		() => runTool(find(tools, "recall_memory"), { query: "品牌色" }, { sessionId: "s1" } as LnkpiToolContext),
		/requires userId/,
	);
	assert.equal(capture.calls, 0);
});

test("save_memory：trim + 2000 截断 + 中文 note", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m1", createdAt: "2026-09-29T01:00:00.000Z" }));
	const long = "  " + "汉".repeat(MEMORY_CONTENT_MAX + 10) + "  ";
	const p = payload(await runTool(find(tools, "save_memory"), { content: long }, tc)) as {
		ok: boolean; id: string; truncated: boolean; note: string;
	};
	assert.equal(capture.path, "/agent/internal/memory-save");
	const body = capture.body as { userId: string; content: string };
	assert.equal(body.userId, "u1");
	assert.equal(body.content.length, MEMORY_CONTENT_MAX);
	assert.equal(p.id, "m1");
	assert.equal(p.truncated, true);
	assert.match(p.note, /^已记住：/);
	await assert.rejects(() => runTool(find(tools, "save_memory"), { content: "   " }, tc), /non-empty content/);
});

test("recall_memory：默认 limit 10、无 query 时 body 不带 query（Review#5 夹取）", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { items: [] }));
	const p = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { ok: boolean; count: number; note: string };
	assert.equal(capture.path, "/agent/internal/memory-search");
	assert.deepEqual(capture.body, { userId: "u1", limit: MEMORY_RECALL_DEFAULT });
	assert.equal(p.count, 0);
	assert.match(p.note, /没有相关记忆/);

	const capture2: Capture = { calls: 0 };
	const tools2 = buildMemoryTools(fakeClient(capture2, { items: [] }));
	await runTool(find(tools2, "recall_memory"), { limit: 999 }, tc);
	assert.equal((capture2.body as { limit: number }).limit, MEMORY_RECALL_MAX);

	const capture3: Capture = { calls: 0 };
	await runTool(find(buildMemoryTools(fakeClient(capture3)), "recall_memory"), { limit: 0, query: " 品牌色 " }, tc);
	assert.deepEqual(capture3.body, { userId: "u1", query: "品牌色", limit: 1 });
});

test("recall_memory：命中项原样透传，miss 带换关键词提示", async () => {
	const items = [{ id: "m1", content: "品牌色 #0F4C81", createdAt: "2026-09-29T01:00:00.000Z" }];
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items }));
	const hit = payload(await runTool(find(tools, "recall_memory"), { query: "品牌色" }, tc)) as { count: number; items: typeof items; note?: string };
	assert.equal(hit.count, 1);
	assert.deepEqual(hit.items, items);
	assert.equal(hit.note, undefined);
	const tools2 = buildMemoryTools(fakeClient({ calls: 0 }, { items: [] }));
	const miss = payload(await runTool(find(tools2, "recall_memory"), { query: "brand" }, tc)) as { note: string };
	assert.match(miss.note, /关键词/);
});

test("recall_memory：Nest 返回畸形（null / 缺 items）→ 空列表不炸", async () => {
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, null));
	const p = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { ok: boolean; count: number };
	assert.equal(p.ok, true);
	assert.equal(p.count, 0);
});
