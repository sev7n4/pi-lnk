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

test("usage tokens/cost 按 kind 累计并渲染（审计 P0-③）", () => {
	const m = new Metrics();
	const usage = {
		input: 100,
		output: 50,
		cacheRead: 10,
		cacheWrite: 5,
		totalTokens: 165,
		cost: { input: 0.25, output: 0.5, cacheRead: 0.01, cacheWrite: 0.02 },
	};
	m.observeUsage(usage);
	m.observeUsage(usage);
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_usage_tokens_total\{kind="input"\} 200/);
	assert.match(out, /pi_runtime_usage_tokens_total\{kind="output"\} 100/);
	assert.match(out, /pi_runtime_usage_tokens_total\{kind="cache_read"\} 20/);
	assert.match(out, /pi_runtime_usage_tokens_total\{kind="cache_write"\} 10/);
	assert.match(out, /pi_runtime_usage_cost_total\{kind="input"\} 0\.5/);
	assert.match(out, /pi_runtime_usage_cost_total\{kind="output"\} 1/);
});

test("cost 全 0（未配费率）时指标存在且为 0，不缺行不报错", () => {
	const m = new Metrics();
	m.observeUsage({
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_usage_cost_total\{kind="input"\} 0/);
});

test("tool_search：hit/miss/empty 分组计数 + 激活数累计（官方模式观测）", () => {
	const m = new Metrics();
	m.observeToolSearch("hit", 2);
	m.observeToolSearch("hit", 1);
	m.observeToolSearch("miss", 0);
	m.observeToolSearch("empty", 0);
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_search_calls_total\{outcome="hit"\} 2/);
	assert.match(out, /pi_runtime_tool_search_calls_total\{outcome="miss"\} 1/);
	assert.match(out, /pi_runtime_tool_search_calls_total\{outcome="empty"\} 1/);
	assert.match(out, /pi_runtime_tool_search_activated_total 3/);
});

test("tool_search 未打点时不缺行报错：activated_total 恒渲染为 0", () => {
	const m = new Metrics();
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_search_activated_total 0/);
	assert.doesNotMatch(out, /pi_runtime_tool_search_calls_total\{/);
});

test("transform_context：复述分组计数 + 标注条数累计（审计 #8 观测）", () => {
	const m = new Metrics();
	m.observeTransformContext(true, 2);
	m.observeTransformContext(true, 0);
	m.observeTransformContext(false, 1);
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_transform_context_runs_total\{goal="on"\} 2/);
	assert.match(out, /pi_runtime_transform_context_runs_total\{goal="off"\} 1/);
	assert.match(out, /pi_runtime_transform_context_annotated_total 3/);
});

test("transform_context 未打点时不缺行报错", () => {
	const m = new Metrics();
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_transform_context_annotated_total 0/);
	assert.doesNotMatch(out, /pi_runtime_transform_context_runs_total\{/);
});

test("dynamic_budget drops 按 kind 计数渲染", () => {
	const m = new Metrics();
	m.observeDynamicBudgetDrop("canvas");
	m.observeDynamicBudgetDrop("canvas");
	m.observeDynamicBudgetDrop("vision");
	m.observeUnknownBlockKind();
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_dynamic_budget_drops_total\{kind="canvas"\} 2/);
	assert.match(out, /pi_runtime_dynamic_budget_drops_total\{kind="vision"\} 1/);
	assert.match(out, /pi_runtime_dynamic_budget_unknown_kind_total 1/);
});

test("system_prompt_bytes gauge：未打点渲染 0，打点后取最新值", () => {
	const m = new Metrics();
	assert.match(m.render(0, "test"), /pi_runtime_system_prompt_bytes 0/);
	m.observeSystemPromptBytes(1234);
	m.observeSystemPromptBytes(5678);
	assert.match(m.render(0, "test"), /pi_runtime_system_prompt_bytes 5678/);
});
