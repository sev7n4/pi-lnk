import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMemoryTools, dropSuppressedForTest, isSuppressed, markSuppressed, MEMORY_CONTENT_MAX, MEMORY_RECALL_DEFAULT, MEMORY_RECALL_MAX } from "./memory.js";
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

// ── 反哺剔除（spec 2026-10-04-prompt-engineering §13.3 第 3 条，M6a）──
//
// 抑制表是**模块级进程内态**，本文件内所有用例共享同一份。
// 故每条用例必须用**独立 id**，否则后写的 markSuppressed 会污染前面的断言。
// 用 id 前缀区分用途，读报错的人一眼能看出是哪条用例埋的雷。

test("反哺：被标记抑制的记忆不进 recall 结果（剔除本体判据）", async () => {
	markSuppressed("mem-suppressed-a", "反复导致模型把跨画布记忆当当前画布观察");
	// 前置：抑制表确实登记了（否则下面「不出现」可能是因为根本没标记成功而假绿）
	assert.equal(isSuppressed("mem-suppressed-a"), true);
	const tools = buildMemoryTools(
		fakeClient({ calls: 0 }, { items: [{ id: "mem-suppressed-a", content: "主角叫林晚", createdAt: "2026-10-04" }] }),
	);
	const p = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { count: number; items: unknown[] };
	// 断言落在 count/items 而非「JSON 里没有这个字符串」：
	// 后者会被「字段被改名」「整体结构变了」骗过，前者才是「条目真的没进结果」。
	assert.equal(p.count, 0);
	assert.deepEqual(p.items, []);
});

test("反哺：未标记的记忆照常返回（fail-open 不得误杀好记忆）", async () => {
	markSuppressed("mem-suppressed-b", "另一条污染记忆");
	assert.equal(isSuppressed("mem-kept-b"), false);
	const items = [
		{ id: "mem-kept-b", content: "偏好暖色调", createdAt: "2026-10-04", scope: "user", sessionId: null, crossCanvas: false },
	];
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items }));
	const p = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { count: number; items: typeof items };
	assert.equal(p.count, 1);
	assert.deepEqual(p.items, items);
});

test("反哺：id 缺失时保留条目（无法判定就不删，fail-open 硬要求）", () => {
	// 判据设计说明（此处踩过两次假绿，最终锁成两层）：
	// 只测「无 id 条目被保留」**测不出** fail-open——`!it.id ||` 短路与 `Map.has(undefined)===false`
	// 是两道**冗余**防线，去掉任一道，剩下一道仍会保留该条目，测试恒绿。
	// 故下面两条分别锁住每一层：第二条锁 Map 语义，第一条锁剔除层短路。
	//
	// 第1 层：isSuppressed 对「无法判定」的 id 必须返回 false。
	// 这条是**直接断言判据本身**，因此能证伪「把空 id 当成已抑制」这种 fail-closed 硬化
	// （去掉剔除层短路后，那类硬化会真的开始误删无 id 条目——而只测端到端时它被掩盖）。
	assert.equal(isSuppressed(undefined as unknown as string), false, "空 id 必须视为「未抑制」");
	assert.equal(isSuppressed("" as unknown as string), false, "空串必须视为「未抑制」");

	// 第 2 层：剔除层对无 id 条目短路保留，且同批里真被抑制的条目确实被剔（对照组）。
	// 用「与被抑制记忆同文」的内容，确保判据是 id 而非内容——按内容剔除是跨画布污染的真实风险形态。
	const suppressedText = "反复致错的记忆正文";
	markSuppressed("mem-suppressed-by-text", suppressedText);
	const items = [
		{ content: suppressedText, createdAt: "2026-10-04" },
		{ id: "mem-suppressed-by-text", content: "另一条", createdAt: "2026-10-04" },
	];
	const kept = dropSuppressedForTest(items as never);
	assert.equal(kept.length, 1);
	assert.equal((kept[0] as { content: string }).content, suppressedText);
});

test("反哺：剔除发生在 crossCanvas 统计之前（不得出现「剔了但仍报 crossCanvasCount:1」）", async () => {
	// 这条锁的是「剔除点位置」而非剔除行为本身：
	// 若把 filter 写到 crossCanvas 计算之后，payload 里条目没了但 crossCanvasCount 仍是 1，
	// 而 notice 仍在替一条**已经不给模型看**的条目做跨画布警示——错位且无从察觉。
	markSuppressed("mem-suppressed-x", "唯一一条跨画布条目，剔除后不该再触发警示");
	const tools = buildMemoryTools(
		fakeClient({
			calls: 0,
		}, {
			items: [{ id: "mem-suppressed-x", content: "别的项目的角色设定", createdAt: "c", scope: "canvas", sessionId: "other", crossCanvas: true }],
		}),
	);
	const p = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as {
		count: number; crossCanvasCount?: number; notice?: string;
	};
	assert.equal(p.count, 0);
	assert.equal(p.crossCanvasCount, undefined);
	assert.equal(p.notice, undefined);
});

test("反哺：抑制动作通知可观测钩子，且同一条幂等（不重复计数）", () => {
	// 计数器在 metrics.ts（归指标治理窗口），抑制动作在本模块——这条锁的是本模块的**边界契约**：
	// 「新标记一条 ⇒ 通知一次；重复标记同一条 ⇒ 不再通知」。契约一旦断，指标会永远是 0，
	// 看着像「从未污染」，实际是接线断了（静默降级）。
	const notified: number[] = [];
	const observer = { observeMemorySuppressed: () => { notified.push(1); } };
	markSuppressed("mem-suppressed-observer", "钩子接线取证", observer);
	assert.equal(notified.length, 1);
	// 幂等：同一条重复标记不得重复通知（钩子语义是「被抑制的记忆条数」，不是「标记调用次数」）
	markSuppressed("mem-suppressed-observer", "重复标记", observer);
	assert.equal(notified.length, 1);
	// 反例对照：换一条新 id 必须再通知一次——否则「通知了」这条断言恒真（钩子压根没接）。
	markSuppressed("mem-suppressed-observer-2", "另一条污染", observer);
	assert.equal(notified.length, 2);
	// 不传 observer 也必须能标记（纯进程内记账，不因拿不到指标实例而失效）
	markSuppressed("mem-suppressed-observer-3", "无钩子");
	assert.equal(notified.length, 2);
	assert.equal(isSuppressed("mem-suppressed-observer-3"), true);
});

test("recall_memory：透传 Nest 返回的 truncated 标记给模型", async () => {
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items: [{ id: "m1", content: "x", createdAt: "c" }], truncated: true }));
	const p = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { truncated?: boolean; count: number };
	assert.equal(p.truncated, true);
});
