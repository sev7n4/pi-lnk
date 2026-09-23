import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

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
