import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildTodoTools, seedTodoState, getTodoState, resetTodoStoreForTest } from "./todo.js";
import type { LnkpiToolContext } from "./types.js";

const ctx = { sessionId: "sess-A" } as LnkpiToolContext;

beforeEach(() => resetTodoStoreForTest());

function tool() {
	const [t] = buildTodoTools();
	if (t.name !== "todo_write") throw new Error("todo_write 未注册");
	return t;
}

/** vendor execute 为 6 参签名（toolCallId, params, onUpdate, toolContext, invocation, context），
 * 全部必选（tiering.test.ts 同款姿势：无值处 as never）。 */
function run(
	t: ReturnType<typeof buildTodoTools>[number],
	params: { todos: Array<{ content: string; status: string }> },
	session: LnkpiToolContext = ctx,
) {
	return t.execute("call-t", params as never, () => {}, session as never, {} as never, undefined as never);
}

test("首次调用：返回快照 + diff（全量 list）+ 紧凑摘要 content", async () => {
	const res = await run(tool(), { todos: [{ content: "起稿", status: "in_progress" }] });
	assert.equal((res.details as { todo: { snapshot: unknown[] } }).todo.snapshot.length, 1);
	assert.equal((res.details as { todo: { diff: { list?: unknown[] } } }).todo.diff.list?.length, 1);
	const first = res.content[0];
	assert.equal(first.type, "text");
	assert.ok(first.type === "text" && first.text.includes("共 1 项"));
});

test("状态不变更的重复提交 → 空更新 + 幂等", async () => {
	const t = tool();
	await run(t, { todos: [{ content: "起稿", status: "pending" }] });
	const res = await run(t, { todos: [{ content: "起稿", status: "pending" }] });
	assert.deepEqual((res.details as { todo: { diff: { updates: unknown[] } } }).todo.diff.updates, []);
	assert.equal((res.details as { todo: { diff: { list?: unknown[] } } }).todo.diff.list, undefined);
});

test("kill switch off → buildTodoTools 返回空数组", () => {
	process.env.PI_RUNTIME_TODO_TOOL = "off";
	try {
		assert.deepEqual(buildTodoTools(), []);
	} finally {
		delete process.env.PI_RUNTIME_TODO_TOOL;
	}
});

test("漏发告警：prev 未完成项从 next 消失 → console.warn（结构化前缀）", async () => {
	const t = tool();
	await run(t, {
		todos: [
			{ content: "起稿", status: "in_progress" },
			{ content: "配图", status: "pending" },
		],
	});
	const warnings: string[] = [];
	const orig = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
	try {
		await run(t, { todos: [{ content: "配图", status: "pending" }] });
	} finally {
		console.warn = orig;
	}
	assert.ok(warnings.some((w) => w.includes("[todo_write] dropped-incomplete")));
});

test("seed/get：session-manager 播种后 getTodoState 可读，工具调用覆盖播种值", async () => {
	seedTodoState("sess-B", [{ id: "plan-1", content: "旧任务", status: "pending" }]);
	assert.equal(getTodoState("sess-B")[0].content, "旧任务");
	await run(tool(), { todos: [{ content: "新任务", status: "pending" }] }, {
		sessionId: "sess-B",
	} as LnkpiToolContext);
	assert.equal(getTodoState("sess-B")[0].content, "新任务");
});

// ===== A-2' 硬拒绝与告警修正（spec 2026-11-13-a2-model-side-id-contract-design.md §3.3）=====

test("A-2' ②: 幻觉 id ⇒ isError 硬拒绝 + 合法 id 清单回执 + 零副作用（拍板 1）", async () => {
	const t = tool();
	await run(t, { todos: [{ content: "甲", status: "pending" }] });
	const before = getTodoState("sess-A");
	const res = await run(t, { todos: [{ id: "plan-999", content: "幻觉", status: "pending" }] } as never);
	assert.equal((res as { isError?: boolean }).isError, true);
	const first = res.content[0];
	assert.ok(first.type === "text" && first.text.includes("plan-1"), "回执附当前合法 id 清单");
	assert.deepEqual(getTodoState("sess-A"), before, "拒绝调用零副作用");
});

test("A-2' ②b: 合法 id 重命名通过 + dropped 告警不误报（重命名场景）", async () => {
	const t = tool();
	await run(t, { todos: [{ content: "起稿", status: "in_progress" }] });
	const warnings: string[] = [];
	const orig = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
	try {
		const res = await run(t, { todos: [{ id: "plan-1", content: "起稿（v2）", status: "in_progress" }] } as never);
		assert.equal((res as { isError?: boolean }).isError, undefined);
	} finally {
		console.warn = orig;
	}
	assert.ok(!warnings.some((w) => w.includes("dropped-incomplete")), "id 存活的旧 content 消失不算 dropped");
	const state = getTodoState("sess-A");
	assert.equal(state[0].id, "plan-1");
	assert.equal(state[0].content, "起稿（v2）");
});

test("A-2' ②c: 校验键走 storeScopeKey（子会话校验自己的作用域，C4 取键约定）", async () => {
	const t = tool();
	await run(t, { todos: [{ content: "主会话任务", status: "pending" }] }, { sessionId: "sess-main" } as LnkpiToolContext);
	await run(t, { todos: [{ content: "子会话任务", status: "pending" }] }, { storeScopeKey: "sess-child", sessionId: "sess-main" } as never);
	// 子会话作用域内 plan-1 合法；主会话的 plan-1 在子作用域不存在
	const res = await run(t, { todos: [{ id: "plan-1", content: "子会话改", status: "pending" }] }, { storeScopeKey: "sess-child", sessionId: "sess-main" } as never);
	assert.equal((res as { isError?: boolean }).isError, undefined);
	const child = getTodoState("sess-child");
	assert.equal(child[0].content, "子会话改");
	const main = getTodoState("sess-main");
	assert.equal(main[0].content, "主会话任务", "主会话不受子会话调用影响");
});
