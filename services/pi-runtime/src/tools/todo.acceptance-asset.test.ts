import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTodoTools, getTodoState, resetTodoStoreForTest, seedTodoState } from "./todo.js";
import {
	createNestAssetContractOracle,
	type AssetContractJudgeInput,
	type AssetContractOracle,
	type AssetContractOracleResult,
	type AcceptanceOutcome,
	type OracleNestClient,
} from "./acceptance.js";
import type { LnkpiToolContext } from "./types.js";

/** D-1 契约（spec §8.2-2/3 + Review Focus 4）：
 * 1. asset_contract 判定 reject ⇒ execute 返回 rejectionResult（快照不变 / diff.updates=[] / rejected:true）；
 * 2. 判定器输入的 client 查询故障 ⇒ fail-open：放行但回执带「查询失败已放行，勿视为验收通过」+ 计数 fail_open，不产生 pass；
 * 3. 结构非法（零谓词 / kind 错配）⇒ 零副作用硬拒（非 fail-open），执行层不可达查询路径；
 * 4. PI_RUNTIME_ACCEPTANCE=off ⇒ 整个 acceptance 分支跳过（既有 kill switch 语义不扩面）。
 * 夹具形态照 todo.acceptance.test.ts 现行 deps fake 抄写。 */

const ctx: LnkpiToolContext = { sessionId: "sess-D1", userId: "user-D1" };

type TodoTool = ReturnType<typeof buildTodoTools>[number];
/** 自带参数类型：0.99.2 的 execute 参数是 {todos: TodoItemInput[]}，本机陈旧 0.85.1 是 unknown，
 *  用窄面结构可同时对两边赋值兼容（不靠 as never 绕类型）。 */
type TodoCallItem = {
	content: string;
	status: "pending" | "in_progress" | "completed";
	id?: string;
	activeForm?: string;
	acceptance?: Record<string, unknown>;
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

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	return res.content[0].type === "text" ? (res.content[0].text ?? "") : "";
}

/** 判定通过的服务端证据夹具（judge* 全 pass）。 */
const goodInput: AssetContractJudgeInput = {
	registeredIds: ["hero", "scene-1"],
	referencedIds: ["hero"],
	authorities: [{ dimension: "face", materialId: "m1", accepted: true, pinned: true }],
	durationRows: [{ shotId: "s1", durationMs: 2000, dialogueChars: 9 }],
};

/** 可控 asset oracle：记录调用次数，返回结果可逐例配置。 */
function fakeAssetOracle(result: AssetContractOracleResult) {
	const calls: Array<{ sessionId: string }> = [];
	const oracle: AssetContractOracle = {
		async inspect(input) {
			calls.push(input);
			return result;
		},
	};
	return { oracle, calls };
}

function toolWith(
	assetResult: AssetContractOracleResult = { ok: true, input: goodInput },
): { t: TodoTool; calls: Array<{ sessionId: string }>; outcomes: AcceptanceOutcome[] } {
	const f = fakeAssetOracle(assetResult);
	const outcomes: AcceptanceOutcome[] = [];
	const [t] = buildTodoTools({ assetOracle: f.oracle, onAcceptanceOutcome: (o) => outcomes.push(o) });
	return { t, calls: f.calls, outcomes };
}

const completedWithAssetContract = (preds: Record<string, boolean>) => [
	{
		content: "收尾交付",
		status: "completed" as const,
		acceptance: { kind: "asset_contract", assetContract: preds },
	},
];

beforeEach(() => {
	resetTodoStoreForTest();
	delete process.env.PI_RUNTIME_ACCEPTANCE;
});

// ═══ 契约 ①：判定 reject ⇒ rejectionResult 路径（接线级正向证据） ═══

test("D-1 ①: idClosure 判定 reject（孤儿引用）⇒ execute 走 rejectionResult：isError + 快照不变 + diff.updates=[] + rejected:true", async () => {
	const seeded = [{ id: "plan-1", content: "起稿", status: "in_progress" as const }];
	seedTodoState("sess-D1", seeded);
	const { t, calls, outcomes } = toolWith({
		ok: true,
		input: { ...goodInput, referencedIds: ["hero", "ghost"] },
	});
	const res = await run(t, {
		todos: [
			{ id: "plan-1", content: "起稿", status: "in_progress" },
			...completedWithAssetContract({ idClosure: true }),
		],
	});
	assert.equal(isError(res), true);
	assert.match(textOf(res), /调用被拒绝/);
	assert.match(textOf(res), /收尾交付/);
	assert.match(textOf(res), /孤儿引用/);
	assert.match(textOf(res), /当前清单保持不变/);
	assert.match(textOf(res), /不要标 completed/);
	// 接线正向证据：oracle 被真实查询过（生产路径可达，非机制空转）
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { sessionId: "sess-D1" });
	// rejectionResult 三件套：快照不变 / diff.updates=[] / rejected:true
	const details = res.details as {
		todo: { snapshot: unknown[]; diff: { updates: unknown[]; list?: unknown[] }; rejected?: boolean };
	};
	assert.deepEqual(details.todo.snapshot, seeded);
	assert.deepEqual(details.todo.diff.updates, []);
	assert.equal(details.todo.diff.list, undefined);
	assert.equal(details.todo.rejected, true);
	assert.deepEqual(getTodoState("sess-D1"), seeded);
	assert.deepEqual(outcomes, ["declared", "fail_closed"]);
});

test("D-1 ①b: durationBudget 判定 reject（台词超预算）⇒ 同走 rejectionResult 路径", async () => {
	const { t, outcomes } = toolWith({
		ok: true,
		input: { ...goodInput, durationRows: [{ shotId: "s1", durationMs: 2000, dialogueChars: 10 }] },
	});
	const res = await run(t, { todos: completedWithAssetContract({ durationBudget: true }) });
	assert.equal(isError(res), true);
	assert.match(textOf(res), /台词超时长预算/);
	const details = res.details as { todo: { snapshot: unknown[]; diff: { updates: unknown[] }; rejected?: boolean } };
	assert.deepEqual(details.todo.snapshot, []);
	assert.deepEqual(details.todo.diff.updates, []);
	assert.equal(details.todo.rejected, true);
	assert.deepEqual(outcomes, ["declared", "fail_closed"]);
});

test("D-1 ①c: 三谓词全 pass ⇒ 正常写入 + 计数 pass（接线双向证据）", async () => {
	const { t, calls, outcomes } = toolWith();
	const res = await run(t, { todos: completedWithAssetContract({ idClosure: true, authorityRef: true, durationBudget: true }) });
	assert.equal(isError(res), undefined);
	assert.match(textOf(res), /共 1 项/);
	assert.doesNotMatch(textOf(res), /\[acceptance\]/);
	assert.equal(calls.length, 1);
	assert.deepEqual(outcomes, ["declared", "pass"]);
});

test("D-1 ①d: 多个 asset_contract 声明同组复用一次快照查询", async () => {
	const { t, calls, outcomes } = toolWith();
	const res = await run(t, {
		todos: [
			...completedWithAssetContract({ idClosure: true }),
			{ content: "收尾二", status: "completed" as const, acceptance: { kind: "asset_contract", assetContract: { durationBudget: true } } },
		],
	});
	assert.equal(isError(res), undefined);
	assert.equal(calls.length, 1);
	assert.deepEqual(outcomes, ["declared", "pass"]);
});

// ═══ 契约 ②：client 查询故障 ⇒ fail-open（经 createNestAssetContractOracle 真实 client 形态） ═══

test("D-1 ②: client 查询故障 ⇒ fail-open 放行 + 回执带「查询失败已放行，勿视为验收通过」+ 计数 fail_open 不产生 pass", async () => {
	const posts: Array<{ path: string; body: unknown }> = [];
	const client: OracleNestClient = {
		async post(path, body) {
			posts.push({ path, body });
			throw new Error("boom");
		},
	};
	const outcomes: AcceptanceOutcome[] = [];
	const [t] = buildTodoTools({
		assetOracle: createNestAssetContractOracle(client),
		onAcceptanceOutcome: (o) => outcomes.push(o),
	});
	const res = await run(t, { todos: completedWithAssetContract({ idClosure: true }) });
	assert.equal(isError(res), undefined);
	const text = textOf(res);
	assert.match(text, /共 1 项/);
	assert.match(text, /\[acceptance\]/);
	assert.match(text, /查询失败（boom）/);
	assert.match(text, /已放行/);
	assert.match(text, /请勿据此视为验收通过/);
	assert.match(text, /boom/);
	// 端点形态对齐 judgeCanvasAcceptance（post + {sessionId}）
	assert.equal(posts.length, 1);
	assert.equal(posts[0].path, "/agent/internal/get-asset-contract-snapshot");
	assert.deepEqual(posts[0].body, { sessionId: "sess-D1" });
	// 放行 = 写入照常发生
	const details = res.details as { todo: { snapshot: unknown[] } };
	assert.equal(details.todo.snapshot.length, 1);
	assert.deepEqual(outcomes, ["declared", "fail_open"]);
	assert.ok(!outcomes.includes("pass"), "fail-open 不得产生 pass 计数");
});

// ═══ 契约 ③：结构非法 ⇒ 零副作用硬拒（非 fail-open），执行层不可达查询路径 ═══

test("D-1 ③: 结构非法（零谓词/载荷缺失/kind 错配）⇒ 硬拒零副作用，且不触发任何查询（parse 层拦截，执行层不可达 IO）", async () => {
	for (const acceptance of [
		{ kind: "asset_contract" },
		{ kind: "asset_contract", assetContract: {} },
		{ kind: "asset_contract", assetContract: { idClosure: false, authorityRef: false, durationBudget: false } },
		{ kind: "asset_contract", canvasState: { nodeCount: { max: 3 } } },
		{ kind: "asset_contract", assetContract: { idClosure: "yes" } },
	]) {
		resetTodoStoreForTest();
		const { t, calls, outcomes } = toolWith();
		const res = await run(t, {
			todos: [{ content: "收尾交付", status: "completed", acceptance }] as unknown as TodoCallItem[],
		});
		assert.equal(isError(res), true, `acceptance=${JSON.stringify(acceptance)} 应硬拒`);
		assert.match(textOf(res), /调用被拒绝/);
		// 执行层不可达该路径：判定器输入从未被查询（零 IO）
		assert.equal(calls.length, 0, `acceptance=${JSON.stringify(acceptance)} 不得触发 oracle 查询`);
		assert.deepEqual(getTodoState("sess-D1"), []);
		assert.deepEqual(outcomes, ["declared"]);
	}
});

// ═══ 契约 ④：kill switch off ⇒ 整个 acceptance 分支跳过（既有语义不扩面） ═══

test("D-1 ④: PI_RUNTIME_ACCEPTANCE=off ⇒ asset_contract 声明也不查、不拦（逐字节旧行为）", async () => {
	process.env.PI_RUNTIME_ACCEPTANCE = "off";
	try {
		const { t, calls, outcomes } = toolWith({ ok: false, reason: "should-not-query" });
		const res = await run(t, { todos: completedWithAssetContract({ idClosure: true }) });
		assert.equal(isError(res), undefined);
		assert.equal(calls.length, 0);
		assert.doesNotMatch(textOf(res), /\[acceptance\]/);
		// declared 计数在 enabled 判定之前（既有语义：off 只跳过查询，不抹掉声明观测）
		assert.deepEqual(outcomes, ["declared"]);
		assert.equal((res.details as { todo: { snapshot: unknown[] } }).todo.snapshot.length, 1);
	} finally {
		delete process.env.PI_RUNTIME_ACCEPTANCE;
	}
});

// ═══ Task 4 评审 Minor：fetchAssetContractInput 组装边界归一化 ═══

function clientReturning(data: unknown): OracleNestClient & { posts: Array<{ path: string; body: unknown }> } {
	const posts: Array<{ path: string; body: unknown }> = [];
	return {
		posts,
		async post(path: string, body: unknown) {
			posts.push({ path, body });
			return data;
		},
	};
}

test("fetchAssetContractInput: 非有限数（NaN/Infinity）与负值 durationMs/dialogueChars ⇒ 归入 missing（证据不足不猜）", async () => {
	const rows = [
		{ shotId: "s1", durationMs: Number.NaN, dialogueChars: 5 },
		{ shotId: "s2", durationMs: Number.POSITIVE_INFINITY, dialogueChars: -3 },
		{ shotId: "s3", durationMs: -2000, dialogueChars: Number.NaN },
	];
	const c = clientReturning({
		registeredIds: ["hero"],
		referencedIds: ["hero"],
		authorities: [],
		durationRows: rows,
	});
	const r = await createNestAssetContractOracle(c).inspect({ sessionId: "sess-D1" });
	assert.ok(r.ok);
	if (!r.ok) return;
	assert.equal(r.input.durationRows.length, 3);
	assert.equal(r.input.durationRows[0].durationMs, undefined, "NaN durationMs ⇒ missing");
	assert.equal(r.input.durationRows[1].durationMs, undefined, "Infinity durationMs ⇒ missing");
	assert.equal(r.input.durationRows[1].dialogueChars, undefined, "负值 dialogueChars ⇒ missing");
	assert.equal(r.input.durationRows[2].durationMs, undefined, "负值 durationMs ⇒ missing");
	assert.equal(r.input.durationRows[2].dialogueChars, undefined, "NaN dialogueChars ⇒ missing");
	// missing 语义在判定器里即 fail-closed：durationBudget 谓词据 missing 行 reject
	const { judgeDurationBudget } = await import("./asset-oracle.js");
	assert.equal(judgeDurationBudget({ rows: r.input.durationRows }).verdict, "reject");
});

test("fetchAssetContractInput: 合法数原样透传；端点与请求体对齐 get-canvas-summary 形态", async () => {
	const c = clientReturning({ ...goodInput });
	const r = await createNestAssetContractOracle(c).inspect({ sessionId: "sess-D1" });
	assert.ok(r.ok);
	if (!r.ok) return;
	assert.deepEqual(r.input.durationRows, [{ shotId: "s1", durationMs: 2000, dialogueChars: 9 }]);
	assert.equal(c.posts[0].path, "/agent/internal/get-asset-contract-snapshot");
	assert.deepEqual(c.posts[0].body, { sessionId: "sess-D1" });
});

test("端到端对齐：服务端真实响应形态（带 skippedNodes/limitations 扩展字段、dialogueChars 缺省不造数）⇒ durationBudget 诚实 fail-closed", async () => {
	const c = clientReturning({
		registeredIds: ["hero"],
		referencedIds: ["hero"],
		authorities: [{ dimension: "face", materialId: "m1", accepted: true, pinned: true }],
		durationRows: [{ shotId: "s1", durationMs: 2000 }],
		skippedNodes: 0,
		limitations: ["text-references-not-derived"],
	});
	const outcomes: AcceptanceOutcome[] = [];
	const [t] = buildTodoTools({
		assetOracle: createNestAssetContractOracle(c),
		onAcceptanceOutcome: (o) => outcomes.push(o),
	});
	const res = await run(t, { todos: completedWithAssetContract({ durationBudget: true }) });
	assert.equal(isError(res), true);
	assert.match(textOf(res), /缺少结构化 durationMs/);
	assert.deepEqual(outcomes, ["declared", "fail_closed"]);
});

test("fetchAssetContractInput: 响应缺字段/元素形态不符 ⇒ ok:false（证据不足不猜）；client 异常 ⇒ ok:false", async () => {
	const missing = await createNestAssetContractOracle(clientReturning({ registeredIds: ["hero"] })).inspect({
		sessionId: "s",
	});
	assert.equal(missing.ok, false);
	const badElement = await createNestAssetContractOracle(
		clientReturning({
			registeredIds: ["hero"],
			referencedIds: [],
			authorities: [{ dimension: "face" }],
			durationRows: [],
		}),
	).inspect({ sessionId: "s" });
	assert.equal(badElement.ok, false);
	const thrown = await createNestAssetContractOracle({
		async post() {
			throw new Error("http 500");
		},
	}).inspect({ sessionId: "s" });
	assert.equal(thrown.ok, false);
	if (!thrown.ok) assert.match(thrown.reason, /http 500/);
});

// ═══ 生产接线：config.ts 必须注入 asset oracle（防「机制装了但生产路径不可达」） ═══

test("config.ts 生产注入 asset oracle（createNestAssetContractOracle(client)）", () => {
	const src = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
	assert.match(src, /createNestAssetContractOracle\(client\)/, "生产工具表未注入资产契约 oracle");
});
