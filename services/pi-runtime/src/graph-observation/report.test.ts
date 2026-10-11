/**
 * 观测报告的契约测试。
 *
 * ⚠️ 最关键的一条是「数据源」：信号必须来自 **user 行**，不能来自
 * `executionEvents.text_delta`（那东西根本不落库）。用例 1 用**只带 text_delta
 * 的助手行**钉死这一点 —— 若有人把实现改回扫 text_delta，本文件必红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, type MessageRow } from "./report.js";

function turn(userText: string, events: Array<{ type: string; data?: unknown }>, assistantText = ""): MessageRow[] {
	return [
		{ role: "user", content: userText },
		{ role: "assistant", content: assistantText, metadata: { executionEvents: events } },
	];
}

test("触发率 = 画了 / 信号命中；信号来自用户问句", () => {
	const r = buildReport(
		turn("给我个示意图", [{ type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "timeline" } } }]),
	);
	assert.equal(r.signaled, 1);
	assert.equal(r.drew, 1);
	assert.equal(r.triggerRate, 1);
	assert.deepEqual(r.views, { timeline: 1 });
});

test("⛔ text_delta 不落库 ⇒ 不得靠它判信号（钉死数据源）", () => {
	const r = buildReport([
		{ role: "user", content: "今天天气不错" },
		{ role: "assistant", content: "", metadata: { executionEvents: [{ type: "text_delta", data: { text: "我来画个示意图" } }] } },
	]);
	// 用户问句没有图形化信号 ⇒ 不计入分母（助手行的 text_delta 不是数据源）
	assert.equal(r.signaled, 0);
});

test("助手正文命中严格词也算信号（模型自述是次要来源）", () => {
	const r = buildReport(turn("帮我看看", [], "我来画一个时间线说明顺序"));
	assert.equal(r.signaled, 1);
	assert.equal(r.drew, 0);
});

test("空输入不崩、不返回 NaN（分母为 0 ⇒ 0）", () => {
	const r = buildReport([]);
	assert.equal(r.triggerRate, 0);
	assert.equal(Number.isNaN(r.triggerRate), false);
	assert.equal(r.turns, 0);
});

test("legacy topology 归一到 layout，不双计", () => {
	const r = buildReport([
		...turn("画个关系图", [{ type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "topology" } } }]),
		...turn("再画个关系图", [
			{ type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "layout", relation: "dependency" } } },
		]),
	]);
	assert.equal(r.views.layout, 2);
	assert.equal(r.views.topology, undefined);
	assert.equal(r.legacy, 1);
});

test("参数使用率：无参数调用不计入任何桶（不编造）", () => {
	const r = buildReport(turn("画个图", [{ type: "tool_call", data: { toolName: "render_canvas_view", args: {} } }]));
	assert.deepEqual(r.paramUsage, {});
});

test("前置绕路：只记画图前的工具，画图后的不算", () => {
	const r = buildReport(
		turn("画个关系图", [
			{ type: "tool_call", data: { toolName: "web_search", args: {} } },
			{ type: "tool_call", data: { toolName: "render_canvas_view", args: {} } },
			{ type: "tool_call", data: { toolName: "get_canvas_summary", args: {} } },
		]),
	);
	assert.equal(r.detours.web_search, 1);
	assert.equal(r.detours.get_canvas_summary, undefined);
});

test("该画没画：样本被留下来供人工判因（L3）", () => {
	const r = buildReport(turn("帮我把这几个资产的关系梳理成图", []));
	assert.equal(r.signaled, 1);
	assert.equal(r.drew, 0);
	assert.equal(r.missedSamples.length, 1);
	assert.match(r.missedSamples[0], /梳理成图/);
});

test("孤立助手行不成轮（没有问句就不进分母）", () => {
	const r = buildReport([
		{ role: "assistant", content: "好的", metadata: { executionEvents: [{ type: "tool_call", data: { toolName: "render_canvas_view", args: {} } }] } },
	]);
	assert.equal(r.turns, 0);
	assert.equal(r.signaled, 0);
});

test("metadata 是 JSON 字符串（库里本来的形态）也能解析；坏 JSON 不崩", () => {
	const r = buildReport([
		{ role: "user", content: "画个示意图" },
		{
			role: "assistant",
			content: "",
			metadata: JSON.stringify({ executionEvents: [{ type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "matrix" } } }] }),
		},
		{ role: "user", content: "再画个示意图" },
		{ role: "assistant", content: "", metadata: "{not json" },
	]);
	assert.equal(r.signaled, 2);
	assert.equal(r.drew, 1);
	assert.deepEqual(r.views, { matrix: 1 });
});

test("信号来源分开计数：用户口径与含模型自述的口径不同（生产实测两者差 2 倍）", () => {
	// 用户没提图形化，但助手正文提到了「时间线」⇒ 只进 signaledAssistant
	const r = buildReport(turn("帮我做套详情页", [], "先梳理一下时间线"));
	assert.equal(r.signaledUser, 0);
	assert.equal(r.signaledAssistant, 1);
	assert.equal(r.signaled, 1);
	assert.equal(r.triggerRateUser, 0);

	// 用户明确要图并画了 ⇒ 只进用户口径，且用户口径触发率为 1
	const r2 = buildReport(
		turn("画个关系图", [{ type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "layout" } } }]),
	);
	assert.equal(r2.signaledUser, 1);
	assert.equal(r2.drewUser, 1);
	assert.equal(r2.triggerRateUser, 1);
});

test("未知 view 取值不进分布（不把模型自由文本当枚举）", () => {
	const r = buildReport(turn("画个图", [{ type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "沙丘" } } }]));
	assert.deepEqual(r.views, {});
});
