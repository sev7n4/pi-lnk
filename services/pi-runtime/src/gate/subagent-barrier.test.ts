import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";
import { registerRunEndHooks, composeBarrierFollowUp, type BarrierMetrics } from "./subagent-barrier.js";
import { SubagentCoordinator, type SettledSubagentResult } from "./subagent.js";
import { markPlanDecision } from "./plan-gate.js";
import { overwriteTodos, resetTodoStoreForTest } from "../tools/todo.js";
import { Metrics } from "../metrics.js";

describe("P1 barrier 可观测", () => {
	it("metrics：barrier 指标按 outcome 累加并 render", () => {
		const m = new Metrics();
		m.observeBarrier("waited");
		m.observeBarrier("deadline");
		m.observeBarrier("waited");
		const text = m.render(1, "test");
		assert.match(text, /pi_runtime_subagent_barrier_total\{outcome="waited"\} 2/);
		assert.match(text, /pi_runtime_subagent_barrier_total\{outcome="deadline"\} 1/);
	});
});

describe("P1 barrier followUp 文案", () => {
	it("无结果 → undefined（不注入）", () => {
		assert.equal(composeBarrierFollowUp([]), undefined);
	});
	it("completed + failed + interrupted 三条都进文案，状态与 partial 明确", () => {
		const results: SettledSubagentResult[] = [
			{ callId: "c1", status: "completed", report: "调研结论：X", partial: false },
			{ callId: "c2", status: "failed", report: "失败原因", partial: true },
			{ callId: "c3", status: "interrupted", report: "", partial: true },
		];
		const text = composeBarrierFollowUp(results)!;
		assert.match(text, /后台子任务/);
		assert.match(text, /c1/);
		assert.match(text, /调研结论：X/);
		assert.match(text, /completed/);
		assert.match(text, /c2/);
		assert.match(text, /failed/);
		assert.match(text, /c3/);
		assert.match(text, /interrupted/);
		assert.match(text, /结果不完整|不可恢复/);
	});
	it("stream_interrupted 标 partial", () => {
		const text = composeBarrierFollowUp([
			{ callId: "c9", status: "stream_interrupted", report: "半截", partial: true },
		])!;
		assert.match(text, /stream_interrupted/);
		assert.match(text, /结果不完整|不完整|partial/);
	});
});

type RunEndHandler = (event: { runId: string; messages: unknown[] }) => Promise<{ followUp?: string } | undefined>;

function hookCaptureHarness(): { harness: AgentHarness<LnkpiToolContext>; getRunEnd: () => RunEndHandler | undefined } {
	let runEnd: RunEndHandler | undefined;
	const harness = {
		hooks: {
			on: (name: string, fn: RunEndHandler) => {
				if (name === "before_run_end") runEnd = fn;
			},
		},
	} as unknown as AgentHarness<LnkpiToolContext>;
	return { harness, getRunEnd: () => runEnd };
}

const metricsStub = (): BarrierMetrics => ({ observeBarrier: () => {} });

describe("P1 barrier 行为级", () => {
	const config = (coordinator: SubagentCoordinator) => ({ sessionId: "s-main", coordinator, resolvePlanKey: () => "s-main", metrics: metricsStub() });

	it("B1：pending 未 settle 时 before_run_end 挂住，settle 后 followUp 含报告", async () => {
		let release!: () => void;
		const coordinator = new SubagentCoordinator();
		coordinator.attach({ runSubagent: () => new Promise((res) => { release = () => res({ report: "RESULT-X", turns: 1, durationMs: 1, status: "completed" }); }) });
		const bg = coordinator.tryRun("s-main", "t", { mode: "background" });
		assert.ok(bg.ok);
		const { harness, getRunEnd } = hookCaptureHarness();
		registerRunEndHooks(harness, config(coordinator));
		const handler = getRunEnd()!;
		let settled = false;
		const endP = handler({ runId: "r", messages: [] }).then((v) => { settled = true; return v; });
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(settled, false, "子任务未 settle 时收尾必须挂住");
		release();
		const out = await endP;
		assert.match(out?.followUp ?? "", /RESULT-X/);
		assert.match(out?.followUp ?? "", /completed/);
	});

	it("B3：deadline 到仍未 settle → 真 handler 返回 interrupted followUp，收尾不永久挂住", async () => {
		const coordinator = new SubagentCoordinator();
		coordinator.attach({ runSubagent: () => new Promise(() => {}) }); // 永挂
		const bg = coordinator.tryRun("s-main", "t", { mode: "background" });
		assert.ok(bg.ok);
		const outcomes: string[] = [];
		const m: BarrierMetrics = { observeBarrier: (o) => outcomes.push(o) };
		const { harness, getRunEnd } = hookCaptureHarness();
		// 真 handler + 注入 30ms 短 deadline → 必须自行收敛，不永久挂住父 run（P1 核心事故形态）。
		registerRunEndHooks(harness, { ...config(coordinator), metrics: m, deadlineMs: 30 });
		const handler = getRunEnd()!;
		const t0 = Date.now();
		const out = await handler({ runId: "r", messages: [] });
		assert.ok(Date.now() - t0 < 2000, "deadline 到后 handler 必须尽快收敛，不得永久挂住");
		assert.match(out?.followUp ?? "", /interrupted/, "deadline 结果应标 interrupted");
		assert.match(out?.followUp ?? "", /不可恢复|不完整/, "deadline 结果应提示不可恢复");
		assert.ok(outcomes.includes("deadline"), `deadline 指标应上报，实际: ${outcomes.join(",")}`);
	});

	it("B6：plan-gate 与 barrier 同时命中时两条 followUp 都不丢（last-write-wins 防线）", async () => {
		resetTodoStoreForTest();
		const coordinator = new SubagentCoordinator();
		let release!: () => void;
		coordinator.attach({ runSubagent: () => new Promise((res) => { release = () => res({ report: "BG-REPORT", turns: 1, durationMs: 1, status: "completed" }); }) });
		const bg = coordinator.tryRun("s-main", "t", { mode: "background" });
		assert.ok(bg.ok);
		markPlanDecision("s-main", "execute");
		overwriteTodos("s-main", [{ content: "下一步", status: "pending" }]);
		const { harness, getRunEnd } = hookCaptureHarness();
		registerRunEndHooks(harness, config(coordinator));
		const endP = getRunEnd()!({ runId: "r", messages: [] });
		release(); // 放行子任务，让 barrier 的 awaitSettled 收敛
		const out = await endP;
		assert.match(out?.followUp ?? "", /BG-REPORT/, "barrier followUp 丢失");
		assert.match(out?.followUp ?? "", /下一步/, "plan-gate followUp 丢失");
	});
});
