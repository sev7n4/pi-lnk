/**
 * 工具错误维度的**真 harness 阳性对照**（P0，2026-10-05 交接项 ③ 的补强）。
 *
 * 为什么在 `session-manager.toolmetrics.test.ts`（假 emitter 接线测试）之外还要本文件：
 * 接线测试证明的是「SessionManager.attachEvents → ToolMetrics → /metrics」这一段；
 * 它**证明不了真 vendor harness 在工具真失败时发出的 `tool_end` 真的带 `isError:true`**
 * ——如果 vendor 改了契约（例如把失败信息挪进 `result` 而不置 `isError`），接线测试
 * 照样全绿（它自己伪造事件），而线上 `result` 将永远只有 `"ok"`，且**无法从指标层
 * 区分「没错误」与「错误没被渲染」**。本文件用真 `AgentHarness.create` + faux 模型
 * 驱动一次**真实工具抛错**堵上这一环：vendor 把 execute 的 throw 转成
 * `AgentToolResult{isError:true}`（harness.md §tools），指标必须渲染出
 * `result="error",error_class=...`。注释掉 attachEvents 的 tool_end 分支、或 vendor
 * 契约回归 ⇒ 本文件必红。
 *
 * 为什么用「工具抛错」而不是「未知工具」：前者走完整的 execute 效应路径（与生产
 * 404「会话不存在」同形态 —— Nest 侧 throw → nest-client 重抛 → vendor 转错误结果）；
 * 后者是 vendor 合成的 planned 路径，覆盖面更窄。
 *
 * faux 模型的合法性：vendor 自己的 harness 测试（test/harness/runtime/*.test.ts）
 * 全部用它驱动真 harness；它只替换 LLM 边界，工具执行、事件发射、指标结算全是真的。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";
import type { LnkpiTool } from "./tools/types.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-toolmetrics-real-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `rh${++cfgSeq}`),
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

/** 受控失败工具：与生产工具同形态（LnkpiTool），execute 恒抛 —— 与 nest-client 重抛 4xx 同构。 */
const boomProbe: LnkpiTool = {
	tier: "read",
	name: "boom_probe",
	label: "boom_probe",
	description: "受控失败注入：execute 必然抛错（阳性对照专用，生产注册表不含本工具）",
	parameters: Type.Object({}),
	execute: async () => {
		throw new Error("boom: controlled failure injection");
	},
};

/** 轮询直到谓词成立（run 是 fire-and-forget，只能等指标落地）。 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail(`等待超时：${what}`);
}

test("真 harness 下工具抛错 → /metrics 渲染 result=error（vendor 契约阳性对照）", async () => {
	const metrics = new Metrics();
	const faux = fauxProvider();
	// 两次 LLM 请求：① toolUse 让模型调 boom_probe；② 文本收尾让 run 正常结束
	//（若不给第二次响应，run 会以 LLM 错误告终 —— 不影响本断言，但会让会话残留 error 事件）。
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("boom_probe", {}, { id: "call-boom-1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	// 注入 faux 模型（第 3 参 modelFactory），**harnessFactory 保持默认 = 真 AgentHarness.create**。
	const modelFactory = () => ({
		models,
		model: faux.getModel(),
		providerId: faux.provider.id,
	});
	// 构造参数必须按位对齐（tools, systemPrompt, modelFactory, harnessFactory, hooks, skills,
	// config, onCompaction, metrics）—— config/metrics 错一位就是静默无指标（实测踩过）。
	const sm = new SessionManager(
		[boomProbe],
		"",
		modelFactory,
		undefined,
		undefined,
		undefined,
		testConfig(),
		undefined,
		metrics,
	);
	await sm.create("sess-boom", { userId: "u1" });
	await sm.prompt("sess-boom", "请调用 boom_probe 工具");

	const out = await (async () => {
		let rendered = "";
		await waitFor(
			() => {
				rendered = metrics.render(0, "test");
				return rendered.includes('pi_runtime_tool_calls_total{tool="boom_probe"');
			},
			"boom_probe 的 tool_calls_total 落地（真 vendor tool_end 事件未被结算）",
		);
		return rendered;
	})();

	// 锁死错误维度：isError:true 必须活着穿过 vendor → session-manager → ToolMetrics。
	// 文本「boom: controlled failure injection」不含 4xx/5xx/timeout/network/gate/validation
	// 关键词 ⇒ 按分类器优先级兜底落 internal（tool-error-class.ts:83）。
	assert.match(
		out,
		/pi_runtime_tool_calls_total\{tool="boom_probe",result="error",error_class="internal"\} 1/,
		"vendor tool_end 未携带 isError:true（或接线丢失）——错误维度对真实失败静默",
	);
	// start/end 配对成功 ⇒ 记了时长（未配对的孤儿只计数不记时长）。
	assert.match(out, /pi_runtime_tool_duration_seconds_count\{tool="boom_probe"\} 1/);
	assert.equal(metrics.toolMetrics().stats().ended, 1);
});
