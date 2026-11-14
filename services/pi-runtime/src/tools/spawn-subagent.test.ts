/**
 * C4 spawn_subagent 工具（spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.1/§3.5）。
 * fail-soft 铁律：execute 永不 throw——主 run 不因子代理任何形态的失败而中断。
 * execute 6 参姿势照抄 propose-plan.test.ts（vendor AgentHarnessTool 真实签名）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../metrics.js";
import { SubagentCoordinator, SUBAGENT_TOOL_WHITELIST } from "../gate/subagent.js";
import { createSpawnSubagentTool, createCollectSubagentTool, composeSubagentPrompt, DEFAULT_REPORT_FORMAT } from "./spawn-subagent.js";

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

	// —— D1（2026-11-11）：outcome 埋点（spawned 已有，outcome 全仓零业务调用）——
	it("outcome 埋点：正常路径产出 completed 样本", async () => {
		const c = new SubagentCoordinator();
		c.attach({
			runSubagent: async () => ({ report: "R", turns: 1, durationMs: 10, status: "completed" }),
		});
		const m = new Metrics();
		await createSpawnSubagentTool(c, m).execute(
			"call-ok", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const text = m.render(0, "test");
		assert.match(text, /pi_runtime_subagent_spawned_total 1/);
		assert.match(text, /pi_runtime_subagent_outcome_total\{status="completed"\} 1/);
	});

	it("outcome 埋点：failed / timeout / budget_exceeded 各产出一次", async () => {
		for (const status of ["failed", "timeout", "budget_exceeded"] as const) {
			const c = new SubagentCoordinator();
			c.attach({
				runSubagent: async () => ({ report: "R", turns: 1, durationMs: 10, status }),
			});
			const m = new Metrics();
			await createSpawnSubagentTool(c, m).execute(
				`call-${status}`, { task: "t" } as never, noopUpdate,
				{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
			);
			assert.match(m.render(0, "test"), new RegExp(`pi_runtime_subagent_outcome_total\\{status="${status}"\\} 1`));
		}
	});

	it("rejected 分支不产生 outcome（spawned 也不增加）", async () => {
		const m = new Metrics();
		const tool = createSpawnSubagentTool(new SubagentCoordinator(), m);
		await tool.execute(
			"call-rej", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const text = m.render(0, "test");
		assert.match(text, /pi_runtime_subagent_spawned_total 0/);
		assert.doesNotMatch(text, /pi_runtime_subagent_outcome_total\{status=/);
	});

	it("runner reject（coordinator 兜底 failed）也产出 failed 样本", async () => {
		const c = new SubagentCoordinator();
		c.attach({ runSubagent: () => Promise.reject(new Error("boom")) });
		const m = new Metrics();
		await createSpawnSubagentTool(c, m).execute(
			"call-fail", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		assert.match(m.render(0, "test"), /pi_runtime_subagent_outcome_total\{status="failed"\} 1/);
	});

	// —— 基线修复 T2/T3（2026-11-12）：description 关键词信号 + 禁用条件 + fallback 自行完成引导 ——
	it("★ description 含触发关键词信号（调研/研究/探索/多源核对/联网查资料）", () => {
		const tool = createSpawnSubagentTool(new SubagentCoordinator(), new Metrics());
		const d = tool.description;
		for (const kw of ["调研", "研究", "探索", "多源核对", "联网查资料"]) {
			assert.ok(d.includes(kw), `description 应含触发关键词「${kw}」`);
		}
	});

	it("★ description 保留禁用条件（改画布/生成内容别派/自己做）", () => {
		const tool = createSpawnSubagentTool(new SubagentCoordinator(), new Metrics());
		const d = tool.description;
		for (const kw of ["改画布", "生成内容", "别派", "自己做"]) {
			assert.ok(d.includes(kw), `description 应保留勿用条件「${kw}」`);
		}
	});

	it("★ fallback 含自行完成引导（ok:false 时给 hint，不卡死不静默放弃）", async () => {
		// coordinator 未 attach → tryRun 返回 {ok:false, reason:'not_attached'} → 工具回 subagent_not_available + hint
		const tool = createSpawnSubagentTool(new SubagentCoordinator(), new Metrics());
		const res = await tool.execute(
			"call-fb", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const body = textOf(res);
		assert.equal(body.ok, false);
		assert.equal(body.error, "subagent_not_available");
		assert.match(String(body.hint ?? ""), /自行联网\/读文档完成调研/);
	});

	// —— 刀B（2026-11-14）：报告截断标记（G6 前半，spec §4.3）——
	// 契约：runSubagent（session-manager）负责调 applyReportTruncation 置 truncated；
	// 工具层只透传 outcome.truncated。边界本身在 gate/subagent.test.ts 钉。
	it("★ outcome.truncated=true 时透传到结果", async () => {
		const c = new SubagentCoordinator();
		c.attach({
			runSubagent: async () => ({ report: "x".repeat(20_000), turns: 1, durationMs: 1, status: "completed", truncated: true }),
		});
		const res = await createSpawnSubagentTool(c, new Metrics()).execute(
			"call-trunc", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const body = textOf(res);
		assert.equal(body.ok, true);
		assert.equal(body.truncated, true);
	});
	it("★ outcome 无 truncated 字段时结果亦无（additive 边界）", async () => {
		const c = new SubagentCoordinator();
		c.attach({
			runSubagent: async () => ({ report: "y".repeat(20_000), turns: 1, durationMs: 1, status: "completed" }),
		});
		const res = await createSpawnSubagentTool(c, new Metrics()).execute(
			"call-exact", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const body = textOf(res);
		assert.equal(body.ok, true);
		assert.equal("truncated" in body, false);
	});

	it("★ 子代理白名单不含 spawn_subagent（递归封死不变量，呼应 spec §3.3）", () => {
		assert.equal(SUBAGENT_TOOL_WHITELIST.has("spawn_subagent"), false);
	});
});

// —— 刀B（2026-11-14，spec 2026-11-14-subagent-contract-d2-nonblock-design.md §4.1）——
describe("composeSubagentPrompt（task 结构化 + 默认报告骨架）", () => {
	it("无 background/reportFormat 时只追加默认骨架", () => {
		const p = composeSubagentPrompt("调研 A vs B");
		assert.equal(p, "调研 A vs B\n【期望报告形态】" + DEFAULT_REPORT_FORMAT);
	});
	it("background 与自定义 reportFormat 都生效（自定义时不含默认骨架）", () => {
		const p = composeSubagentPrompt("查 X", "已读过官方文档", "只要对比表");
		assert.ok(p.includes("【背景】已读过官方文档"));
		assert.ok(p.includes("【期望报告形态】只要对比表"));
		assert.ok(!p.includes(DEFAULT_REPORT_FORMAT));
	});
	it("空串/纯空白字段跳过", () => {
		const p = composeSubagentPrompt("查 X", "  ", "");
		assert.ok(!p.includes("【背景】"));
		assert.ok(p.includes("【期望报告形态】" + DEFAULT_REPORT_FORMAT));
	});
	it("DEFAULT_REPORT_FORMAT 含结论先行与来源清单要求", () => {
		assert.ok(DEFAULT_REPORT_FORMAT.includes("结论先行"));
		assert.ok(DEFAULT_REPORT_FORMAT.includes("来源"));
		assert.ok(DEFAULT_REPORT_FORMAT.includes("未核实"));
	});
});

// —— 刀A（2026-11-14）：mode 双分支 + collect 工具（spec 2026-11-14-subagent-contract-d2-nonblock-design.md §6.3）——
describe("spawn_subagent mode 分支 + collect_subagent_result", () => {
	it("block 默认：结果含 callId（additive）", async () => {
		const c = new SubagentCoordinator();
		c.attach({ runSubagent: async () => ({ report: "R", turns: 1, durationMs: 1, status: "completed" }) });
		const res = await createSpawnSubagentTool(c, new Metrics()).execute(
			"c-b", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const body = textOf(res);
		assert.equal(body.ok, true);
		assert.ok(typeof body.callId === "string" && (body.callId as string).length > 10);
	});

	it("background：立即返回 callId+running+hint；spawned 照打；随后 collect 拿到报告", async () => {
		const c = new SubagentCoordinator();
		c.attach({ runSubagent: async () => ({ report: "后台报告", turns: 2, durationMs: 5, status: "completed" }) });
		const m = new Metrics();
		const spawn = createSpawnSubagentTool(c, m);
		const collect = createCollectSubagentTool(c, m);
		const res = await spawn.execute(
			"c-bg", { task: "t", mode: "background" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const body = textOf(res);
		assert.equal(body.ok, true);
		assert.equal(body.status, "running");
		const callId = body.callId as string;
		assert.match(String(body.hint), /collect_subagent_result/);
		assert.match(m.render(0, "test"), /pi_runtime_subagent_spawned_total 1/);
		// collect：running → 终态
		const r1 = await collect.execute("cc1", { callId } as never, noopUpdate, {} as never, invocation as never, chordCtx as never);
		// 后台 runner 是 async 立即 resolve——microtask 后应已 settle；若恰 running 也合法（不硬断言）
		const b1 = textOf(r1);
		assert.ok(["running", "completed"].includes(b1.status as string));
		await new Promise((r) => setTimeout(r, 10));
		const r2 = await collect.execute("cc2", { callId } as never, noopUpdate, {} as never, invocation as never, chordCtx as never);
		const b2 = textOf(r2);
		assert.equal(b2.ok, true);
		assert.equal(b2.status, "completed");
		assert.equal(b2.report, "后台报告");
		// collect metrics
		assert.match(m.render(0, "test"), /pi_runtime_subagent_collect_total\{status="completed"\} 1/);
	});

	it("collect unknown：ok:false + 重新派发 hint", async () => {
		const c = new SubagentCoordinator();
		const collect = createCollectSubagentTool(c, new Metrics());
		const res = await collect.execute("cc3", { callId: "nope" } as never, noopUpdate, {} as never, invocation as never, chordCtx as never);
		const body = textOf(res);
		assert.equal(body.ok, false);
		assert.equal(body.error, "subagent_unknown");
		assert.match(String(body.hint), /重新派发/);
	});

	it("collect 注册形状：tier=read（不在 plan-gate 拦截面）", () => {
		const tool = createCollectSubagentTool(new SubagentCoordinator(), new Metrics());
		assert.equal(tool.name, "collect_subagent_result");
		assert.equal(tool.tier, "read");
	});

	it("★ collect 不在子代理白名单（嵌套/越权双封）", () => {
		assert.equal(SUBAGENT_TOOL_WHITELIST.has("collect_subagent_result"), false);
	});
});
