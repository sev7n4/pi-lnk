import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildTodoTools, getTodoState, resetTodoStoreForTest } from "./todo.js";
import type { LnkpiToolContext } from "./types.js";
import type { AcceptanceOutcome, GenerationOracle, OracleResult, TodoAcceptance } from "./acceptance.js";

const ctx: LnkpiToolContext = { sessionId: "sess-C2", userId: "user-C2" };

type TodoTool = ReturnType<typeof buildTodoTools>[number];
/** 自带参数类型：0.99.2 的 execute 参数是 {todos: TodoItemInput[]}，本机陈旧 0.85.1 是 unknown，
 *  用窄面结构可同时对两边赋值兼容（不靠 as never 绕类型）。 */
type TodoCallItem = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	id?: string;
	activeForm?: string;
	acceptance?: TodoAcceptance;
};
type TodoParams = { todos: TodoCallItem[] };
/** 旧版 harness 第 5 参要求 AgentHarnessToolInvocation 字段；0.99.2 为 unknown，两边都接受。 */
const invocation = {
	invocationId: "inv-1",
	operationId: "op-1",
	turnId: "turn-1",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

/** 旧版 harness 第 6 参要求 Context{abortSignal,value}；0.99.2 为 unknown，两边都接受。 */
const context = { abortSignal: new AbortController().signal, value: () => undefined };

function run(t: TodoTool, params: TodoParams, session: LnkpiToolContext = ctx) {
	return t.execute("call-t", params, () => {}, session, invocation, context);
}

/** isError 在 0.99.2 的 AgentToolResult 上存在、本机 0.85.1 类型里没有 ⇒ 守卫式读取。 */
function isError(res: unknown): boolean | undefined {
	return (res as { isError?: boolean }).isError;
}

/** 可控 oracle：记录调用次数，返回结果可逐例配置。 */
function fakeOracle(result: OracleResult = { ok: true, latest: { id: "gen-1", status: "succeeded" } }) {
	const calls: Array<{ sessionId: string; userId: string }> = [];
	const outcomes: AcceptanceOutcome[] = [];
	const oracle: GenerationOracle = {
		async inspect(input) {
			calls.push(input);
			return result;
		},
	};
	return { oracle, calls, outcomes, onAcceptanceOutcome: (o: AcceptanceOutcome) => outcomes.push(o) };
}

function toolWith(result: OracleResult = { ok: true, latest: { id: "gen-1", status: "succeeded" } }) {
	const f = fakeOracle(result);
	const [t] = buildTodoTools({ oracle: f.oracle, onAcceptanceOutcome: f.onAcceptanceOutcome });
	return { ...f, t };
}

const completedWithAcceptance = (requireSucceeded?: boolean) => [
	{
		content: "生成海报",
		status: "completed" as const,
		acceptance: {
			kind: "generation" as const,
			...(requireSucceeded === undefined ? {} : { generation: { requireSucceeded } }),
		},
	},
];

beforeEach(() => {
	resetTodoStoreForTest();
	delete process.env.PI_RUNTIME_ACCEPTANCE;
});

test("C-2a ①: succeeded 级 + 证据充分 ⇒ 正常写入，diff 正常，计数 pass", async () => {
	const { t, calls, outcomes } = toolWith();
	const res = await run(t, { todos: completedWithAcceptance(true) });
	assert.equal(isError(res), undefined);
	const details = res.details as { todo: { snapshot: unknown[]; diff: { list?: unknown[] } } };
	assert.equal(details.todo.snapshot.length, 1);
	assert.equal(details.todo.diff.list?.length, 1);
	assert.equal(calls.length, 1);
	assert.deepEqual(outcomes, ["declared", "pass"]);
});

test("C-2a ②: 证据不足（status=failed）⇒ isError 硬拒 + 零副作用 + 证据差回执", async () => {
	const { t, outcomes } = toolWith({ ok: true, latest: { id: "gen-9", status: "failed" } });
	const res = await run(t, { todos: completedWithAcceptance(true) });
	assert.equal(isError(res), true);
	const text = res.content[0].type === "text" ? res.content[0].text : "";
	assert.match(text, /调用被拒绝/);
	assert.match(text, /status=failed/);
	assert.match(text, /gen-9/);
	assert.match(text, /当前清单保持不变/);
	assert.match(text, /不要标 completed/);
	const details = res.details as { todo: { snapshot: unknown[]; diff: { updates: unknown[]; list?: unknown[] } } };
	assert.deepEqual(details.todo.snapshot, []);
	assert.deepEqual(details.todo.diff.updates, []);
	assert.equal(details.todo.diff.list, undefined);
	assert.deepEqual(getTodoState("sess-C2"), []);
	assert.deepEqual(outcomes, ["declared", "fail_closed"]);
});

test("C-2a ③: submitted 级 + 无生成记录 ⇒ 拒绝（弱判据也要有记录）", async () => {
	const { t, outcomes } = toolWith({ ok: true });
	const res = await run(t, { todos: completedWithAcceptance() });
	assert.equal(isError(res), true);
	const text = res.content[0].type === "text" ? res.content[0].text : "";
	assert.match(text, /无生成记录/);
	assert.deepEqual(outcomes, ["declared", "fail_closed"]);
});

test("C-2a ④: oracle 查询失败 ⇒ fail-open 放行 + 软提醒 + 计数", async () => {
	const { t, outcomes } = toolWith({ ok: false, reason: "timeout" });
	const res = await run(t, { todos: completedWithAcceptance(true) });
	assert.equal(isError(res), undefined);
	const text = res.content[0].type === "text" ? res.content[0].text : "";
	assert.match(text, /共 1 项/);
	assert.match(text, /\[acceptance\]/);
	assert.match(text, /timeout/);
	assert.match(text, /请勿据此视为验收通过/);
	assert.equal((res.details as { todo: { snapshot: unknown[] } }).todo.snapshot.length, 1);
	assert.deepEqual(outcomes, ["declared", "fail_open"]);
});

test("C-2a ⑤: acceptance 结构非法（kind 未知/自由文本）⇒ 硬拒且零副作用、不查 oracle", async () => {
	for (const acceptance of [
		{ kind: "canvas_state" },
		{ kind: "generation", note: "效果不错" },
		{ kind: "generation", generation: { requireSucceeded: "true" } },
	]) {
		resetTodoStoreForTest();
		const { t, calls } = toolWith();
		const res = await run(t, {
			todos: [{ content: "生成海报", status: "completed", acceptance }] as unknown as TodoCallItem[],
		});
		assert.equal(isError(res), true, `acceptance=${JSON.stringify(acceptance)} 应硬拒`);
		assert.equal(calls.length, 0);
		assert.deepEqual(getTodoState("sess-C2"), []);
	}
});

test("C-2a ⑥: 无 acceptance ⇒ 逐字节旧行为（不查 oracle、回执无提醒）", async () => {
	const { t, calls, outcomes } = toolWith();
	const res = await run(t, { todos: [{ content: "起稿", status: "in_progress" }] });
	assert.equal(calls.length, 0);
	assert.deepEqual(outcomes, []);
	const text = res.content[0].type === "text" ? res.content[0].text : "";
	assert.match(text, /共 1 项/);
	assert.doesNotMatch(text, /acceptance/);
	assert.equal(isError(res), undefined);
});

test("C-2a ⑦: pending/in_progress 项带 acceptance ⇒ 不查、不拦", async () => {
	const { t, calls, outcomes } = toolWith({ ok: false, reason: "should-not-query" });
	const res = await run(t, {
		todos: [
			{
				content: "生成海报",
				status: "in_progress",
				acceptance: { kind: "generation", generation: { requireSucceeded: true } },
			},
		],
	});
	assert.equal(isError(res), undefined);
	assert.equal(calls.length, 0);
	assert.deepEqual(outcomes, []);
});

test("C-2a ⑧: kill switch off ⇒ 不查（逐字节旧行为）", async () => {
	process.env.PI_RUNTIME_ACCEPTANCE = "off";
	try {
		const { t, calls } = toolWith({ ok: false, reason: "should-not-query" });
		const res = await run(t, { todos: completedWithAcceptance(true) });
		assert.equal(isError(res), undefined);
		assert.equal(calls.length, 0);
		assert.doesNotMatch(res.content[0].type === "text" ? res.content[0].text : "", /\[acceptance\]/);
	} finally {
		delete process.env.PI_RUNTIME_ACCEPTANCE;
	}
});

test("C-2a ⑨: 多个 completed 声明只查一次；缺 userId ⇒ 静默放行不查", async () => {
	const { t, calls, outcomes } = toolWith();
	const multi = await run(t, {
		todos: [
			...completedWithAcceptance(true),
			{ content: "生成封面", status: "completed", acceptance: { kind: "generation" } },
		],
	});
	assert.equal(isError(multi), undefined);
	assert.equal(calls.length, 1);
	assert.deepEqual(outcomes, ["declared", "pass"]);

	const f2 = fakeOracle({ ok: false, reason: "should-not-query" });
	const [t2] = buildTodoTools({ oracle: f2.oracle, onAcceptanceOutcome: f2.onAcceptanceOutcome });
	const noUser = await run(t2, { todos: completedWithAcceptance(true) }, { sessionId: "sess-C2" });
	assert.equal(isError(noUser), undefined);
	assert.equal(f2.calls.length, 0);
	assert.doesNotMatch(noUser.content[0].type === "text" ? noUser.content[0].text : "", /\[acceptance\]/);
});
