import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";

/**
 * 1.5-a 的**接线**测试：主路径 LLM 失败必须真的进 `/metrics`。
 *
 * ⚠️ 与 `llm-error-class.test.ts` 的分工：
 * - 那边验「分类器算得对」（纯函数）
 * - 这边验「**接上了**」。**变异 `session-manager.ts` 里`observeLlmFailure(entry, ...)` 那一行，
 *   这边必须红** —— 否则重演「测试直接调被测方法、绕过接线却全绿」的假绿
 *   （本仓已踩过4 次，见 skill `mutation-test-verification`）。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-llmerr-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `le${++cfgSeq}`),
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

/** 造一个 harness，其 `lane.prompt` 行为由参数决定（抛错 / 返回 ok:false / 正常成功）。 */
type LaneBehavior = { kind: "throw"; error: Error } | { kind: "result-false"; error: Error } | { kind: "ok" };

async function makeManager(metrics: Metrics, behavior: LaneBehavior, key: string) {
	// 构造签名见 session-manager.ts:644 —— metrics 是第 9 个参数。
	const factory = async () =>
		({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({
					prompt: async () => {
						if (behavior.kind === "throw") throw behavior.error;
						if (behavior.kind === "result-false") return { ok: false, error: behavior.error };
						return { ok: true, value: undefined };
					},
					dispose: async () => {},
				}),
				close: async () => {},
			},
		}) as never;

	const sm = new SessionManager([], "", undefined, factory, undefined, undefined, testConfig(), undefined, metrics);
	await sm.create(key, { userId: "u1" });
	return sm;
}

function metricLines(body: string, metric: string): string[] {
	return body.split("\n").filter((l) => l.startsWith(`${metric}{`) || l.startsWith(`${metric} `));
}

/** 跑一次会失败的 prompt，等微任务落地后返回 /metrics 文本。 */
async function renderAfterFailingPrompt(behavior: LaneBehavior, key: string): Promise<string> {
	const metrics = new Metrics();
	const sm = await makeManager(metrics, behavior, key);
	await sm.prompt(key, { text: "你好" });
	// `lane.prompt` 的失败走 `.then` / `.catch`（微任务 + 一层 promise），给它落地时间
	await new Promise((r) => setTimeout(r, 40));
	return metrics.render(0, "test");
}

test("主路径 !result.ok：进 llm_errors_total（此前该路径零指标）", async () => {
	const out = await renderAfterFailingPrompt(
		{ kind: "result-false", error: new Error("upstream returned 503 service unavailable") },
		"s1:t1",
	);
	const lines = metricLines(out, "pi_runtime_llm_errors_total");
	assert.equal(lines.length, 1, `期望恰好 1 条样本，实际：${JSON.stringify(lines)}`);
	// 旧 2 值正则给不出 error_class：`/429|rate/` 不匹配 503 文本，旧指标只会记 upstream_error
	assert.match(lines[0], /error_class="upstream_5xx"/);
	assert.match(lines[0], /stage="main_turn"/);
});

test("主路径 throw：同样进 llm_errors_total（.catch 分支也接上了）", async () => {
	const out = await renderAfterFailingPrompt(
		{ kind: "throw", error: new Error("HTTP 429 rate limit exceeded") },
		"s2:t2",
	);
	const lines = metricLines(out, "pi_runtime_llm_errors_total");
	assert.equal(lines.length, 1, `期望恰好 1 条样本，实际：${JSON.stringify(lines)}`);
	assert.match(lines[0], /error_class="upstream_4xx"/);
});

test("错误原文不进指标行（防 label 基数爆炸）", async () => {
	const secret = "sk-live-SECRET-abc123";
	const out = await renderAfterFailingPrompt({ kind: "throw", error: new Error(`boom ${secret}`) }, "s3:t3");
	assert.equal(metricLines(out, "pi_runtime_llm_errors_total").length, 1);
	assert.equal(out.includes(secret), false, "错误原文泄漏进了 /metrics");
});

test("正常调用不产生 llm_errors_total（不误报）", async () => {
	const out = await renderAfterFailingPrompt({ kind: "ok" }, "s4:t4");
	assert.deepEqual(metricLines(out, "pi_runtime_llm_errors_total"), []);
});
