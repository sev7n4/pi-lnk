import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildTodoTools, getTodoState, resetTodoStoreForTest } from "./todo.js";
import type { LnkpiToolContext } from "./types.js";
import type {
	AcceptanceOutcome,
	CanvasOracle,
	CanvasOracleResult,
	GenerationOracle,
	OracleResult,
	TodoAcceptance,
} from "./acceptance.js";

const ctx: LnkpiToolContext = { sessionId: "sess-C2B", userId: "user-C2B" };

type TodoTool = ReturnType<typeof buildTodoTools>[number];
type TodoCallItem = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	id?: string;
	activeForm?: string;
	acceptance?: TodoAcceptance;
};
type TodoParams = { todos: TodoCallItem[] };
const invocation = {
	invocationId: "inv-1",
	operationId: "op-1",
	turnId: "turn-1",
	getMemo: async () => undefined,
	setMemo: async () => {},
};
const context = { abortSignal: new AbortController().signal, value: () => undefined };

function run(t: TodoTool, params: TodoParams, session: LnkpiToolContext = ctx) {
	return t.execute("call-t", params, () => {}, session, invocation, context);
}
function isError(res: unknown): boolean | undefined {
	return (res as { isError?: boolean }).isError;
}
function text(res: Awaited<ReturnType<typeof run>>): string {
	return res.content[0].type === "text" ? res.content[0].text : "";
}

function setup(opts: {
	gen?: OracleResult;
	canvas?: CanvasOracleResult;
} = {}) {
	const genCalls: Array<{ sessionId: string; userId: string }> = [];
	const canvasCalls: Array<{ sessionId: string }> = [];
	const outcomes: AcceptanceOutcome[] = [];
	const kinds: string[] = [];
	const gen: GenerationOracle = {
		async inspect(input) {
			genCalls.push(input);
			return opts.gen ?? { ok: true, latest: { id: "gen-1", status: "succeeded" } };
		},
	};
	const canvas: CanvasOracle = {
		async inspect(input) {
			canvasCalls.push(input);
			return opts.canvas ?? { ok: true, canvas: { nodeCount: 3, typeCounts: { image: 3 } } };
		},
	};
	const [t] = buildTodoTools({
		oracle: gen,
		canvasOracle: canvas,
		onAcceptanceOutcome: (o) => outcomes.push(o),
		onAcceptanceKind: (k) => kinds.push(k),
	});
	return { t, genCalls, canvasCalls, outcomes, kinds };
}

const canvasItem = (canvasState: TodoAcceptance["canvasState"] = { nodeCount: { min: 1 } }): TodoCallItem => ({
	content: "把节点摆上画布",
	status: "completed",
	acceptance: { kind: "canvas_state", canvasState },
});
const genItem = (): TodoCallItem => ({
	content: "生成海报",
	status: "completed",
	acceptance: { kind: "generation", generation: { requireSucceeded: true } },
});

beforeEach(() => {
	resetTodoStoreForTest();
	delete process.env.PI_RUNTIME_ACCEPTANCE;
});

test("C-2b ①: 画布证据充分 ⇒ 正常写入；只查 canvas oracle、不查 generation", async () => {
	const { t, genCalls, canvasCalls, outcomes, kinds } = setup();
	const res = await run(t, { todos: [canvasItem()] });
	assert.equal(isError(res), undefined);
	assert.match(text(res), /共 1 项/);
	assert.equal((res.details as { todo: { snapshot: unknown[] } }).todo.snapshot.length, 1);
	assert.equal(getTodoState("sess-C2B").length, 1);
	assert.equal(genCalls.length, 0);
	assert.equal(canvasCalls.length, 1);
	assert.deepEqual(outcomes, ["declared", "pass"]);
	assert.deepEqual(kinds, ["canvas_state"]);
});

test("C-2b ②: 画布证据不足（0 节点）⇒ isError 硬拒 + 零副作用 + 证据差回执", async () => {
	const { t, outcomes } = setup({ canvas: { ok: true, canvas: { nodeCount: 0, typeCounts: {} } } });
	const res = await run(t, { todos: [canvasItem({ nodeCount: { min: 1 } })] });
	assert.equal(isError(res), true);
	assert.match(text(res), /调用被拒绝/);
	assert.match(text(res), /画布证据不支持/);
	assert.match(text(res), /画布节点数=0/);
	assert.match(text(res), /低于下限 1/);
	assert.match(text(res), /当前清单保持不变/);
	const details = res.details as { todo: { snapshot: unknown[]; diff: { updates: unknown[] } } };
	assert.deepEqual(details.todo.snapshot, []);
	assert.deepEqual(details.todo.diff.updates, []);
	assert.deepEqual(getTodoState("sess-C2B"), []);
	assert.deepEqual(outcomes, ["declared", "fail_closed"]);
});

test("C-2b ③: nodeTypeCounts 不满足 ⇒ 硬拒且证据差带同款文案", async () => {
	const { t } = setup({ canvas: { ok: true, canvas: { nodeCount: 2, typeCounts: { text: 2 } } } });
	const res = await run(t, { todos: [canvasItem({ nodeTypeCounts: { image: { min: 1 } } })] });
	assert.equal(isError(res), true);
	assert.match(text(res), /image 节点数 0/);
});

test("C-2b ④: canvas oracle 查询失败 ⇒ fail-open 放行 + 软提醒 + 计数", async () => {
	const { t, outcomes } = setup({ canvas: { ok: false, reason: "timeout" } });
	const res = await run(t, { todos: [canvasItem()] });
	assert.equal(isError(res), undefined);
	assert.match(text(res), /共 1 项/);
	assert.match(text(res), /\[acceptance\]/);
	assert.match(text(res), /画布证据查询失败/);
	assert.match(text(res), /timeout/);
	assert.equal(getTodoState("sess-C2B").length, 1);
	assert.deepEqual(outcomes, ["declared", "fail_open"]);
});

test("C-2b ⑤ ⭐ 多 kind：generation pass + canvas reject ⇒ 整体 reject（reject 优先级最高）", async () => {
	const { t, genCalls, canvasCalls, outcomes } = setup({
		canvas: { ok: true, canvas: { nodeCount: 0, typeCounts: {} } },
	});
	const res = await run(t, { todos: [genItem(), canvasItem()] });
	assert.equal(isError(res), true);
	assert.match(text(res), /画布证据不支持/);
	assert.equal(genCalls.length, 1);
	assert.equal(canvasCalls.length, 1);
	assert.deepEqual(getTodoState("sess-C2B"), []);
	assert.deepEqual(outcomes, ["declared", "fail_closed"]);
});

test("C-2b ⑥ ⭐ 多 kind：generation fail-open + canvas reject ⇒ 仍 reject（fail-open 不覆盖 reject）", async () => {
	const { t, outcomes } = setup({
		gen: { ok: false, reason: "gen-timeout" },
		canvas: { ok: true, canvas: { nodeCount: 0, typeCounts: {} } },
	});
	const res = await run(t, { todos: [genItem(), canvasItem()] });
	assert.equal(isError(res), true);
	assert.doesNotMatch(text(res), /请勿据此视为验收通过/);
	assert.deepEqual(outcomes, ["declared", "fail_open", "fail_closed"]);
});

test("C-2b ⑦ 多 kind：两组都查失败 ⇒ 软提醒含两段、放行写入", async () => {
	const { t, outcomes } = setup({
		gen: { ok: false, reason: "gen-timeout" },
		canvas: { ok: false, reason: "canvas-timeout" },
	});
	const res = await run(t, { todos: [genItem(), canvasItem()] });
	assert.equal(isError(res), undefined);
	assert.match(text(res), /生成证据查询失败/);
	assert.match(text(res), /画布证据查询失败/);
	assert.equal(getTodoState("sess-C2B").length, 2);
	assert.deepEqual(outcomes, ["declared", "fail_open", "fail_open"]);
});

test("C-2b ⑧ 多 kind：两组证据都充分 ⇒ pass + kind 计数按项记录", async () => {
	const { t, outcomes, kinds } = setup();
	const res = await run(t, { todos: [genItem(), canvasItem()] });
	assert.equal(isError(res), undefined);
	assert.deepEqual(outcomes, ["declared", "pass"]);
	assert.deepEqual(kinds, ["generation", "canvas_state"]);
});

test("C-2b ⑨: canvas 组不需要 userId（缺 userId 仍查画布 oracle）", async () => {
	const { t, canvasCalls } = setup();
	const res = await run(t, { todos: [canvasItem()] }, { sessionId: "sess-C2B" });
	assert.equal(isError(res), undefined);
	assert.equal(canvasCalls.length, 1);
});

test("C-2b ⑩: 未注入 canvasOracle ⇒ 该组静默 skip（不查、不拦，逐字节旧行为）", async () => {
	const outcomes: AcceptanceOutcome[] = [];
	const [t] = buildTodoTools({
		oracle: { async inspect() { throw new Error("should-not-query"); } },
		onAcceptanceOutcome: (o) => outcomes.push(o),
	});
	const res = await run(t, { todos: [canvasItem()] });
	assert.equal(isError(res), undefined);
	assert.match(text(res), /共 1 项/);
	assert.doesNotMatch(text(res), /\[acceptance\]/);
	assert.deepEqual(outcomes, ["declared"]);
});

test("C-2b ⑪: 结构非法（canvas_state 无谓词）⇒ 硬拒且不查任何 oracle", async () => {
	const { t, genCalls, canvasCalls } = setup();
	const res = await run(t, {
		todos: [{ content: "摆节点", status: "completed", acceptance: { kind: "canvas_state" } }],
	});
	assert.equal(isError(res), true);
	assert.match(text(res), /acceptance 字段非法/);
	assert.equal(genCalls.length, 0);
	assert.equal(canvasCalls.length, 0);
	assert.deepEqual(getTodoState("sess-C2B"), []);
});

test("C-2b ⑫: kill switch off ⇒ 两组都不查", async () => {
	process.env.PI_RUNTIME_ACCEPTANCE = "off";
	try {
		const { t, genCalls, canvasCalls } = setup({ canvas: { ok: false, reason: "x" } });
		const res = await run(t, { todos: [genItem(), canvasItem()] });
		assert.equal(isError(res), undefined);
		assert.equal(genCalls.length, 0);
		assert.equal(canvasCalls.length, 0);
		assert.doesNotMatch(text(res), /\[acceptance\]/);
	} finally {
		delete process.env.PI_RUNTIME_ACCEPTANCE;
	}
});
