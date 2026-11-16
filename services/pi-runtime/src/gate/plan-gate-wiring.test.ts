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
import type { AgentHarness, Context } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";
import { registerPlanGateHooks } from "./plan-gate-wiring.js";
import { registerRunEndHooks } from "./subagent-barrier.js";
import { SubagentCoordinator } from "./subagent.js";
import { markPlanDecision, resetPlanState, shouldBlockForPlan } from "./plan-gate.js";
import { seedTodoState, getTodoState, resetTodoStoreForTest } from "../tools/todo.js";

/** 捕获式 stub harness：hooks.on 记录 handler，供直调。 */
function stubHarness(laneImpl?: {
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
}) {
	// 直调 helper 容器：签名刻意宽松（测试直调，绕开 vendor HookMap 判别联合的样板）。
	const handlers = new Map<string, (...args: never[]) => Promise<unknown>>();
	const harness = {
		hooks: {
			on: (name: string, fn: never) => {
				handlers.set(name, fn as never);
			},
		},
		// B-1：声明集收缩经 harness.lane(MAIN_LANE).getActiveTools/setActiveTools 现算差分。
		lane: laneImpl
			? async (_name: string, _ctx: unknown) => ({
					getActiveTools: async () => laneImpl.getActiveTools(),
					setActiveTools: async (names: string[]) => laneImpl.setActiveTools(names),
				})
			: undefined,
	} as unknown as AgentHarness<LnkpiToolContext>;
	return { harness, handlers };
}

const metrics = { observePlanGateBlocked() {}, observeBarrier() {} } as never;

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
	// P1（2026-11-15）：before_run_end 已迁移到 registerRunEndHooks——此处只保留 before_tool 拦写。
	assert.equal(handlers.has("before_run_end"), false, "plan-gate-wiring 不再注册 before_run_end");
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
	// P1：before_run_end 现由 registerRunEndHooks 统一注册（合成 plan-gate followUp）。
	registerRunEndHooks(harness, {
		sessionId: "pi-key2",
		coordinator: new SubagentCoordinator(),
		resolvePlanKey: () => canvasId ?? "pi-key2",
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

/* ===== B-1 门禁态声明集收缩（plan 2026-11-16-b1-gate-toolset-narrow-plan.md §4） ===== */

const B1_TIERS = new Map<string, string | undefined>([
	["fake_write", "write_light"], // gated 写工具
	["gen_tool", "gen"], // gated 写工具
	["read_tool", "read"],
	["tool_search", "skill"],
	["undo", "skill"], // 延迟集代表：tool_search 激活后并入 declared set
]);

/** 记账式 fake lane + 直调 helper。 */
function b1Setup(key: string, initial: string[]) {
	let current = [...initial];
	const applied: string[][] = [];
	const { harness, handlers } = stubHarness({
		getActiveTools: () => [...current],
		setActiveTools: (names) => {
			applied.push([...names]);
			current = [...names];
		},
	});
	registerPlanGateHooks(harness, { planKey: key, tiers: B1_TIERS, metrics });
	const runBeforeRun = () =>
		handlers.get("before_run")!({ prompt: [], resources: {} } as never, {} as never);
	const runAfterTool = (toolName: string, details: unknown) =>
		handlers.get("after_tool")!(
			{ toolName, toolCallId: "t", args: {}, content: [], details } as never,
			{} as never,
		);
	/** 模拟 tool_search 命中后 vendor addedToolNames 原生并入 declared set。 */
	const activate = (name: string) => {
		if (!current.includes(name)) current.push(name);
	};
	return {
		harness,
		handlers,
		applied,
		runBeforeRun,
		runAfterTool,
		currentNames: () => [...current],
		activate,
	};
}

test("B-1 before_run：pending ⇒ 声明集收缩（gated 写工具从 declared set 移除）", async () => {
	resetPlanState("b1");
	const { applied, runBeforeRun, currentNames } = b1Setup("b1", [
		"fake_write",
		"gen_tool",
		"read_tool",
		"tool_search",
	]);
	markPlanDecision("b1", "keep"); // pending
	await runBeforeRun();
	assert.deepEqual(
		currentNames(),
		["read_tool", "tool_search"],
		"pending 期 gated 写工具必须从声明集移除（模型看不到 schema）",
	);
	assert.equal(applied.length, 1);
	// 幂等：重复 before_run 不重复差分
	await runBeforeRun();
	assert.equal(applied.length, 1, "pending 与收缩态一致时 before_run 不得重复写 lane");
	resetPlanState("b1");
});

test("B-1 before_run：resume 播种（seedPlanState）跨 run 收敛", async () => {
	resetPlanState("b1");
	const { runBeforeRun, currentNames } = b1Setup("b1", ["fake_write", "read_tool"]);
	// 不经过 markPlanDecision——模拟 resume 从 transcript 播种 keep（session-manager seedPlanState 同语义）
	markPlanDecision("b1", "keep");
	await runBeforeRun();
	assert.deepEqual(currentNames(), ["read_tool"], "跨 run pending 必须在 run 边界收敛");
	resetPlanState("b1");
});

test("B-1 after_tool execute：同点还原（确认当轮写工具立即可见）", async () => {
	resetPlanState("b1");
	const { runBeforeRun, runAfterTool, currentNames } = b1Setup("b1", ["fake_write", "read_tool"]);
	markPlanDecision("b1", "keep");
	await runBeforeRun();
	assert.deepEqual(currentNames(), ["read_tool"]);
	markPlanDecision("b1", "execute");
	await runAfterTool("propose_plan", { plan: { decision: "execute" } });
	assert.ok(
		currentNames().includes("fake_write"),
		"execute 后声明集必须即时还原——收缩态带到 run 剩余部分 = 确认了却写不了",
	);
	assert.ok(currentNames().includes("read_tool"));
	resetPlanState("b1");
});

test("B-1 after_tool refine：同点收缩（run 内后续步立即看不到写工具）", async () => {
	resetPlanState("b1");
	const { runAfterTool, currentNames } = b1Setup("b1", ["fake_write", "read_tool"]);
	await runAfterTool("propose_plan", { plan: { decision: "refine", feedback: "改下第二步" } });
	assert.deepEqual(
		currentNames(),
		["read_tool"],
		"refine（fail-closed）后声明集必须同点收缩",
	);
	resetPlanState("b1");
});

test("B-1 还原保护 tool_search 激活：合并加回而非恢复快照", async () => {
	resetPlanState("b1");
	const { runBeforeRun, runAfterTool, currentNames, activate } = b1Setup("b1", [
		"fake_write",
		"tool_search",
	]);
	markPlanDecision("b1", "keep");
	await runBeforeRun();
	// 收缩窗口内 tool_search 激活 undo（vendor addedToolNames 原生并入 declared set）
	activate("undo");
	markPlanDecision("b1", "execute");
	await runAfterTool("propose_plan", { plan: { decision: "execute" } });
	assert.ok(
		currentNames().includes("undo") && currentNames().includes("fake_write"),
		`还原必须合并加回（保留窗口期激活的 undo）：${currentNames().join(",")}`,
	);
	resetPlanState("b1");
});

test("B-1 非门禁终态路径与无关工具不触碰 lane", async () => {
	resetPlanState("b1");
	const { applied, runAfterTool } = b1Setup("b1", ["fake_write"]);
	await runAfterTool("read_tool", {});
	await runAfterTool("propose_plan", { plan: { decision: "pending-garbage" } });
	assert.equal(applied.length, 0, "非 propose_plan / 非 PlanDecision 形态不得写 lane");
	resetPlanState("b1");
});

test("B-1 fail-open：lane 访问异常不阻塞 run", async () => {
	resetPlanState("b1x");
	let current = ["fake_write"];
	const { harness, handlers } = stubHarness({
		getActiveTools: () => {
			throw new Error("lane unavailable");
		},
		setActiveTools: (names) => {
			current = names;
		},
	});
	registerPlanGateHooks(harness, { planKey: "b1x", tiers: B1_TIERS, metrics });
	markPlanDecision("b1x", "keep");
	const out = await handlers.get("before_run")!(
		{ prompt: [], resources: {} } as never,
		{} as never,
	);
	assert.equal(out, undefined, "fail-open：handler 不抛、run 不受影响（before_tool 拦截仍在）");
	assert.deepEqual(current, ["fake_write"], "失败时声明集不变");
	resetPlanState("b1x");
});
