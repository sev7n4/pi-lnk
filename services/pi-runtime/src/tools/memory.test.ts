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

// 正常态：Nest 传了 canvasSessionId ⇒ trustedCanvasSessionId 有值，sessionId 与它一致。
// 只给 sessionId 而不给 trustedCanvasSessionId = pi 会话键回落态（见终审 I-3 用例）。
const tc = { sessionId: "s1", trustedCanvasSessionId: "s1", userId: "u1" } as LnkpiToolContext;
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
	// 预期变更：作用域隔离后 body 带 sessionId（画布归属）+ scope（默认 any）
	assert.deepEqual(capture.body, { userId: "u1", limit: MEMORY_RECALL_DEFAULT, sessionId: "s1", scope: "any" });
	assert.equal(p.count, 0);
	assert.match(p.note, /没有相关记忆/);

	const capture2: Capture = { calls: 0 };
	const tools2 = buildMemoryTools(fakeClient(capture2, { items: [] }));
	await runTool(find(tools2, "recall_memory"), { limit: 999 }, tc);
	assert.equal((capture2.body as { limit: number }).limit, MEMORY_RECALL_MAX);

	const capture3: Capture = { calls: 0 };
	await runTool(find(buildMemoryTools(fakeClient(capture3)), "recall_memory"), { limit: 0, query: " 品牌色 " }, tc);
	assert.deepEqual(capture3.body, { userId: "u1", query: "品牌色", limit: 1, sessionId: "s1", scope: "any" });
});

test("recall_memory：命中项原样透传，miss 带换关键词提示", async () => {
	const items = [
		{ id: "m1", content: "品牌色 #0F4C81", createdAt: "2026-09-29T01:00:00.000Z", scope: "user", sessionId: null, crossCanvas: false },
	];
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items }));
	const hit = payload(await runTool(find(tools, "recall_memory"), { query: "品牌色" }, tc)) as { count: number; items: typeof items; note?: string };
	assert.equal(hit.count, 1);
	// 预期变更：归属三字段随行透传（模型据此判断「这是记忆不是当前观察」）
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

// ── 作用域隔离（spec 2026-10-03-agent-memory-scope-isolation-design.md）──

test("save_memory：默认画布作用域，透传 toolContext.sessionId", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m1", createdAt: "2026-09-29T01:00:00.000Z" }));
	const p = payload(await runTool(find(tools, "save_memory"), { content: "本画布项目知识" }, tc)) as { note: string };
	assert.equal(capture.path, "/agent/internal/memory-save");
	assert.deepEqual(capture.body, { userId: "u1", content: "本画布项目知识", scope: "canvas", sessionId: "s1" });
	assert.match(p.note, /仅本画布/);
});

test("save_memory：显式 scope=user 时不带 sessionId，note 写「跨会话生效」", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m2", createdAt: "2026-09-29T01:00:00.000Z" }));
	const p = payload(await runTool(find(tools, "save_memory"), { content: "暗号是紫罗兰七号", scope: "user" }, tc)) as { note: string };
	assert.deepEqual(capture.body, { userId: "u1", content: "暗号是紫罗兰七号", scope: "user" });
	assert.match(p.note, /跨会话生效/);
});

test("save_memory：toolContext 无 sessionId → 不发 sessionId 键，note 如实写「未确定归属」", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m3", createdAt: "2026-09-29T01:00:00.000Z", scope: "user", sessionId: null }));
	const p = payload(
		await runTool(find(tools, "save_memory"), { content: "归属不明" }, { userId: "u1" } as LnkpiToolContext),
	) as { note: string };
	assert.ok(!Object.prototype.hasOwnProperty.call(capture.body as object, "sessionId"));
	assert.match(p.note, /未确定归属/);
	// 关键：Nest 把它降级成 user 后，note 不能仍然骗模型说「仅本画布」
	assert.doesNotMatch(p.note, /仅本画布/);
});

test("save_memory：Nest 降级为 user（返回 scope=user）→ note 跟随实际落库作用域", async () => {
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { id: "m4", createdAt: "c", scope: "user", sessionId: null }));
	const p = payload(await runTool(find(tools, "save_memory"), { content: "本想记画布" }, tc)) as { note: string };
	assert.match(p.note, /未确定归属/);
});

test("recall_memory：body 带 sessionId（默认 any，模型可显式要 user 层）", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { items: [] }));
	await runTool(find(tools, "recall_memory"), { query: "小熊" }, tc);
	assert.deepEqual(capture.body, { userId: "u1", query: "小熊", limit: 10, sessionId: "s1", scope: "any" });
});

test("recall_memory：显式 scope 透传（canvas 只查本画布）", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { items: [] }));
	await runTool(find(tools, "recall_memory"), { scope: "canvas" }, tc);
	assert.equal((capture.body as { scope: string }).scope, "canvas");
});

test("recall_memory：跨画布条目原样带回，并在 tool result 里附固定警示（spec §6 止血点）", async () => {
	const items = [
		{ id: "m1", content: "《小熊和小爸爸》项目信息", createdAt: "2026-09-30T01:00:00.000Z", scope: "canvas", sessionId: "other-canvas", crossCanvas: true },
		{ id: "m2", content: "本画布的约定", createdAt: "2026-09-30T02:00:00.000Z", scope: "canvas", sessionId: "s1", crossCanvas: false },
	];
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items }));
	const hit = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as {
		items: typeof items; notice?: string; crossCanvasCount?: number;
	};
	assert.equal(hit.items[0].crossCanvas, true);
	assert.equal(hit.items[0].sessionId, "other-canvas");
	// 警示必须落在**数据**里：事故证明模型会违反提示词规则，但会读 tool result 的字段
	assert.equal(hit.crossCanvasCount, 1);
	assert.match(String(hit.notice), /另一个画布/);
	assert.match(String(hit.notice), /不能/);
});

test("recall_memory：无跨画布条目时不出警示（不制造噪音）", async () => {
	const items = [{ id: "m2", content: "本画布", createdAt: "c", scope: "canvas", sessionId: "s1", crossCanvas: false }];
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items }));
	const hit = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { notice?: string; crossCanvasCount?: number };
	assert.equal(hit.notice, undefined);
	assert.equal(hit.crossCanvasCount, undefined);
});

test("终审 I-3：sessionId 是 pi 会话键回落时（无 trustedCanvasSessionId）不写 sessionId", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m9", createdAt: "c", scope: "user", sessionId: null }));
	// sessionId 形如 "s1:abc-def78"（toSessionKey 的 `<key>-<8位hash>` 形状），不是 Session.id
	const polluted = { sessionId: "s1:thread-9f2b1c4d", userId: "u1" } as LnkpiToolContext;
	const p = payload(await runTool(find(tools, "save_memory"), { content: "本画布项目知识" }, polluted)) as { note: string };
	assert.ok(!Object.prototype.hasOwnProperty.call(capture.body as object, "sessionId"), "body 不该带 sessionId");
	assert.match(p.note, /未确定归属/);
});

test("终审 I-3：有 trustedCanvasSessionId 时用它，而不是回落用的 sessionId", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m10", createdAt: "c" }));
	const mixed = { sessionId: "s1:thread-9f2b1c4d", trustedCanvasSessionId: "cmur1im5y0002lk01vukfb949", userId: "u1" } as LnkpiToolContext;
	await runTool(find(tools, "save_memory"), { content: "本画布项目知识" }, mixed);
	assert.equal((capture.body as { sessionId?: string }).sessionId, "cmur1im5y0002lk01vukfb949");
});

test("recall_memory：旧版 Nest（item 无归属字段）也能跑，crossCanvas 缺失按 false 处理", async () => {
	const items = [{ id: "legacy", content: "老数据", createdAt: "c" }];
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items }));
	const hit = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { count: number; notice?: string };
	assert.equal(hit.count, 1);
	assert.equal(hit.notice, undefined);
});

test("memory schema：暴露 scope 但绝不暴露 userId/sessionId（安全模型锁不放松）", () => {
	const tools = buildMemoryTools(fakeClient());
	const schema = JSON.stringify(tools.map((t) => t.parameters));
	assert.ok(!schema.includes("userId"));
	assert.ok(!schema.includes("sessionId"));
	assert.ok(schema.includes("scope"));
});
