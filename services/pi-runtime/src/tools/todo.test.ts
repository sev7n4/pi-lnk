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
