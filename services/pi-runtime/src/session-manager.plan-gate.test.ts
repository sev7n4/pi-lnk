/**
 * C3 plan-gate 接线的真实 harness 集成测试（spec 2026-10-10-plan-gate-design.md §3.3/§3.4）。
 *
 * 骨架同 session-manager.todo-resume.test.ts（真 harness + faux 模型，只替换 LLM 边界）。
 * 被测对象是 gate/plan-gate-wiring.ts 的 registerPlanGateHooks——index.ts 与本测试共调
 * 同一接线源（index.ts 是模块级单例 + env 装配，无法 import 驱动；接线落点另有
 * plan-gate.wiring.test.ts 源文本断言锁死）。
 *
 * 场景：propose_plan（stub registry 立即 answered=execute）→ 同 run 内写类工具**放行**
 * （execute 是唯一解锁路径，spec §3.1）→ 模型收尾 → before_run_end 注入 followUp（todo 有
 * 未完成步）→ 续轮把步骤全部 completed → 再收尾不再注入（防双执行）。
 * 拦写行为（planPending → before_tool block）由 keep 场景第二用例钉住。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SessionManager, toSessionKey, type EventListener } from "./session-manager.js";
import { buildTodoTools, getTodoState, resetTodoStoreForTest } from "./tools/todo.js";
import { createProposePlanTool } from "./tools/propose-plan.js";
import { registerPlanGateHooks } from "./gate/plan-gate-wiring.js";
import { isPlanPending, resetPlanState } from "./gate/plan-gate.js";
import type { LnkpiTool } from "./tools/types.js";
import type { Metrics } from "./metrics.js";
import type { PendingToolRegistry } from "./pending-registry.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-plan-gate-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function sharedConfig(): RuntimeConfig {
	return {
		dataRoot: TEST_ROOT,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 写类工具（write_light）：执行即计数——全程必须为 0（run1 被 plan gate 拦，续轮不调它）。 */
let writeExecuted = 0;
const fakeWriteTool: LnkpiTool = {
	name: "fake_write_node",
	label: "写节点（测试）",
	tier: "write_light",
	description: "test-only write tool",
	parameters: Type.Object({}),
	async execute() {
		writeExecuted += 1;
		return { content: [{ type: "text", text: "written" }], details: undefined };
	},
};

const metricsStub = { observePlanProposed() {}, observePlanDecision() {}, observePlanGateBlocked() {} } as unknown as Metrics;
const registryStub = {
	waitForUser: async () => ({ status: "answered", answers: { plan_confirm: ["execute"] } }),
} as unknown as PendingToolRegistry;

function makeManager(): SessionManager {
	const faux = fauxProvider();
	faux.setResponses([
		// R1：提方案（stub registry 立即 execute）
		fauxAssistantMessage(
			[
				fauxToolCall("propose_plan", {
					summary: "两步方案",
					steps: [{ content: "第一步", activeForm: "正在第一步" }, { content: "第二步" }],
				}),
			],
			{ stopReason: "toolUse" },
		),
		// R2：同 run 内直调写工具 → 必须被 before_tool 拦下
		fauxAssistantMessage([fauxToolCall("fake_write_node", {})], { stopReason: "toolUse" }),
		// R3：模型收尾 → before_run_end 注入 followUp（清单两步全 pending）
		fauxAssistantMessage("收到，开始执行", { stopReason: "stop" }),
		// R4：续轮（followUp 注入的证据）把两步全部 completed
		fauxAssistantMessage(
			[
				fauxToolCall("todo_write", {
					todos: [
						{ content: "第一步", status: "completed" },
						{ content: "第二步", status: "completed" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		// R5：再收尾 → 信号已消费 + 清单全 completed ⇒ 不得再注入（防双执行；若误注入，
		// 下一响应是 fake_write_node 调用，writeExecuted 会 >0 暴露双执行）
		fauxAssistantMessage("全部完成", { stopReason: "stop" }),
		fauxAssistantMessage([fauxToolCall("fake_write_node", {})], { stopReason: "toolUse" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tools: LnkpiTool[] = [...buildTodoTools(), fakeWriteTool, createProposePlanTool(registryStub, metricsStub)];
	const tiers = new Map(tools.map((t) => [t.name, t.tier]));
	return new SessionManager(tools, "", modelFactory, undefined, {
		onSessionCreated(sessionId, harness) {
			// 与 index.ts 同一接线源：planKey = canvasSessionId ?? key，测试无画布映射 ⇒ 即 key。
			registerPlanGateHooks(harness, { planKey: sessionId, tiers, metrics: metricsStub });
		},
	}, undefined, sharedConfig());
}

/** 等 agent_end（prompt 是 fire-and-forget；followUp 续轮在同一 drive 链内收敛）。 */
function waitAgentEnd(sm: SessionManager, threadKey: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sm.unsubscribe(threadKey, listener);
			reject(new Error("agent_end 等待超时"));
		}, 15_000);
		const listener: EventListener = (e) => {
			if (e.type === "agent_end") {
				clearTimeout(timer);
				sm.unsubscribe(threadKey, listener);
				resolve();
			}
		};
		sm.subscribe(threadKey, listener);
	});
}

test("plan-gate 接线：execute 确认后放行写 + followUp 执行轮 + 防双执行", async () => {
	resetTodoStoreForTest();
	writeExecuted = 0;
	const threadKey = "sess-plan-gate-wiring";
	const key = toSessionKey(threadKey);
	resetPlanState(key);

	const sm = makeManager();
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "先出方案再干活");
	await waitAgentEnd(sm, threadKey);

	// ① execute 解锁：写工具恰好执行 1 次（run1 放行；若防双执行失效产生多余续轮，
	//    第 6 个响应 fake_write_node 会再执行 → >1 暴露双执行）
	assert.equal(writeExecuted, 1, `fake_write_node 应恰好执行 1 次（execute 解锁），实际 ${writeExecuted}`);
	// ② followUp 执行轮真实发生：续轮的 todo_write 把两步全 completed
	const todos = getTodoState(key);
	assert.equal(todos.length, 2, "propose_plan steps 落清单");
	assert.ok(todos.every((i) => i.status === "completed"), `两步应被续轮完成：${JSON.stringify(todos)}`);
	// ③ execute 后 plan 状态 = idle（不拦写）
	assert.equal(isPlanPending(key), false);
});

test("plan-gate 接线：keep（不确认）后写工具被拦", async () => {
	resetTodoStoreForTest();
	writeExecuted = 0;
	const threadKey = "sess-plan-gate-keep";
	const key = toSessionKey(threadKey);
	resetPlanState(key);

	// 本地 stub 改为 keep：propose_plan 返回后 planPending=true
	const keepRegistry = {
		waitForUser: async () => ({ status: "answered", answers: { plan_confirm: ["keep"] } }),
	} as unknown as PendingToolRegistry;
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("propose_plan", { summary: "s", steps: [{ content: "a" }] })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("fake_write_node", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("好", { stopReason: "stop" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tools: LnkpiTool[] = [...buildTodoTools(), fakeWriteTool, createProposePlanTool(keepRegistry, metricsStub)];
	const tiers = new Map(tools.map((t) => [t.name, t.tier]));
	const sm = new SessionManager(tools, "", modelFactory, undefined, {
		onSessionCreated(sessionId, harness) {
			registerPlanGateHooks(harness, { planKey: sessionId, tiers, metrics: metricsStub });
		},
	}, undefined, sharedConfig());

	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "先出方案");
	await waitAgentEnd(sm, threadKey);

	assert.equal(writeExecuted, 0, "keep 后写工具必须被拦");
	assert.equal(isPlanPending(key), true, "keep 保持拦写（fail-closed）");
	assert.equal(getTodoState(key).length, 1, "步骤清单仍落卡");
});

/** 播种场景共用：sm1 真跑一次 propose_plan（details.plan.decision 落 transcript）→
 * 清内存 store → sm2 同 dataRoot 磁盘 resume → 断言 plan 状态从 transcript 播种。 */
async function runProposeAndReopen(
	threadKey: string,
	key: string,
	answers: Record<string, string[]>,
): Promise<SessionManager> {
	const answerRegistry = {
		waitForUser: async () => ({ status: "answered", answers }),
	} as unknown as PendingToolRegistry;
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("propose_plan", { summary: "s", steps: [{ content: "a" }] })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("好", { stopReason: "stop" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tools: LnkpiTool[] = [...buildTodoTools(), fakeWriteTool, createProposePlanTool(answerRegistry, metricsStub)];
	const tiers = new Map(tools.map((t) => [t.name, t.tier]));
	const sm1 = new SessionManager(tools, "", modelFactory, undefined, {
		onSessionCreated(sessionId, harness) {
			registerPlanGateHooks(harness, { planKey: sessionId, tiers, metrics: metricsStub });
		},
	}, undefined, sharedConfig());
	await sm1.create(threadKey, { userId: "u1" });
	await sm1.prompt(threadKey, "先出方案");
	await waitAgentEnd(sm1, threadKey);

	// 清内存：resume 后的断言只能来自 transcript 播种（防假绿——模块级 plan store / todo store
	// 都会残留 sm1 的运行态，不清则播种路径根本没被走到）。
	resetTodoStoreForTest();
	resetPlanState(key);
	const sm2 = new SessionManager(tools, "", modelFactory, undefined, {
		onSessionCreated(sessionId, harness) {
			registerPlanGateHooks(harness, { planKey: sessionId, tiers, metrics: metricsStub });
		},
	}, undefined, sharedConfig());
	const result = await sm2.create(threadKey, { userId: "u1" });
	assert.equal(result.status, "resumed", "必须走磁盘 resume 路径");
	return sm2;
}

test("resume 播种：transcript 末条 propose_plan decision=keep → planPending 生效", async () => {
	resetTodoStoreForTest();
	const threadKey = "sess-plan-seed-keep";
	const key = toSessionKey(threadKey);
	resetPlanState(key);
	await runProposeAndReopen(threadKey, key, { plan_confirm: ["keep"] });
	assert.equal(isPlanPending(key), true, "resume 后 plan 状态必须从 transcript 播种（拦写生效）");
});

test("resume 播种：末条 decision=execute → idle 放行", async () => {
	resetTodoStoreForTest();
	const threadKey = "sess-plan-seed-execute";
	const key = toSessionKey(threadKey);
	resetPlanState(key);
	await runProposeAndReopen(threadKey, key, { plan_confirm: ["execute"] });
	assert.equal(isPlanPending(key), false, "execute 播 idle（不拦写）");
});
