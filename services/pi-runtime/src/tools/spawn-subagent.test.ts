/**
 * C4 spawn_subagent 工具（spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.1/§3.5）。
 * fail-soft 铁律：execute 永不 throw——主 run 不因子代理任何形态的失败而中断。
 * execute 6 参姿势照抄 propose-plan.test.ts（vendor AgentHarnessTool 真实签名）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../metrics.js";
import { SubagentCoordinator } from "../gate/subagent.js";
import { createSpawnSubagentTool } from "./spawn-subagent.js";

const noopUpdate = () => {};
/** vendor AgentHarnessTool.execute 尾参 stub（invocation + chord Context）。 */
const invocation = {
	invocationId: "inv", operationId: "op", turnId: "t",
	getMemo: async () => undefined, setMemo: async () => {},
};
const chordCtx = { abortSignal: undefined, value: () => undefined, toString: () => "test" };

function textOf(res: unknown): Record<string, unknown> {
	const r = res as { content: Array<{ text: string }> };
	return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe("spawn_subagent 工具", () => {
	it("注册形状：name/tier/参数 schema", () => {
		const tool = createSpawnSubagentTool(new SubagentCoordinator(), new Metrics());
		assert.equal(tool.name, "spawn_subagent");
		assert.equal(tool.tier, "write_light");
		assert.ok(tool.description.length > 20);
	});
	it("正常路径：委托 coordinator，返回 report+usage", async () => {
		const c = new SubagentCoordinator();
		c.attach({
			runSubagent: async () => ({ report: "调研结论X", turns: 3, durationMs: 1200, status: "completed" }),
		});
		const tool = createSpawnSubagentTool(c, new Metrics());
		const res = await tool.execute("call1", { task: "调研Y" } as never, noopUpdate, { piSessionKey: "k1" } as never, invocation as never, chordCtx as never);
		const body = textOf(res);
		assert.equal(body.ok, true);
		assert.equal(body.report, "调研结论X");
		const usage = body.usage as Record<string, unknown>;
		assert.equal(usage.status, "completed");
		assert.equal(usage.turns, 3);
	});
	it("runner 失败（coordinator 兜底 failed）：fail-soft 返回，不抛异常", async () => {
		const c = new SubagentCoordinator();
		c.attach({ runSubagent: () => Promise.reject(new Error("boom")) });
		const res = await createSpawnSubagentTool(c, new Metrics()).execute("call2", { task: "t" } as never, noopUpdate, { piSessionKey: "k" } as never, invocation as never, chordCtx as never);
		const body = textOf(res);
		assert.equal(body.ok, false);
		assert.equal(body.error, "subagent_failed");
		assert.match(String(body.report), /boom/);
	});
	it("并发满：fail-soft 返回 subagent_concurrency_full，主 run 不打断", async () => {
		const c = new SubagentCoordinator();
		const releases: Array<() => void> = [];
		c.attach({
			runSubagent: () =>
				new Promise((resolve) => {
					releases.push(() => resolve({ report: "x", turns: 1, durationMs: 1, status: "completed" as const }));
				}),
		});
		const tool = createSpawnSubagentTool(c, new Metrics());
		// 占满 2 个槽（不 await——同步语义下它们阻塞到子 run 结束）
		void tool.execute("c1", { task: "t" } as never, noopUpdate, { piSessionKey: "k" } as never, invocation as never, chordCtx as never);
		void tool.execute("c2", { task: "t" } as never, noopUpdate, { piSessionKey: "k" } as never, invocation as never, chordCtx as never);
		const res = await tool.execute("c3", { task: "t" } as never, noopUpdate, { piSessionKey: "k" } as never, invocation as never, chordCtx as never);
		const body = textOf(res);
		assert.equal(body.ok, false);
		assert.equal(body.error, "subagent_concurrency_full");
		releases.forEach((r) => r());
	});
	it("ctx 缺 piSessionKey：fail-soft 报错且不打 coordinator", async () => {
		const c = new SubagentCoordinator();
		let called = 0;
		c.attach({
			runSubagent: async () => {
				called += 1;
				return { report: "", turns: 0, durationMs: 0, status: "completed" as const };
			},
		});
		const res = await createSpawnSubagentTool(c, new Metrics()).execute("c4", { task: "t" } as never, noopUpdate, {} as never, invocation as never, chordCtx as never);
		const body = textOf(res);
		assert.equal(body.ok, false);
		assert.equal(called, 0);
	});
});
