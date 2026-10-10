/**
 * C2 turnBudget 接线测试（spec §3.1-3.4 + §5 Review Focus 1/5）。
 * 手动派发 harness 事件（session-manager.test.ts makeEmittableHarnessFactory 同款），
 * 验证 attachEvents 三点接线与硬停副作用；端到端语义由
 * session-manager.turn-budget.integration.test.ts（faux provider 真实 run）钉住。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-turn-budget-wiring-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function baseConfig(): RuntimeConfig {
	return {
		dataRoot: TEST_ROOT,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 可手动派发 harness 事件 + prompt 挂起可取消的 fake harness（abort 计数可观测）。 */
function makeEmittable(opts: { turnBudget?: number | "off"; metrics?: Metrics }) {
	const handlers = new Map<string, (evt: { lane?: string; runId?: string }) => void>();
	let aborted = 0;
	const fakeHarnessFactory = async () => ({
		harness: {
			events: {
				on: (type: string, handler: (evt: { lane?: string; runId?: string }) => void) => {
					handlers.set(String(type), handler);
					return () => {};
				},
			},
			lane: async () => ({
				prompt: async (_t: unknown, _i: unknown, ctx: { abortSignal?: AbortSignal }) =>
					new Promise((_res, rej) => {
						ctx?.abortSignal?.addEventListener(
							"abort",
							() => {
								aborted += 1;
								rej(new Error("aborted"));
							},
							{ once: true },
						);
					}),
				// steer / inspectExecution / requestAbort / drive 缺省 undefined：
				// warn steer 与 forceSettle 走各自 fail-soft 分支（生产里它们必然成功）。
			}),
			close: async () => {},
		},
	}) as never;
	const sm = new SessionManager(
		[],
		"",
		undefined,
		fakeHarnessFactory,
		undefined,
		undefined,
		{ ...baseConfig(), turnBudget: opts.turnBudget },
		undefined,
		opts.metrics,
	);
	return { handlers, sm, getAborted: () => aborted };
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test("wiring: 异 runId（compaction）不计数；同 runId 超限硬停且无 error 事件", async () => {
	const metrics = new Metrics();
	const { handlers, sm, getAborted } = makeEmittable({ turnBudget: 2, metrics });
	await sm.create("s-tb-wiring", {});
	const seen: string[] = [];
	sm.subscribe("s-tb-wiring", (e) => seen.push(e.type));
	void sm.prompt("s-tb-wiring", "hi");
	await tick();

	handlers.get("run_start")?.({ lane: "main", runId: "op-1" });
	// 5 个 compaction 轮（异 runId）：若被误计，第 3 个就会触发硬停
	for (let i = 0; i < 5; i++) handlers.get("turn_start")?.({ lane: "main", runId: "op-compaction" });
	await tick();
	assert.equal(getAborted(), 0, "compaction 轮不得触发硬停（Review Focus 1）");

	// 同 runId：第 1 轮 warn（budget=2 的阈值是负数 ⇒ 首轮即 warn），第 3 轮 exceed
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	await tick(30);
	assert.equal(getAborted(), 1, "第 3 轮（>budget=2）应触发硬停 cancelRun");
	assert.deepEqual(seen.filter((t) => t === "error"), [], "硬停走 userAborted 语义，不得派发 error");
	const text = metrics.render(1, "test");
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 1/);
	assert.match(text, /pi_runtime_turn_budget_warned_total 1/);
});

test("wiring: turnBudget=off 全旁路（20 轮超限也不硬停、零 metrics，Review Focus 5）", async () => {
	const metrics = new Metrics();
	const { handlers, sm, getAborted } = makeEmittable({ turnBudget: "off", metrics });
	await sm.create("s-tb-off", {});
	void sm.prompt("s-tb-off", "hi");
	await tick();
	handlers.get("run_start")?.({ lane: "main", runId: "op-1" });
	for (let i = 0; i < 20; i++) handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	await tick();
	assert.equal(getAborted(), 0, "off 不得硬停");
	const text = metrics.render(1, "test");
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 0/);
	assert.match(text, /pi_runtime_turn_budget_warned_total 0/);
});

test("wiring: run_end 后计数复位（下一 run 从 0 起，不得跨 run 累计）", async () => {
	const metrics = new Metrics();
	const { handlers, sm, getAborted } = makeEmittable({ turnBudget: 3, metrics });
	await sm.create("s-tb-reset", {});
	void sm.prompt("s-tb-reset", "hi");
	await tick();
	handlers.get("run_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("run_end")?.({ lane: "main", runId: "op-1" });
	handlers.get("run_start")?.({ lane: "main", runId: "op-2" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-2" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-2" });
	await tick();
	assert.equal(getAborted(), 0, "第二个 run 独立计数（2 ≤ 3），不得硬停");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 0/);
});
