import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createProposePlanTool } from "./propose-plan.js";
import { getTodoState, resetTodoStoreForTest } from "./todo.js";
import { resetPlanState, isPlanPending, consumePlanExecutionSignal } from "../gate/plan-gate.js";
import { planGateEnabled } from "../runtime-config.js";
import type { PendingToolRegistry } from "../pending-registry.js";
import type { Metrics } from "../metrics.js";

/** stub registry：waitForUser 可编程返回。 */
function stubRegistry(resolution: Awaited<ReturnType<PendingToolRegistry["waitForUser"]>>): PendingToolRegistry {
	return { waitForUser: async () => resolution } as unknown as PendingToolRegistry;
}
const metrics = { observePlanProposed() {}, observePlanDecision() {}, observePlanGateBlocked() {} } as unknown as Metrics;

const noopUpdate = () => {};
/** vendor AgentHarnessTool.execute 尾参 stub（invocation + chord Context）。 */
const invocation = {
	invocationId: "inv", operationId: "op", turnId: "t",
	getMemo: async () => undefined, setMemo: async () => {},
};
const ctx = { abortSignal: undefined, value: () => undefined, toString: () => "test" };

const CARD = { callId: "call-1" };

function toolCall(id: string, p: { summary: string; steps: { content: string; activeForm?: string }[] }) {
	return { id, p };
}

describe("planGateEnabled kill switch", () => {
	it("缺省开；PI_RUNTIME_PLAN_GATE=off 关", () => {
		assert.equal(planGateEnabled({}), true);
		assert.equal(planGateEnabled({ PI_RUNTIME_PLAN_GATE: "off" }), false);
	});
});

describe("propose_plan 工具", () => {
	beforeEach(() => {
		resetTodoStoreForTest();
		resetPlanState("canvas-1");
	});

	it("execute：steps 全量落 todo store（pending + activeForm 透传）+ plan 置 idle + run 信号置位 + confirmed=true", async () => {
		const t = createProposePlanTool(stubRegistry({ status: "answered", answers: { plan_confirm: ["execute"] } }), metrics);
		const call = toolCall(CARD.callId, { summary: "三步配图", steps: [{ content: "建节点", activeForm: "正在建节点" }, { content: "生成图" }] });
		const res = await t.execute!(call.id, call.p, noopUpdate, { sessionId: "canvas-1" } as never, invocation as never, ctx as never);
		assert.deepEqual(getTodoState("canvas-1"), [
			{ id: "plan-1", content: "建节点", activeForm: "正在建节点", status: "pending" },
			{ id: "plan-2", content: "生成图", status: "pending" },
		]);
		const details = res.details as { plan: { decision: string; confirmed: boolean; summary: string } };
		assert.equal(details.plan.decision, "execute");
		assert.equal(details.plan.confirmed, true);
		assert.equal(isPlanPending("canvas-1"), false);
		assert.equal(consumePlanExecutionSignal("canvas-1"), true);
	});

	it("refine（选项）：保持拦写 + feedback 透传；todo 步骤仍落清单", async () => {
		const t = createProposePlanTool(stubRegistry({ status: "answered", answers: { plan_confirm: ["refine", "第二步换成竖版"] } }), metrics);
		const call = toolCall("c2", { summary: "s", steps: [{ content: "a" }] });
		const res = await t.execute!(call.id, call.p, noopUpdate, { sessionId: "canvas-1" } as never, invocation as never, ctx as never);
		const details = res.details as { plan: { decision: string; confirmed: boolean; feedback?: string } };
		assert.equal(details.plan.decision, "refine");
		assert.equal(details.plan.feedback, "第二步换成竖版");
		assert.equal(details.plan.confirmed, false);
		assert.equal(isPlanPending("canvas-1"), true);
		assert.equal(getTodoState("canvas-1").length, 1);
	});

	it("refine（自由输入无选项）：values 全文作 feedback", async () => {
		const t = createProposePlanTool(stubRegistry({ status: "answered", answers: { plan_confirm: ["改成先出文案再配图"] } }), metrics);
		const call = toolCall("c3", { summary: "s", steps: [{ content: "a" }] });
		const res = await t.execute!(call.id, call.p, noopUpdate, { sessionId: "canvas-1" } as never, invocation as never, ctx as never);
		const details = res.details as { plan: { decision: string; feedback?: string } };
		assert.equal(details.plan.decision, "refine");
		assert.equal(details.plan.feedback, "改成先出文案再配图");
	});

	it("keep：保持拦写；timeout / aborted：fail-closed 保持拦写", async () => {
		for (const [resolution, decision] of [
			[{ status: "answered", answers: { plan_confirm: ["keep"] } }, "keep"],
			[{ status: "timeout", answers: {} }, "timeout"],
			[{ status: "aborted" }, "aborted"],
		] as const) {
			resetPlanState("canvas-1");
			const t = createProposePlanTool(stubRegistry(resolution as never), metrics);
			const call = toolCall("cx", { summary: "s", steps: [{ content: "a" }] });
			const res = await t.execute!(call.id, call.p, noopUpdate, { sessionId: "canvas-1" } as never, invocation as never, ctx as never);
			const details = res.details as { plan: { decision: string; confirmed: boolean } };
			assert.equal(details.plan.decision, decision);
			assert.equal(details.plan.confirmed, false);
			assert.equal(isPlanPending("canvas-1"), true, decision);
		}
	});

	it("确认卡经 onUpdate 下发（ask_user 通道同构：type=ask_user + callId + 三选项）", async () => {
		let update: { content: { text: string }[] } | undefined;
		const t = createProposePlanTool(stubRegistry({ status: "answered", answers: { plan_confirm: ["execute"] } }), metrics);
		const call = toolCall("c5", { summary: "三步配图", steps: [{ content: "a" }] });
		await t.execute!(call.id, call.p, (u: unknown) => { update = u as { content: { text: string }[] }; }, { sessionId: "canvas-1" } as never, invocation as never, ctx as never);
		assert.ok(update);
		const card = JSON.parse(update!.content[0].text);
		assert.equal(card.ok, true);
		const cmd = card.canvasCommands[0];
		assert.equal(cmd.type, "ask_user");
		assert.equal(cmd.callId, "c5");
		assert.deepEqual(cmd.questions[0].options.map((o: { value: string }) => o.value), ["execute", "refine", "keep"]);
		assert.equal(cmd.questions[0].allowOther, true);
	});
});
