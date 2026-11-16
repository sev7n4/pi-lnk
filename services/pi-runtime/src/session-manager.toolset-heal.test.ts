/**
 * B-1 修复（#906 重启泄漏）— 真实 harness 集成（money test）。
 * 泄漏复现链（master 上 RED）：propose_plan keep ⇒ after_tool 收缩（盘上 lane config
 * 持久化）⇒ 模拟重启（resetPlanState 清内存记账）⇒ 新 manager resume（盘上残留收缩态）
 * ⇒ 修复：heal 收敛到 base ⇒ before_run 重收缩正确记账 removed ⇒ execute 还原后
 * fake_write_node 回到声明集。master 旧逻辑：heal 缺位 ⇒ 重收缩 removed 覆空 ⇒ 还原
 * 原样放回收缩集 ⇒ 写工具永久不可见（本文件的核心断言抓它）。
 * 骨架同 session-manager.plan-gate.test.ts（真 harness + faux 模型 + stub registry）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentHarness } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SessionManager, toSessionKey, type EventListener } from "./session-manager.js";
import { buildTodoTools } from "./tools/todo.js";
import { createProposePlanTool } from "./tools/propose-plan.js";
import { registerPlanGateHooks } from "./gate/plan-gate-wiring.js";
import { registerRunEndHooks } from "./gate/subagent-barrier.js";
import { SubagentCoordinator } from "./gate/subagent.js";
import { resetPlanState } from "./gate/plan-gate.js";
import type { LnkpiTool, LnkpiToolContext } from "./tools/types.js";
import type { Metrics } from "./metrics.js";
import type { PendingToolRegistry } from "./pending-registry.js";
import type { RuntimeConfig } from "./runtime-config.js";

/** 与 session-manager/plan-gate-wiring 同值（各自本地声明的既有约定）。 */
const MAIN_LANE = "main";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-toolset-heal-"));
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

/** gated 写工具（write_light）：泄漏断言的标的物。 */
const fakeWriteTool: LnkpiTool = {
	name: "fake_write_node",
	label: "写节点（测试）",
	tier: "write_light",
	description: "test-only write tool",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "written" }], details: undefined };
	},
};

const metricsStub = {
	observePlanProposed() {},
	observePlanDecision() {},
	observePlanGateBlocked() {},
	observePlanAssumptions() {},
	observeBarrier() {},
	observeToolsetGateNarrow() {},
} as unknown as Metrics;

async function laneActive(harness: AgentHarness<LnkpiToolContext>): Promise<string[]> {
	const lane = await harness.lane(MAIN_LANE, BACKGROUND_CONTEXT);
	return lane.getActiveTools(BACKGROUND_CONTEXT);
}

/** registry 序列：第 1 次 keep（收缩），第 2 次 execute（还原）。 */
function makeRegistry(): PendingToolRegistry {
	const answers: Array<"keep" | "execute"> = ["keep", "execute"];
	let n = 0;
	return {
		waitForUser: async () => {
			const decision = answers[Math.min(n, answers.length - 1)];
			n += 1;
			return { status: "answered", answers: { plan_confirm: [decision] } };
		},
	} as unknown as PendingToolRegistry;
}

function makeManager(registry: PendingToolRegistry, responses: unknown[]): SessionManager {
	const faux = fauxProvider();
	faux.setResponses(responses as never);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tools: LnkpiTool[] = [...buildTodoTools(), fakeWriteTool, createProposePlanTool(registry, metricsStub)];
	const tiers = new Map(tools.map((t) => [t.name, t.tier]));
	let captured: AgentHarness<LnkpiToolContext> | undefined;
	const sm = new SessionManager(tools, "", modelFactory, undefined, {
		onSessionCreated(sessionId, harness) {
			captured = harness;
			registerPlanGateHooks(harness, { planKey: sessionId, tiers, metrics: metricsStub });
			registerRunEndHooks(harness, {
				sessionId,
				coordinator: new SubagentCoordinator(),
				resolvePlanKey: () => sessionId,
				metrics: metricsStub,
			});
		},
	}, undefined, sharedConfig());
	(sm as unknown as { __harnessFn: unknown }).__harnessFn = () => captured;
	return sm;
}

function harnessOf(sm: SessionManager): AgentHarness<LnkpiToolContext> {
	const fn = (sm as unknown as { __harnessFn?: () => AgentHarness<LnkpiToolContext> | undefined }).__harnessFn;
	return fn?.() as AgentHarness<LnkpiToolContext>;
}

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

test("B-1 修复：重启泄漏治愈——keep 收缩 → resume → execute 还原后写工具回到声明集", async () => {
	const threadKey = "sess-toolset-heal";
	const key = toSessionKey(threadKey);
	resetPlanState(key);
	const registry = makeRegistry();
	const sm1 = makeManager(registry, [
		// R1：提方案（registry 第 1 次 → keep）
		fauxAssistantMessage([fauxToolCall("propose_plan", { summary: "方案", steps: [{ content: "第一步" }] })], { stopReason: "toolUse" }),
		// R2：收尾（after_tool 已收缩声明集）
		fauxAssistantMessage("方案已保留", { stopReason: "stop" }),
	]);
	await sm1.create(threadKey, { userId: "u1" });
	await sm1.prompt(threadKey, "出方案");
	await waitAgentEnd(sm1, threadKey);

	// ① 收缩生效：pending + declared set 无 gated 写工具
	const h1 = harnessOf(sm1);
	const narrowed = await laneActive(h1);
	assert.ok(!narrowed.includes("fake_write_node"), `keep 后声明集应无 fake_write_node：${JSON.stringify(narrowed)}`);
	assert.ok(narrowed.includes("todo_write"), "豁免工具保持可达");

	// ② 模拟重启：进程内存记账全失（plan-gate store 是模块级单例）
	resetPlanState(key);

	// ③ 新 manager resume：同 dataRoot + 同 threadKey ⇒ 磁盘 session 存在 ⇒ resume 路径
	const sm2 = makeManager(registry, [
		// R3：再次提方案（registry 第 2 次 → execute）
		fauxAssistantMessage([fauxToolCall("propose_plan", { summary: "方案", steps: [{ content: "第一步" }] })], { stopReason: "toolUse" }),
		// R4：收尾（after_tool 还原；followUp 会因清单 pending 注入续轮）
		fauxAssistantMessage("开始执行", { stopReason: "stop" }),
		// R5：续轮把步骤 completed（消费 followUp，防再注入）
		fauxAssistantMessage([fauxToolCall("todo_write", { todos: [{ content: "第一步", status: "completed" }] })], { stopReason: "toolUse" }),
		// R6：再收尾
		fauxAssistantMessage("完成", { stopReason: "stop" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	await sm2.create(threadKey, { userId: "u1" });

	// ④ ⭐ 修复主断言：resume 治愈后声明集收敛到 base（fake_write_node 回来了）
	const healed = await laneActive(harnessOf(sm2));
	assert.ok(healed.includes("fake_write_node"), `resume 治愈后 fake_write_node 应回到声明集（#906 泄漏则缺失）：${JSON.stringify(healed)}`);

	// ⑤ execute 还原闭环：重收缩正确记账 removed ⇒ execute 后仍在
	await sm2.prompt(threadKey, "确认执行");
	await waitAgentEnd(sm2, threadKey);
	const restored = await laneActive(harnessOf(sm2));
	assert.ok(restored.includes("fake_write_node"), `execute 还原后 fake_write_node 应在声明集：${JSON.stringify(restored)}`);
});
