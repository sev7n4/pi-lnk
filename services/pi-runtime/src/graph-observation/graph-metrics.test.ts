/**
 * GraphMetrics 契约测试（node:test —— pi-runtime 全仓用 `node --import tsx --test`，
 * 没有 vitest，见 `services/pi-runtime/package.json` 的 `test` 脚本）。
 *
 * 判据来源：spec §6 D1 / 计划 Review Focus #2 #4。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	GRAPH_SIGNAL_WORDS,
	GraphMetrics,
	isLegacyViewName,
	normalizeViewName,
} from "./graph-metrics.js";

function render(m: GraphMetrics): string {
	const lines: string[] = [];
	m.renderInto(lines);
	return lines.join("\n");
}

test("零调用轮次也要落一条（否则触发率的分母恒为 0）", () => {
	const m = new GraphMetrics();
	m.observeTrigger({ signaled: true, drew: false, source: "user" });
	const out = render(m);
	assert.match(out, /pi_runtime_graph_signal_total\{source="user"\} 1/);
	assert.match(out, /pi_runtime_graph_drew_total 0/);
});

test("未命中信号的轮次不进 signal 计数（否则触发率的分子被污染）", () => {
	const m = new GraphMetrics();
	m.observeTrigger({ signaled: false, drew: false });
	// ⚠️ 只断言**样本行**：`renderInto` 恒输出 # HELP / # TYPE 两行，
	// 用裸指标名匹配会把 HELP 行也算成「有数据」，断言就恒绿了。
	assert.doesNotMatch(render(m), /pi_runtime_graph_signal_total\{/);
});

test("view 分布按归一化后的名字统计，legacy 单独计数（不双计）", () => {
	const m = new GraphMetrics();
	m.observeView("layout", false);
	m.observeView("topology", true);
	const out = render(m);
	assert.match(out, /pi_runtime_graph_view_total\{view="layout"\} 2/);
	assert.match(out, /pi_runtime_graph_view_legacy_total 1/);
	assert.doesNotMatch(out, /view="topology"/);
});

test("未传 view 时不进 view 分布（不编造 unknown 桶）", () => {
	const m = new GraphMetrics();
	m.observeView("", false);
	assert.doesNotMatch(render(m), /pi_runtime_graph_view_total/);
});

test("信号词表非空且全部为短词", () => {
	assert.ok(GRAPH_SIGNAL_WORDS.length > 0);
	for (const w of GRAPH_SIGNAL_WORDS) assert.ok(w.length <= 6, `信号词过长：${w}`);
});

test("前置绕路按工具名分桶", () => {
	const m = new GraphMetrics();
	m.observeDetour("web_search");
	m.observeDetour("load_skill");
	m.observeDetour("web_search");
	assert.match(render(m), /pi_runtime_graph_detour_total\{tool="web_search"\} 2/);
});

test("legacy 判据：topology 是别名，table 不是（它是独立旧场景）", () => {
	assert.equal(isLegacyViewName("topology"), true);
	assert.equal(isLegacyViewName("table"), false);
	assert.equal(normalizeViewName("topology"), "layout");
	assert.equal(normalizeViewName("table"), "table");
});

test("参数使用率按参数名分桶，空名不入桶", () => {
	const m = new GraphMetrics();
	m.observeParam("view");
	m.observeParam("view");
	m.observeParam("");
	const out = render(m);
	assert.match(out, /pi_runtime_graph_param_total\{param="view"\} 2/);
	assert.doesNotMatch(out, /param=""/);
});
