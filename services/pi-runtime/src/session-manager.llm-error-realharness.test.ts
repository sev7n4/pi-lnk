/**
 * LLM 错误维度的**真 harness 阳性对照**（P0.5，2026-10-06）。
 *
 * 背景（线上受控注入实证）：vendor 把 LLM 上游失败**物化**成 `stopReason:"error"` 的
 * assistant 消息并**正常结算** run（vendor `agent.ts` handleRunFailure）⇒
 * `lane.prompt` 以 ok 结算 ⇒ `.then(!result.ok)` / `.catch` 的 observeLlmFailure 都不触发
 * ⇒ `llm_errors_total` 恒空（retries 正常计数），且用户侧只收到一条空 assistant 消息。
 * 既有 `session-manager.llm-error.test.ts` 用假 lane 伪造 `ok:false`/throw，对这条
 * 「假性成功」路径**结构性失明** —— 它证明不了真实失败形态能进指标。
 *
 * 本文件用真 `AgentHarness.create` + faux 模型（vendor harness 测试的官方做法）复现
 * 该形态，锁定两件事：
 * 1. 失败 run 必须穿过 `run_end`（status:"failed"）进 `llm_errors_total`
 *    （修复前的回归 = 本文件红）；
 * 2. **重试不双计、恢复不计**：真 harness 探针实证 vendor 对每次失败的尝试都各提交
 *    一条 error 终态消息（4 次尝试 = 4 条 message_end）⇒ 观测口必须挂 `run_end`
 *    （每 run 恰一条终态），恰好计 1，且重试由 `llm_retries_total` 单独计数。
 *
 * 变异验证：注释掉 attachEvents 的 run_end 分支 ⇒ 用例 1 必红；改成挂 message_end
 * 且不去重 ⇒ 用例 1 的「恰好 1」必红（会变成 4）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-llmerr-real-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `ler${++cfgSeq}`),
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

/** 轮询直到谓词成立（run 是 fire-and-forget，只能等指标落地）。 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail(`等待超时：${what}`);
}

/** 真 harness + faux 模型 + 空 LLM 错误注入脚手架（构造 9 参按位对齐，metrics 第 9 位）。 */
async function makeRealHarnessManager(metrics: Metrics, key: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const sm = new SessionManager(
		[],
		"",
		modelFactory,
		undefined,
		undefined,
		undefined,
		testConfig(),
		undefined,
		metrics,
	);
	await sm.create(key, { userId: "u1" });
	return { sm, faux };
}

function llmErrorLines(rendered: string): string[] {
	return rendered.split("\n").filter((l) => l.startsWith("pi_runtime_llm_errors_total{"));
}

test("真 harness 下 LLM 上游失败 → llm_errors_total 恰好计 1 次 run（重试不双计）", async () => {
	const metrics = new Metrics();
	const { sm, faux } = await makeRealHarnessManager(metrics, "sess-llmfail");
	// 恒失败：每次尝试都返回 stopReason:"error"（复现线上注入的「假性成功」形态；
	// "Connection error." 不含 4xx/5xx/timeout 关键词 ⇒ 分类器兜底落 internal）。
	faux.setResponses(
		Array.from({ length: 8 }, () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
		),
	);
	await sm.prompt("sess-llmfail", "go");

	// 观测口挂 run_end（run 结算终态）⇒ 计数落地时重试已全部耗尽，retries 应为 3。
	let rendered = "";
	await waitFor(
		() => {
			rendered = metrics.render(0, "test");
			return llmErrorLines(rendered).length > 0;
		},
		"llm_errors_total 落地（run_end failed 未穿过事件层 —— P0.5 盲区回归）",
	);

	// 核心：4 次尝试（初试 + 3 重试）只允许计 1 次 run 级失败。
	assert.deepEqual(
		llmErrorLines(rendered),
		['pi_runtime_llm_errors_total{stage="main_turn",error_class="internal",channel="faux",model="faux-1"} 1'],
		"llm_errors_total 未按 run 结算（重试被双计）或标签不正确",
	);
	// 对照组：重试确实发生了（3 次），证明「errors=1」来自挂终态而非「只有一次尝试」。
	assert.match(
		rendered,
		/pi_runtime_llm_retries_total\{stage="[a-z_]+",channel="faux",model="faux-1"\} 3/,
		"faux 恒失败应触发 3 次 run 内重试；此断言失败说明 fixtures 没走到重试路径",
	);
	// 错误原文不进指标行（防 label 基数爆炸，与 llm-error.test.ts 同判）。
	assert.ok(!rendered.includes("Connection error"), "错误原文泄漏进了指标输出");
});

test("模型侧 stopReason:aborted → 恰好计 1（结算口与 run_end 口不叠加）", async () => {
	const metrics = new Metrics();
	const { sm, faux } = await makeRealHarnessManager(metrics, "sess-abort");
	// 模型侧 stopReason:"aborted"（探针实证）：run_end 不以 failed 终态发出，计数来自
	// 既有 `.then(!result.ok)` 结算口 ⇒ 本用例锁定的是**两个观测口不叠加**：若 run_end
	// 口把它再计一次，这里会看到 2。
	faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted by model" })]);
	await sm.prompt("sess-abort", "go");
	let rendered = "";
	await waitFor(
		() => {
			rendered = metrics.render(0, "test");
			return llmErrorLines(rendered).length > 0;
		},
		"aborted 物化形态未进 llm_errors_total（既有结算口回归）",
	);
	assert.deepEqual(
		llmErrorLines(rendered),
		['pi_runtime_llm_errors_total{stage="main_turn",error_class="internal",channel="faux",model="faux-1"} 1'],
		"aborted 形态被重复计数（run_end 口与结算口叠加）",
	);
});
