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
