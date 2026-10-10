/**
 * C2 turnBudget 端到端集成测试（真 harness + faux 模型，骨架同 session-manager.plan-gate.test.ts）。
 * 覆盖 spec §6：预算=3 第 4 轮硬停 / warn 恰好一次 / off 全旁路 / run 间复位 / C3 followUp 共享窗口。
 * ⚠️ warn 的 steer 会注入下一轮上下文（vendor 边界消费）——脚本响应是顺序消费的，
 * 两种 vendor 消费形态（合并 vs 额外一代）下计数与断言均一致（计划里已推演）。
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
import { resetPlanState } from "./gate/plan-gate.js";
import { Metrics } from "./metrics.js";
import type { LnkpiTool } from "./tools/types.js";
import type { PendingToolRegistry } from "./pending-registry.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-turn-budget-int-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function sharedConfig(turnBudget: number | "off"): RuntimeConfig {
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
		turnBudget,
	};
}

let nopExecuted = 0;
const nopTool: LnkpiTool = {
	name: "fake_nop",
	label: "空操作（测试）",
	tier: "write_light",
	description: "test-only no-op tool",
	parameters: Type.Object({}),
	async execute() {
		nopExecuted += 1;
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

/** 等 agent_end 到达（prompt fire-and-forget；硬停 run 经 forceSettle 也以 agent_end 收敛）。 */
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

/**
 * agent_end 事件分发早于 lane.prompt 的 .finally（清 entry.prompting），连续两次
 * prompt 会撞既有 BusyError——轮询重试到会话真正空闲（既有 drain 空轮同理会让路）。
 */
async function promptWhenIdle(sm: SessionManager, threadKey: string, text: string): Promise<void> {
	for (let i = 0; ; i++) {
		try {
			await sm.prompt(threadKey, text);
			return;
		} catch (err) {
			if (i >= 40 || !/busy/i.test(err instanceof Error ? err.message : String(err))) throw err;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
}

function makeManager(turnBudget: number | "off", metrics: Metrics, responses: unknown[]) {
	const faux = fauxProvider();
	faux.setResponses(responses as never);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tools: LnkpiTool[] = [nopTool];
	return new SessionManager(tools, "", modelFactory, undefined, {}, undefined, sharedConfig(turnBudget), undefined, metrics);
}

test("集成: 预算=3 的 run 在第 4 轮硬停（exceeded=1、warn=1、无 error、agent_end 到达）", async () => {
	resetTodoStoreForTest();
	nopExecuted = 0;
	const metrics = new Metrics();
	const sm = makeManager(3, metrics, [
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("不应到达（T4 turn_start 处已硬停）", { stopReason: "stop" }),
	]);
	const threadKey = "s-tb-int-exceed";
	await sm.create(threadKey, { userId: "u1" });
	const seen: string[] = [];
	sm.subscribe(threadKey, (e) => seen.push(e.type));
	await sm.prompt(threadKey, "跑起来");
	await waitAgentEnd(sm, threadKey);

	assert.equal(nopExecuted, 3, "3 个工具轮执行；第 4 轮 turn_start 即硬停，模型不再被调用");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 1/);
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_warned_total 1/);
	assert.deepEqual(seen.filter((t) => t === "error"), [], "userAborted 语义：硬停不派发 error（Review Focus 3 一并覆盖）");
});

test("集成: turnBudget=off 全旁路——同样的 4 轮 run 正常完成", async () => {
	resetTodoStoreForTest();
	nopExecuted = 0;
	const metrics = new Metrics();
	const sm = makeManager("off", metrics, [
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	const threadKey = "s-tb-int-off";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "跑起来");
	await waitAgentEnd(sm, threadKey);

	assert.equal(nopExecuted, 3);
	const text = metrics.render(1, "test");
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 0/);
	assert.match(text, /pi_runtime_turn_budget_warned_total 0/);
});

test("集成: run 正常结束后下一 run 从 0 计数", async () => {
	resetTodoStoreForTest();
	nopExecuted = 0;
	// budget=13：两 run 各 2 轮都不触及 warn 阈值（budget-10=3）——刻意避开 warn steer
	// 滞留 inbox 后既有 drainAfterRun 与下一 prompt 撞车的既有行为（spec §5-3 不加新逻辑，
	// 该行为不属 C2 测试面）；「warn 每 run 独立判定」由状态机单测（run 重启复位）钉住。
	const metrics = new Metrics();
	const sm = makeManager(13, metrics, [
		// run1：2 轮（T1 工具 + T2 收尾），count=2
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("第一轮完成", { stopReason: "stop" }),
		// run2：再 2 轮——若跨 run 未复位，累计 4 > 3 会在 run2 第 2 轮硬停
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("第二轮完成", { stopReason: "stop" }),
	]);
	const threadKey = "s-tb-int-reset";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "第一个问题");
	await waitAgentEnd(sm, threadKey);
	await promptWhenIdle(sm, threadKey, "第二个问题");
	await waitAgentEnd(sm, threadKey);

	assert.equal(nopExecuted, 2, "两个 run 各执行一次工具");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 0/, "run 间必须复位");
});

test("集成: C3 followUp 续轮共享同一预算窗口（Review Focus 2）", async () => {
	resetTodoStoreForTest();
	const key = toSessionKey("s-tb-int-followup");
	resetPlanState(key);
	const metrics = new Metrics();
	const registryStub = {
		waitForUser: async () => ({ status: "answered", answers: { plan_confirm: ["execute"] } }),
	} as unknown as PendingToolRegistry;

	const faux = fauxProvider();
	faux.setResponses([
		// T1：提方案（registry 立即 execute）→ count=1，warn（budget=3 阈值为负 ⇒ 首轮即 warn）
		fauxAssistantMessage(
			[fauxToolCall("propose_plan", { summary: "两步", steps: [{ content: "第一步" }, { content: "第二步" }] })],
			{ stopReason: "toolUse" },
		),
		// T2：收尾 → before_run_end 注入 followUp（两步 pending）
		fauxAssistantMessage("收到，开始执行", { stopReason: "stop" }),
		// T3：续轮完成清单（同 run、同 operationId ⇒ 继续计数 → count=3）
		fauxAssistantMessage(
			[fauxToolCall("todo_write", { todos: [{ content: "第一步", status: "completed" }, { content: "第二步", status: "completed" }] })],
			{ stopReason: "toolUse" },
		),
		// T4：再收尾 → turn_start 处 count=4 > 3 ⇒ 硬停（若窗口被错误清零则不会 exceed）
		fauxAssistantMessage("不应到达", { stopReason: "stop" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tools: LnkpiTool[] = [...buildTodoTools(), createProposePlanTool(registryStub, metrics)];
	const tiers = new Map(tools.map((t) => [t.name, t.tier]));
	const sm = new SessionManager(tools, "", modelFactory, undefined, {
		onSessionCreated(sessionId, harness) {
			registerPlanGateHooks(harness, { planKey: sessionId, tiers, metrics });
		},
	}, undefined, sharedConfig(3), undefined, metrics);
	const threadKey = "s-tb-int-followup";
	await sm.create(threadKey, { userId: "u1" });
	const seen: string[] = [];
	sm.subscribe(threadKey, (e) => seen.push(e.type));
	await sm.prompt(threadKey, "先出方案再干活");
	await waitAgentEnd(sm, threadKey);

	// followUp 轮确实发生（清单被续轮完成）
	const todos = getTodoState(key);
	assert.ok(todos.length === 2 && todos.every((i) => i.status === "completed"), "followUp 续轮应完成清单");
	// 续轮计入同一窗口：T4 超限硬停。若实现错误地把窗口清零/排除续轮，exceeded 会是 0
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 1/, "followUp 续轮必须共享预算窗口");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_warned_total 1/);
	assert.deepEqual(seen.filter((t) => t === "error"), []);
});
