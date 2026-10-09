/**
 * plan-gate-wiring 单元级补充测试：
 * ① kill switch（PI_RUNTIME_PLAN_GATE=off）⇒ 钩子根本不注册（终审 Critical #1：
 *    off 必须三面全关——注册/拦/注入；此前只挡注册面，回滚场景会锁死存量会话）。
 * ② planKey 惰性求值（终审 Important #2：canvasSessionId 每轮自愈，钩子内必须现算，
 *    急切捕获会让「晚绑定画布会话」的门禁静默 fail-open）。
 * 用 stub harness 捕获 handler 直调——不驱动真实 run（集成行为在 session-manager.plan-gate.test.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";
import { registerPlanGateHooks } from "./plan-gate-wiring.js";
import { markPlanDecision, resetPlanState, shouldBlockForPlan } from "./plan-gate.js";
import { seedTodoState, getTodoState, resetTodoStoreForTest } from "../tools/todo.js";

/** 捕获式 stub harness：hooks.on 记录 handler，供直调。 */
function stubHarness() {
	const handlers = new Map<string, (event: never) => Promise<unknown>>();
	const harness = {
		hooks: {
			on: (name: string, fn: never) => {
				handlers.set(name, fn as never);
			},
		},
	} as unknown as AgentHarness<LnkpiToolContext>;
	return { harness, handlers };
}

const metrics = { observePlanGateBlocked() {} } as never;

test("kill switch off：registerPlanGateHooks 不注册任何钩子", () => {
	process.env.PI_RUNTIME_PLAN_GATE = "off";
	try {
		const { harness, handlers } = stubHarness();
		registerPlanGateHooks(harness, { planKey: "k1", tiers: new Map(), metrics });
		assert.equal(handlers.size, 0, "off 时不得注册 before_tool/before_run_end");
	} finally {
		delete process.env.PI_RUNTIME_PLAN_GATE;
	}
});

test("kill switch on：钩子照常注册", () => {
	const { harness, handlers } = stubHarness();
	registerPlanGateHooks(harness, { planKey: "k1", tiers: new Map(), metrics });
	assert.ok(handlers.has("before_tool"));
	assert.ok(handlers.has("before_run_end"));
});

test("planKey 惰性求值：canvasSessionId 后续自愈后，钩子用新键判定", async () => {
	resetTodoStoreForTest();
	resetPlanState("pi-key");
	let canvasId: string | undefined; // 模拟「会话建立时未绑定 → 后续自愈」
	const { harness, handlers } = stubHarness();
	registerPlanGateHooks(harness, {
		planKey: () => canvasId ?? "pi-key",
		tiers: new Map([["fake_write", "write_light" as const]]),
		metrics,
	});
	const beforeTool = handlers.get("before_tool")!;

	// 工具域（propose_plan tc.sessionId）落在 canvasId 键上：keep → pending
	markPlanDecision("canvas-late", "keep");
	// 自愈前（canvasId undefined）：pi 键 idle，不拦
	let ev = { toolName: "fake_write", toolCallId: "c1", args: {} };
	assert.equal(await beforeTool(ev as never), undefined, "自愈前 pi 键 idle 放行");
	// 自愈后：planKey 解析为 canvas-late → 拦写
	canvasId = "canvas-late";
	const blocked = await beforeTool(ev as never);
	assert.ok(blocked && (blocked as { block?: { reason: string } }).block, "自愈后必须按 canvas 键拦写");
});

test("planKey 惰性求值：followUp 查 todo 也用现算键", async () => {
	resetTodoStoreForTest();
	resetPlanState("pi-key2");
	let canvasId: string | undefined;
	seedTodoState("canvas-late2", [
		{ id: "plan-1", content: "步骤A", status: "pending" },
	]);
	const { harness, handlers } = stubHarness();
	registerPlanGateHooks(harness, {
		planKey: () => canvasId ?? "pi-key2",
		tiers: new Map(),
		metrics,
	});
	const beforeRunEnd = handlers.get("before_run_end")!;

	// 信号落在 canvas 键（工具域 markPlanDecision("canvas-late2","execute")）
	markPlanDecision("canvas-late2", "execute");
	assert.equal(await beforeRunEnd(undefined as never), undefined, "自愈前 pi 键无信号不注入");
	canvasId = "canvas-late2";
	const out = (await beforeRunEnd(undefined as never)) as { followUp?: string };
	assert.ok(out?.followUp?.includes("步骤A"), "自愈后必须按 canvas 键取信号与 todo 注入 followUp");
	// 消费一次即清
	assert.equal(await beforeRunEnd(undefined as never), undefined);
	// todo 域查询同键（getTodoState(canvas-late2) 有未完成项——若急切捕获 pi-key2 则恒空）
	assert.equal(getTodoState("canvas-late2").length, 1);
});
