import assert from "node:assert/strict";
import { test } from "node:test";
import { ClassifiedLlmError, classifyLlmFailure, shouldCountLlmFailure } from "./llm-error-class.js";

/**
 * 1.5-a：LLM 调用主路径的失败分类（spec §4.5）
 *
 * 为什么单独一个模块而不是直接复用 `classifyToolOutcome`：
 * 主路径拿到的是 `unknown`/`Error`（vendor 的 `toError` 包装，无结构化错误码），
 * 且**用户主动取消必须排除**——取消不是错误，计进去会污染错误率分子。
 */

test("分类：优先识别用户取消（不算错误）", () => {
	assert.equal(shouldCountLlmFailure({ aborted: true, text: "" }), false);
});

test("分类：未标aborted 时都算错误", () => {
	assert.equal(shouldCountLlmFailure({ aborted: false, text: "boom" }), true);
});

test("Aborted 优先于任何错误文本（取消信号盖过错误文本）", () => {
	assert.equal(shouldCountLlmFailure({ aborted: true, text: "HTTP 429 rate limit" }), false);
});

const CASES: Array<[string, string]> = [
	["upstream returned 503 service unavailable", "upstream_5xx"],
	["HTTP 429 rate limit exceeded", "upstream_4xx"],
	["ETIMEDOUT after 30s", "timeout"],
	["ECONNRESET", "network"],
	["request aborted", "aborted"],
	["invalid arguments", "validation"],
];

for (const [text, expected] of CASES) {
	test(`分类：${JSON.stringify(text)} → ${expected}`, () => {
		assert.equal(classifyLlmFailure({ aborted: false, text }).errorClass, expected);
	});
}

test("无法判定 → internal（绝不静默丢弃）", () => {
	assert.equal(classifyLlmFailure({ aborted: false, text: "zzz玄学失败" }).errorClass, "internal");
});

test("stage：不在压缩期 → main_turn", () => {
	assert.equal(classifyLlmFailure({ aborted: false, text: "x", compacting: false }).stage, "main_turn");
});

test("stage：压缩期 → compaction（与主轮区分开）", () => {
	assert.equal(classifyLlmFailure({ aborted: false, text: "x", compacting: true }).stage, "compaction");
});

test("stage 默认值缺省时是 main_turn（不报unknown）", () => {
	assert.equal(classifyLlmFailure({ aborted: false, text: "x" }).stage, "main_turn");
});

test("classifyLlmFailure 的 aborted 恒为 true 时仍能判阶段（取消也要能落 stage）", () => {
	// ⚠️ 用真实会出现的文本：`entry.userAborted` 为真时，错误文本通常是 abort 类的
	//（若传空串会自然落 `internal`——那是「无法判定」的诚实兜底，不是 bug）。
	const r: ClassifiedLlmError = classifyLlmFailure({ aborted: true, text: "request aborted" });
	assert.equal(r.errorClass, "aborted");
	assert.equal(r.stage, "main_turn");
});

test("空文本（无法判定）→ internal，但阶段仍可判（不因缺文本丢 stage）", () => {
	const r = classifyLlmFailure({ aborted: true, text: "" });
	assert.equal(r.errorClass, "internal");
	assert.equal(r.stage, "main_turn");
});

test("错误原文不得出现在返回值的任何位置（防 label 基数爆炸）", () => {
	const secret = "sk-live-SECRET123";
	const r = classifyLlmFailure({ aborted: false, text: `upstream failed: ${secret}` });
	assert.equal(r.errorClass, "upstream_5xx");
	assert.equal(JSON.stringify(r).includes(secret), false, "分类结果泄漏了错误原文");
});

test("输入对象的 text 不会被分类函数修改（不改调用方状态）", () => {
	const input = { aborted: false, text: "HTTP 429 rate limit" };
	const before = input.text;
	classifyLlmFailure(input);
	assert.equal(input.text, before);
});
