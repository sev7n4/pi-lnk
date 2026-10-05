import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyLlmErrorText, classifyToolOutcome, type ToolErrorClass } from "./tool-error-class.js";

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
		const r = classifyToolOutcome({ isError: true, terminate: false, resultText: text });
		assert.equal(r.errorClass, expected);
		assert.equal(r.outcome, "error", "error 分支的 outcome 必须是 error");
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

test("分类优先级：aborted 优先于 4xx/5xx（brief 核心要求）", () => {
	assert.equal(
		classifyToolOutcome({ isError: true, terminate: false, resultText: "request aborted: 429 rate limit" }).errorClass,
		"aborted",
	);
	assert.equal(
		classifyToolOutcome({ isError: true, terminate: false, resultText: "aborted, upstream 503 unavailable" }).errorClass,
		"aborted",
	);
});

test("internal 兜底不得泄漏错误原文", () => {
	const secret = "sk-live-abcdef123456";
	const r = classifyToolOutcome({ isError: true, terminate: false, resultText: `玄学失败 ${secret}` });
	assert.equal(r.errorClass, "internal");
	assert.equal(JSON.stringify(r).includes(secret), false, "internal 兜底泄漏了错误原文");
});

// 回归：gate 关键词必须带词边界，否则内含 "gate" 子串的常用英文词会被误判。
test("gate 误判回归：内含 gate 子串的普通词不得判为 gate_blocked", () => {
	for (const text of [
		"investigate the canvas",
		"aggregate the results",
		"mitigate the risk",
		"navigate to node 3",
		"delegated to subagent",
	]) {
		assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass, "internal", text);
	}
	// 反向：真正的 gate 信号仍须命中。
	assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: "blocked by HITL gate" }).errorClass, "gate_blocked");
});

/**
 * `classifyLlmErrorText`：LLM 侧错误文本分类。
 *
 * 核心断言是**与 `classifyToolOutcome` 逐字同构**——这是本函数存在的全部理由
 * （两处正则各自演化会让同一错误在 tool_calls_total 与 llm_errors_total 里落不同类）。
 * 故断言写成「对同一文本，两个入口必须给出同一个 errorClass」，而不是把期望值抄一遍：
 * 抄一遍的话，将来有人只改其中一个函数，本测试仍会全绿（假绿）。
 */
const LLM_CASES: Array<[string, ToolErrorClass]> = [
	["HTTP 429 Too Many Requests", "upstream_4xx"],
	["rate limit exceeded, please retry", "upstream_4xx"],
	["upstream returned 503 service unavailable", "upstream_5xx"],
	["bad gateway", "upstream_5xx"],
	["ETIMEDOUT", "timeout"],
	["请求超时", "timeout"],
	["fetch failed", "network"],
	["ECONNREFUSED 127.0.0.1:443", "network"],
	["request aborted", "aborted"],
	["unauthorized: invalid api key", "gate_blocked"],
	["invalid arguments: expected string", "validation"],
	["玄学失败", "internal"],
	["", "internal"],
];

for (const [text, expected] of LLM_CASES) {
	test(`classifyLlmErrorText：${JSON.stringify(text)} → ${expected}`, () => {
		assert.equal(classifyLlmErrorText(text), expected);
		// 同构锁：与工具侧分类器对同一文本必须一致。
		assert.equal(
			classifyLlmErrorText(text),
			classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass,
			"LLM 侧与工具侧分类结论漂移了",
		);
	});
}

test("classifyLlmErrorText 恒返回闭集值，永不返回 null", () => {
	for (const [text] of LLM_CASES) {
		assert.notEqual(classifyLlmErrorText(text), null);
		assert.notEqual(classifyLlmErrorText(text), undefined);
	}
});

test("classifyLlmErrorText 不得返回错误原文（label 基数红线）", () => {
	const secret = "sk-live-abcdef123456";
	assert.equal(classifyLlmErrorText(`玄学失败 ${secret}`), "internal");
	assert.equal(classifyLlmErrorText(`invalid token ${secret}`), "validation");
});


// ============================================================================
// 🔴 生产取证驱动的回归（2026-10-05）
//
// 生产实测：`get_canvas_layout` 15/19、`get_canvas_summary` 15/17、
// `list_generation_tasks` 5、`render_canvas_view` 6 次错误**全部落 `internal`**。
// 逐环核实根因：`tools/nest-client.ts:117` 抛的是
// `nest ${path} http ${res.status}: ${message}`，而原正则只认 `429`，
// 于是 404/400 这类最常见的 4xx 一个都匹配不上。
//
// 后果不是「分类不准」而是**告警失真**：spec §7.2 的规则 2（上游 5xx 占比）
// 与规则 4（工具错误率）都建立在这个分类上。
// ============================================================================

/** 生产真实错误文本（逐字取自 `nest-client.ts:117` 的抛错格式）。 */
const NEST_ERRORS: Array<[string, string]> = [
	["nest /agent/internal/get-canvas-layout http 404: Not Found", "upstream_4xx"],
	["nest /agent/internal/get-canvas-summary http 400: Bad Request", "upstream_4xx"],
	["nest /agent/internal/render-canvas-view http 404: Not Found", "upstream_4xx"],
	["nest /agent/internal/get-node http 401: Unauthorized", "gate_blocked"],
	["nest /agent/internal/get-node http 403: Forbidden", "gate_blocked"],
	["nest /agent/internal/list-generation-tasks http 500: Internal Server Error", "upstream_5xx"],
	["nest /agent/internal/list-generation-tasks http 502: Bad Gateway", "upstream_5xx"],
	["nest /agent/internal/get-node http 429: Too Many Requests", "upstream_4xx"],
];

for (const [text, expected] of NEST_ERRORS) {
	test(`Nest 客户端错误：${text.slice(0, 58)} → ${expected}`, () => {
		assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass, expected);
	});
}

test("通用 4xx：任意 4xx 状态码都归 upstream_4xx（不只 429）", () => {
	for (const code of [400, 401, 402, 404, 405, 409, 418, 422, 429, 430, 499]) {
		const text = `nest /agent/internal/x http ${code}: Something`;
		const got = classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass;
		// 401/403 语义上属「未授权」⇒ gate_blocked 优先，其余归 4xx
		const want = code === 401 || code === 403 ? "gate_blocked" : "upstream_4xx";
		assert.equal(got, want, `http ${code} 分类错误`);
	}
});

test("401/403 优先归 gate_blocked（授权语义比状态码更具体）", () => {
	for (const code of [401, 403]) {
		const text = `nest /agent/internal/x http ${code}: Unauthorized`;
		assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass, "gate_blocked");
	}
});

test("5xx 仍然归 upstream_5xx（不能被新增的通用 4xx 规则抢走）", () => {
	for (const code of [500, 502, 503, 504]) {
		const text = `nest /agent/internal/x http ${code}: Server Error`;
		assert.equal(
			classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass,
			"upstream_5xx",
			`http ${code} 被误分类`,
		);
	}
});

test("非 HTTP 状态码文本不受影响（回归：原先的关键词判定不能被破坏）", () => {
	const kept: Array<[string, string]> = [
		["request aborted", "aborted"],
		["ETIMEDOUT after 30s", "timeout"],
		["ECONNRESET", "network"],
		["invalid arguments", "validation"],
		["玄学失败", "internal"],
	];
	for (const [text, expected] of kept) {
		assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass, expected);
	}
});
