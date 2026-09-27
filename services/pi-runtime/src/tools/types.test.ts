import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { toolSummary, type LnkpiTool, type LnkpiToolContext } from "./types.js";

function makeTool(extra: Partial<LnkpiTool> = {}): LnkpiTool {
	return {
		name: "t1",
		label: "T1",
		description: "d",
		parameters: Type.Object({}),
		tier: "read",
		execute: async () => ({ content: [{ type: "text", text: "x" }], details: undefined }),
		...extra,
	};
}

test("LnkpiTool 类型接受带 tier 的工具定义", () => {
	const ctx: LnkpiToolContext = { sessionId: "s1" };
	const tool: LnkpiTool = {
		name: "t1",
		label: "T1",
		description: "d",
		parameters: Type.Object({}),
		tier: "read",
		execute: async () => ({ content: [{ type: "text", text: "x" }], details: undefined }),
	};
	assert.equal(tool.tier, "read");
	assert.equal(ctx.sessionId, "s1");
});

test("LnkpiToolContext 接受画布上下文字段", () => {
	const ctx: LnkpiToolContext = {
		sessionId: "s",
		attachments: [{ url: "https://x/a.png", mediaType: "image" }],
		mentionedKeys: ["I1"],
		refOrder: ["I1"],
		focusNodeId: "node-1",
	};
	assert.equal(ctx.mentionedKeys?.[0], "I1");
	assert.equal(ctx.attachments?.[0]?.mediaType, "image");
});

test("LnkpiTool 接受渐进加载占位字段 summary / deferred", () => {
	const tool = makeTool({ summary: "一句话摘要", deferred: true });
	assert.equal(tool.summary, "一句话摘要");
	assert.equal(tool.deferred, true);
});

test("占位字段缺省时工具行为不变（summary/deferred 均 undefined）", () => {
	const tool = makeTool();
	assert.equal(tool.summary, undefined);
	assert.equal(tool.deferred, undefined);
	assert.equal(tool.tier, "read");
});

test("toolSummary 回退 description", () => {
	assert.equal(toolSummary(makeTool({ summary: "摘要" })), "摘要");
	assert.equal(toolSummary(makeTool()), "d");
});
