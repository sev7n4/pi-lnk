/**
 * TurnObserver 契约测试（node:test）。
 *
 * 判据来源：spec §6 D1-1（补触发盲区）、计划 Review Focus #2。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPH_SIGNAL_WORDS, GraphMetrics } from "./graph-metrics.js";
import { TurnObserver, containsSignal } from "./turn-observer.js";

function render(m: GraphMetrics): string {
	const lines: string[] = [];
	m.renderInto(lines);
	return lines.join("\n");
}

test("containsSignal：命中「示意图」", () => {
	assert.equal(containsSignal("帮我画个示意图", ["图", "示意图"]), true);
});

test("🔴 生图类请求不得算「要画关系图」（生产实测的最大假阳性）", () => {
	// 2026-10-08 生产基线：宽松词表命中的 749 条里 38% 是这类「生成图片」诉求，
	// 它们把触发率的分母撑大 20 倍。裸「图」在本产品线是**反信号**。
	for (const q of [
		"帮我生成一张产品抠图透明底 PNG",
		"帮我生成一张换装图，只换衣服保留脸",
		"确认出图",
		"请按上一份方案拆解画布并自动出图",
	]) {
		assert.equal(containsSignal(q, GRAPH_SIGNAL_WORDS), false, `误判为图形化请求：${q}`);
	}
});

test("图形化表达专属问句仍要命中", () => {
	for (const q of ["给我个示意图", "画个关系图", "梳理成图看看层级", "这 12 镜的时间线"]) {
		assert.equal(containsSignal(q, GRAPH_SIGNAL_WORDS), true, `漏判：${q}`);
	}
});

test("signal 命中（用户问句）但没调工具 ⇒ 落一条未触发（Review Focus #2）", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "user_text", text: "给我个示意图" });
	o.feed({ kind: "turn_end" });
	const out = render(m);
	assert.match(out, /pi_runtime_graph_signal_total\{source="user"\} 1/);
	assert.match(out, /pi_runtime_graph_drew_total 0/);
});

test("调了画图工具 ⇒ 记 drew", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "user_text", text: "给我个示意图" });
	o.feed({ kind: "tool", toolName: "render_canvas_view", paramNames: ["view", "relation"], view: "timeline" });
	o.feed({ kind: "turn_end" });
	const out = render(m);
	assert.match(out, /pi_runtime_graph_drew_total 1/);
	assert.match(out, /pi_runtime_graph_view_total\{view="timeline"\} 1/);
	assert.match(out, /pi_runtime_graph_param_total\{param="view"\} 1/);
	assert.match(out, /pi_runtime_graph_param_total\{param="relation"\} 1/);
});

test("画图前调了别的工具 ⇒ 记 detour（token 浪费定位）", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "user_text", text: "画个关系图" });
	o.feed({ kind: "tool", toolName: "web_search" });
	o.feed({ kind: "tool", toolName: "render_canvas_view" });
	o.feed({ kind: "turn_end" });
	assert.match(render(m), /pi_runtime_graph_detour_total\{tool="web_search"\} 1/);
});

test("绕路只在真的画了时才记（没画图不存在「绕路到画图」）", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "tool", toolName: "web_search" });
	o.feed({ kind: "turn_end" });
	assert.doesNotMatch(render(m), /pi_runtime_graph_detour_total\{/);
});

test("turn_end 后状态清空，下一轮不串味", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "user_text", text: "示意图" });
	o.feed({ kind: "turn_end" });
	o.feed({ kind: "turn_end" });
	const out = render(m);
	assert.match(out, /pi_runtime_graph_signal_total\{source="user"\} 1/);
	assert.match(out, /pi_runtime_graph_drew_total 0/);
});

test("⛔ view 取值不在已知枚举内 ⇒ 不进 label（防模型自由文本写进监控面）", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "tool", toolName: "render_canvas_view", view: "随便写点什么" });
	o.feed({ kind: "turn_end" });
	assert.doesNotMatch(render(m), /pi_runtime_graph_view_total\{/);
});

test("legacy topology 归一到 layout（不双计）", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "tool", toolName: "render_canvas_view", view: "topology" });
	o.feed({ kind: "tool", toolName: "render_canvas_view", view: "layout" });
	o.feed({ kind: "turn_end" });
	const out = render(m);
	assert.match(out, /pi_runtime_graph_view_total\{view="layout"\} 2/);
	assert.match(out, /pi_runtime_graph_view_legacy_total 1/);
});

test("模型自述的词表不含裸「图」（否则「图片」会污染分母）", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "text", text: "我先看看这张图片" });
	o.feed({ kind: "turn_end" });
	assert.doesNotMatch(render(m), /pi_runtime_graph_signal_total\{/);
});

test("模型自述命中严格词 ⇒ 记 assistant 来源", () => {
	const m = new GraphMetrics();
	const o = new TurnObserver(m);
	o.feed({ kind: "text", text: "我来画一个时间线说明顺序" });
	o.feed({ kind: "turn_end" });
	assert.match(render(m), /pi_runtime_graph_signal_total\{source="assistant"\} 1/);
});
