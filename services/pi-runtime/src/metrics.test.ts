import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "./metrics.js";

test("tool_calls_total 按 tool|result 聚合并渲染", () => {
	const m = new Metrics();
	m.observeToolCall("get_node", "ok");
	m.observeToolCall("get_node", "ok");
	m.observeToolCall("get_node", "error");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="ok"\} 2/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="error"\} 1/);
	assert.doesNotMatch(out, /result="circuit_open"/);
});

test("renders pi_runtime_skills_loaded gauge", () => {
	const m = new Metrics();
	m.setSkillsLoaded(2);
	assert.ok(m.render(0, "test").includes("pi_runtime_skills_loaded 2"));
});

test("renders pi_runtime_prompt_skills_tokens gauge（follow-up-1）", () => {
	const m = new Metrics();
	m.setSkillsPromptTokens(226);
	const out = m.render(0, "test");
	assert.ok(out.includes("pi_runtime_prompt_skills_tokens 226"));
	assert.ok(out.indexOf("pi_runtime_prompt_skills_tokens") > out.indexOf("pi_runtime_skills_loaded"));
});

test("③ 错误分类：带 kind 的 error 单独行渲染，无 kind 的保持原标签", () => {
	const m = new Metrics();
	m.observeToolCall("run_video_generation", "error", "gate_blocked");
	m.observeToolCall("get_node", "error", "upstream_4xx");
	m.observeToolCall("get_node", "error");
	m.observeToolCall("get_node", "ok");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="run_video_generation",result="error",kind="gate_blocked"\} 1/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="error",kind="upstream_4xx"\} 1/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="error"\} 1/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="ok"\} 1/);
});

test("③ retry：ok 结果带 kind 单独一行渲染（V-γ 重试打点）", () => {
	const m = new Metrics();
	m.observeToolCall("run_image_generation", "ok", "retry");
	m.observeToolCall("run_image_generation", "ok");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="run_image_generation",result="ok",kind="retry"\} 1/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="run_image_generation",result="ok"\} 1/);
});

test("③ tool_result_bytes：按桶聚合并渲染 sum/count", () => {
	const m = new Metrics();
	m.observeToolResult("get_canvas_summary", 100); // ≤256
	m.observeToolResult("get_canvas_summary", 2048); // ≤4096
	m.observeToolResult("get_canvas_summary", 2_000_000); // +Inf
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_result_bytes_bucket\{tool="get_canvas_summary",le="256"\} 1/);
	assert.match(out, /pi_runtime_tool_result_bytes_bucket\{tool="get_canvas_summary",le="4096"\} 2/);
	assert.match(out, /pi_runtime_tool_result_bytes_bucket\{tool="get_canvas_summary",le="\+Inf"\} 3/);
	assert.match(out, /pi_runtime_tool_result_bytes_count\{tool="get_canvas_summary"\} 3/);
	assert.match(out, /pi_runtime_tool_result_bytes_sum\{tool="get_canvas_summary"\} 2002148/);
});
