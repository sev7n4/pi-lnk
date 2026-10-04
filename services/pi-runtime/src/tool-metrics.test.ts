import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolMetrics } from "./tool-metrics.js";

const base = {
	toolName: "add_node",
	channel: "agnes",
	model: "agnes-2.5-flash",
	resultText: "ok",
};

function collect(tm: ToolMetrics): string {
	const lines: string[] = [];
	tm.renderInto(lines);
	return lines.join("\n");
}

test("start + end 正常配对：计数 1、result=ok、记录耗时", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "c1" });
	tm.observeEnd({ ...base, toolCallId: "c1", isError: false, terminate: false });
	const out = collect(tm);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.match(out, /pi_runtime_tool_duration_seconds_count\{tool="add_node"\} 1/);
	assert.equal(tm.stats().settled, 1);
});

test("孤儿 end（无 start）：只计数、不产生时长、且不抛错", () => {
	const tm = new ToolMetrics();
	assert.doesNotThrow(() => tm.observeEnd({ ...base, toolCallId: "orphan", isError: false, terminate: false }));
	const out = collect(tm);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.equal(out.includes("tool_duration_seconds_count"), false, "孤儿事件污染了时长直方图");
	assert.equal(tm.stats().orphaned, 1);
});

test("同一 toolCallId 重复 end：幂等，不二次计数（断线重放场景）", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "dup" });
	tm.observeEnd({ ...base, toolCallId: "dup", isError: false, terminate: false });
	tm.observeEnd({ ...base, toolCallId: "dup", isError: false, terminate: false });
	assert.match(collect(tm), /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.equal(tm.stats().duplicates, 1);
});

test("error 时附error_class label", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "e1" });
	tm.observeEnd({ ...base, toolCallId: "e1", isError: true, terminate: false, resultText: "HTTP 429 rate limit" });
	assert.match(collect(tm), /result="error",error_class="upstream_4xx"\} 1/);
});

test("terminate 归 blocked 而非 error", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "b1" });
	tm.observeEnd({ ...base, toolCallId: "b1", isError: false, terminate: true });
	assert.match(collect(tm), /result="blocked",error_class="blocked_terminate"\} 1/);
});

test("LLM 指标带 channel 与 model 标签", () => {
	const tm = new ToolMetrics();
	tm.observeLlmError({ stage: "main_turn", errorClass: "upstream_5xx", channel: "byok-abc123def456", model: "gpt-4o" });
	const out = collect(tm);
	assert.match(out, /pi_runtime_llm_errors_total\{stage="main_turn",error_class="upstream_5xx",channel="byok-abc123def456",model="gpt-4o"\} 1/);
});

test("渲染含 HELP 与 TYPE 行", () => {
	const out = collect(new ToolMetrics());
	assert.match(out, /# HELP pi_runtime_tool_calls_total/);
	assert.match(out, /# TYPE pi_runtime_tool_calls_total counter/);
	assert.match(out, /# TYPE pi_runtime_tool_duration_seconds histogram/);
});

test("错误原文不出现在任何渲染行中", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "s1" });
	tm.observeEnd({ ...base, toolCallId: "s1", isError: true, terminate: false, resultText: "sk-live-SECRET123 invalid" });
	assert.equal(collect(tm).includes("sk-live-SECRET123"), false);
});
