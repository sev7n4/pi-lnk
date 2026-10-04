import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolOutcome, type ToolErrorClass } from "./tool-error-class.js";

test("terminate 优先于 isError，归blocked_terminate", () => {
	assert.deepEqual(classifyToolOutcome({ isError: true, terminate: true, resultText: "429 rate limit" }), {
		outcome: "blocked",
		errorClass: "blocked_terminate",
	});
});

test("正常结束：ok 且无 error_class（label 不出现）", () => {
	assert.deepEqual(classifyToolOutcome({ isError: false, terminate: false, resultText: "ok" }), {
		outcome: "ok",
		errorClass: null,
	});
});

test("isError + terminate 均为 false 时不得判为 blocked", () => {
	const r = classifyToolOutcome({ isError: false, terminate: false, resultText: "partial" });
	assert.equal(r.outcome, "ok");
	assert.equal(r.errorClass, null);
});

const CASES: Array<[string, ToolErrorClass]> = [
	["request aborted by user", "aborted"],
	["已取消", "aborted"],
	["HTTP 429 rate limit exceeded", "upstream_4xx"],
	["upstream returned 503 service unavailable", "upstream_5xx"],
	["ECONNRESET", "network"],
	["fetch failed", "network"],
	["ETIMEDOUT timeout after 30s", "timeout"],
	["等待用户回答超时", "timeout"],
	["blocked by HITL gate", "gate_blocked"],
	["未授权，禁止访问", "gate_blocked"],
	["invalid arguments: expected number", "validation"],
	["参数校验失败", "validation"],
];

for (const [text, expected] of CASES) {
	test(`分类：${JSON.stringify(text)} → ${expected}`, () => {
		assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass, expected);
	});
}

test("无法判定 → internal（绝不静默丢弃）", () => {
	assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: "zzz 玄学失败" }).errorClass, "internal");
});

test("空resultText 且 isError → internal", () => {
	assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: "" }).errorClass, "internal");
});

test("错误原文不得出现在返回值任何位置", () => {
	const secret = "sk-live-abcdef123456";
	const r = classifyToolOutcome({ isError: true, terminate: false, resultText: `invalid token ${secret}` });
	assert.equal(r.errorClass, "validation");
	assert.equal(JSON.stringify(r).includes(secret), false, "分类结果泄漏了错误原文");
});

test("分类优先级：429 优先于 timeout（先命中先定）", () => {
	assert.equal(
		classifyToolOutcome({ isError: true, terminate: false, resultText: "timeout waiting, then 429" }).errorClass,
		"upstream_4xx",
	);
});
