import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "./metrics.js";
import { ToolMetrics } from "./tool-metrics.js";

test("tool_calls_total 按 tool|result 聚合并渲染", () => {
	// 2026-10-04：计数改由事件层结算（ToolMetrics），本用例改为经公开 API 投喂事件。
	const m = new Metrics();
	const tm = m.toolMetrics();
	const feed = (id: string, tool: string, isError: boolean, resultText = "ok") => {
		tm.observeStart({ toolCallId: id });
		tm.observeEnd({
			toolName: tool, toolCallId: id, isError, terminate: false, resultText,
			channel: "agnes", model: "agnes-2.5-flash",
		});
	};
	feed("c1", "get_node", false);
	feed("c2", "get_node", false);
	feed("c3", "get_node", true, "boom");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="ok"\} 2/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="error",error_class="internal"\} 1/);
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

test("renders C3 plan-gate counters（propose/decision/blocked）", () => {
	const m = new Metrics();
	m.observePlanProposed();
	m.observePlanProposed();
	m.observePlanDecision("execute");
	m.observePlanDecision("timeout");
	m.observePlanGateBlocked("upsert_media_node");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_plan_proposed_total 2/);
	assert.match(out, /pi_runtime_plan_decisions_total\{decision="execute"\} 1/);
	assert.match(out, /pi_runtime_plan_decisions_total\{decision="timeout"\} 1/);
	assert.match(out, /pi_runtime_plan_gate_blocked_total\{tool="upsert_media_node"\} 1/);
});

test("③ 错误分类：Nest 结构化 errorKind 走 tool_error_kinds 通道（精确，不靠正则猜）", () => {
	// 2026-10-04：原用例断言 tool_calls_total{kind="gate_blocked"/"upstream_4xx"}，
	// 该渲染方已删。归因改由 observeToolErrorKind 通道承担——它拿的是 NestClient
	// 直接从 HTTP 状态码/包络判定的结构化分类，比事件层拿 resultText 正则猜精确。
	const m = new Metrics();
	m.observeToolErrorKind("run_video_generation", "gate_blocked");
	m.observeToolErrorKind("get_node", "upstream_4xx");
	m.observeToolErrorKind("get_node", "upstream_4xx");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_error_kinds_total\{tool="run_video_generation",kind="gate_blocked"\} 1/);
	assert.match(out, /pi_runtime_tool_error_kinds_total\{tool="get_node",kind="upstream_4xx"\} 2/);
});

test("tool_error_kinds 未打点时不渲染数据行（与「调用过但 0」可区分）", () => {
	const m = new Metrics();
	assert.equal(/^pi_runtime_tool_error_kinds_total\{/m.test(m.render(0, "test")), false);
});

test("tool_calls_total 用 error_class 标签（不再用 kind）", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "x1" });
	tm.observeEnd({
		toolName: "get_node",
		toolCallId: "x1",
		isError: true,
		terminate: false,
		resultText: "HTTP 429 rate limit",
		channel: "agnes",
		model: "agnes-2.5-flash",
	});
	const lines: string[] = [];
	tm.renderInto(lines);
	const out = lines.join("\n");
	assert.match(out, /result="error",error_class="upstream_4xx"/);
	assert.equal(out.includes('kind="'), false, "旧 kind 标签残留");
});

test("改名未误伤无关指标族的 kind 标签", () => {
	const m = new Metrics();
	m.observeDynamicBudgetDrop("canvas");
	m.observeDynamicBudgetDrop("canvas");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_dynamic_budget_drops_total\{kind="canvas"\} 2/);
	assert.equal(out.includes("dynamic_budget_drops_total{error_class="), false);
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

test("load_skill：按技能名 + 结局分组计数（Round2 W2② · P1-6 skill 路由判据）", () => {
	const m = new Metrics();
	m.observeSkillLoad("drama-character-design", "ok");
	m.observeSkillLoad("drama-character-design", "ok");
	m.observeSkillLoad("ecommerce-scene", "ok");
	m.observeSkillLoad("no-such-skill", "unknown");
	m.observeSkillLoad("broken-skill", "read_error");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_skill_loads_total\{skill="drama-character-design",outcome="ok"\} 2/);
	assert.match(out, /pi_runtime_skill_loads_total\{skill="ecommerce-scene",outcome="ok"\} 1/);
	assert.match(out, /pi_runtime_skill_loads_total\{skill="no-such-skill",outcome="unknown"\} 1/);
	assert.match(out, /pi_runtime_skill_loads_total\{skill="broken-skill",outcome="read_error"\} 1/);
});

test("skill_loads 未打点时不渲染任何数据行（与「调用过但计数为 0」可区分）", () => {
	const m = new Metrics();
	const out = m.render(0, "test");
	assert.doesNotMatch(out, /pi_runtime_skill_loads_total\{/);
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

test("direct_images：sent 计数 + tokens 估算累计（gauge 缺省 0）", () => {
	const m = new Metrics();
	assert.doesNotMatch(m.render(0, "test"), /pi_runtime_direct_images_total\{outcome/); // 对齐既有 Map-counter 模式：未打点不渲染行
	m.observeDirectImage("sent", 1130);
	m.observeDirectImage("sent", 565);
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_direct_images_total\{outcome="sent"\} 2/);
	assert.match(out, /pi_runtime_direct_image_tokens_estimated 1695/);
});

test("before_payload trims 按 reason 计数渲染", () => {
	const m = new Metrics();
	m.observeBeforePayloadTrim("history_image");
	m.observeBeforePayloadTrim("history_image");
	m.observeBeforePayloadTrim("text_overflow");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_before_payload_trims_total\{reason="history_image"\} 2/);
	assert.match(out, /pi_runtime_before_payload_trims_total\{reason="text_overflow"\} 1/);
});

test("统一上限：tool_result_trims 按工具名计数，未打点则不渲染（区分「从未超预算」与「超了但 0」）", () => {
	const m = new Metrics();
	const clean = m.render(0, "test");
	assert.ok(!/pi_runtime_tool_result_trims_total\{/.test(clean), "未打点时不应出现数据行");

	m.observeToolResultTrim("get_canvas_summary");
	m.observeToolResultTrim("get_canvas_summary");
	m.observeToolResultTrim("web_fetch");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_result_trims_total\{tool="get_canvas_summary"\} 2/);
	assert.match(out, /pi_runtime_tool_result_trims_total\{tool="web_fetch"\} 1/);
});

test("render 追加工具指标族，且既有指标输出不变", () => {
	const m = new Metrics();
	m.setSkillsLoaded(3);
	const out = m.render(0, "test");
	// 新增族
	assert.match(out, /# TYPE pi_runtime_tool_duration_seconds histogram/);
	// 既有族仍在（签名 render(activeSessions, version) 未变）
	assert.match(out, /# TYPE pi_runtime_skills_loaded gauge/);
	assert.match(out, /pi_runtime_skills_loaded 3/);
});

test("tool_calls_total 全局只渲染一次（新旧渲染方不共存）", () => {
	const m = new Metrics();
	m.toolMetrics().observeStart({ toolCallId: "d1" });
	m.toolMetrics().observeEnd({
		toolName: "save_memory", toolCallId: "d1", isError: false, terminate: false,
		resultText: "ok", channel: "agnes", model: "agnes-2.5-flash",
	});
	const out = m.render(0, "test");
	assert.equal(out.split("\n").filter((l) => l.startsWith("# HELP pi_runtime_tool_calls_total")).length, 1,
		"HELP 行出现多次 ⇒ Prometheus 会丢弃该指标");
	assert.equal(out.includes('kind="'), false, "旧 kind 标签仍在渲染");
});
