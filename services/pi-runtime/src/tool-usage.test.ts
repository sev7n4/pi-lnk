import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "./metrics.js";

describe("observeToolUsage（P3：after_tool 独有 usage 增量观测）", () => {
	it("四类 token 按 tool|kind 累计并渲染", () => {
		const m = new Metrics();
		m.observeToolUsage("render_canvas_view", { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
		m.observeToolUsage("render_canvas_view", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
		const text = m.render(0, "test");
		assert.match(text, /pi_runtime_tool_usage_tokens_total\{tool="render_canvas_view",kind="input"\} 101/);
		assert.match(text, /pi_runtime_tool_usage_tokens_total\{tool="render_canvas_view",kind="output"\} 50/);
		assert.match(text, /pi_runtime_tool_usage_tokens_total\{tool="render_canvas_view",kind="cache_read"\} 10/);
		assert.match(text, /pi_runtime_tool_usage_tokens_total\{tool="render_canvas_view",kind="cache_write"\} 5/);
	});

	it("非有限/负数丢弃（防御式，与 observeUsage 同口径）；脏样本不产生任何行", () => {
		const m = new Metrics();
		m.observeToolUsage("dirty", { input: Number.NaN, output: -5, cacheRead: undefined });
		const text = m.render(0, "test");
		assert.ok(!text.includes('pi_runtime_tool_usage_tokens_total{tool="dirty"'));
	});

	it("零流量只出 HELP/TYPE 不出数据行（与 usage_tokens 同口径）", () => {
		const m = new Metrics();
		const text = m.render(0, "test");
		assert.ok(text.includes("# HELP pi_runtime_tool_usage_tokens_total"));
		assert.ok(!text.includes('pi_runtime_tool_usage_tokens_total{tool='));
	});
});
