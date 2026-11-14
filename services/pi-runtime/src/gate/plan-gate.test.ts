import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	isPlanPending,
	markPlanDecision,
	seedPlanState,
	consumePlanExecutionSignal,
	clearPlanRunFlag,
	resetPlanState,
	pickLatestPlanDecision,
	shouldBlockForPlan,
} from "./plan-gate.js";

describe("plan-gate 状态机", () => {
	beforeEach(() => resetPlanState("s1"));

	it("未见过的会话默认 idle（不拦写）", () => {
		assert.equal(isPlanPending("s1"), false);
		assert.equal(shouldBlockForPlan("upsert_media_node", "write_light", "s1"), false);
	});

	it("execute → 解锁 + run 信号置位；refine/keep/timeout/aborted → 全部保持拦写", () => {
		for (const d of ["refine", "keep", "timeout", "aborted"] as const) {
			markPlanDecision("s1", d);
			assert.equal(isPlanPending("s1"), true, d);
			assert.equal(shouldBlockForPlan("upsert_media_node", "write_light", "s1"), true, d);
			markPlanDecision("s1", "execute"); // 复位进下一轮
		}
		markPlanDecision("s1", "execute");
		assert.equal(isPlanPending("s1"), false);
	});

	it("拦写矩阵：tier ∈ gated 拦；read/present/ui_command/skill 放行；todo_write 豁免；tier 未知放行", () => {
		markPlanDecision("s1", "keep");
		assert.equal(shouldBlockForPlan("run_image_generation", "gen", "s1"), true);
		assert.equal(shouldBlockForPlan("delete_nodes", "destructive", "s1"), true);
		assert.equal(shouldBlockForPlan("arrange_nodes", "graph_batch", "s1"), true);
		assert.equal(shouldBlockForPlan("set_node_text", "write_light", "s1"), true);
		assert.equal(shouldBlockForPlan("get_canvas_summary", "read", "s1"), false);
		assert.equal(shouldBlockForPlan("render_canvas_view", "present", "s1"), false);
		assert.equal(shouldBlockForPlan("ask_user", "ui_command", "s1"), false);
		assert.equal(shouldBlockForPlan("propose_plan", "ui_command", "s1"), false); // re-propose 合法
		assert.equal(shouldBlockForPlan("todo_write", "write_light", "s1"), false); // 豁免
		assert.equal(shouldBlockForPlan("spawn_subagent", "write_light", "s1"), false); // P4 豁免（#841 F5：调研是 plan 输入）
		assert.equal(shouldBlockForPlan("unknown_tool", undefined, "s1"), false);
	});

	it("P4 双向：豁免只放 spawn_subagent，同 tier 写类工具仍拦（防豁免面误扩）", () => {
		markPlanDecision("s1", "keep");
		assert.equal(shouldBlockForPlan("spawn_subagent", "write_light", "s1"), false);
		assert.equal(shouldBlockForPlan("set_node_text", "write_light", "s1"), true);
		assert.equal(shouldBlockForPlan("arrange_nodes", "graph_batch", "s1"), true);
	});

	it("run 信号：consume 一次即清；clearPlanRunFlag 只清信号不动 pending", () => {
		markPlanDecision("s1", "execute");
		assert.equal(consumePlanExecutionSignal("s1"), true);
		assert.equal(consumePlanExecutionSignal("s1"), false); // 防双执行
		markPlanDecision("s1", "execute");
		clearPlanRunFlag("s1");
		assert.equal(isPlanPending("s1"), false); // pending 不动
		assert.equal(consumePlanExecutionSignal("s1"), false);
		markPlanDecision("s1", "refine");
		assert.equal(isPlanPending("s1"), true); // refine 后 pending 回 true
	});

	it("seedPlanState：execute 播 idle，其余播 pending；run 信号恒 false", () => {
		seedPlanState("s1", "execute");
		assert.equal(isPlanPending("s1"), false);
		assert.equal(consumePlanExecutionSignal("s1"), false);
		seedPlanState("s1", "timeout");
		assert.equal(isPlanPending("s1"), true);
		assert.equal(consumePlanExecutionSignal("s1"), false);
	});

	it("D5 回归锁（spec 2026-11-11 §P1-3）：timeout/aborted/refine/keep 永不置 run 信号 ⇒ before_run_end 不会注入 followUp 续跑", () => {
		// 防未来把「超时降级续跑」误接回 wiring：followUp 唯一触发条件是
		// consumePlanExecutionSignal===true，而它只由 execute 置位。
		for (const d of ["timeout", "aborted", "refine", "keep"] as const) {
			resetPlanState("s1");
			markPlanDecision("s1", d);
			assert.equal(consumePlanExecutionSignal("s1"), false, `decision=${d} 不得置 run 信号`);
			assert.equal(isPlanPending("s1"), true, `decision=${d} 须保持 pending（fail-closed）`);
		}
	});
});

describe("pickLatestPlanDecision", () => {
	it("反向扫描三种 entry 形态（生产 probe 形态 + 官方同构顶层形态），非法 decision 忽略", () => {
		const wrapped = { type: "message", message: { role: "toolResult", toolName: "propose_plan", details: { plan: { decision: "keep" } } } };
		const top = { toolName: "propose_plan", details: { plan: { decision: "execute" } } };
		const resultWrapped = { message: { toolName: "propose_plan", result: { details: { plan: { decision: "refine" } } } } };
		assert.equal(pickLatestPlanDecision([top, wrapped]), "keep"); // 数组尾 = 最新
		assert.equal(pickLatestPlanDecision([wrapped, resultWrapped]), "refine");
		assert.equal(pickLatestPlanDecision([{ toolName: "propose_plan", details: { plan: { decision: "bogus" } } }]), undefined);
		assert.equal(pickLatestPlanDecision([{ toolName: "todo_write", details: { todo: {} } }]), undefined);
		assert.equal(pickLatestPlanDecision([]), undefined);
	});
});
