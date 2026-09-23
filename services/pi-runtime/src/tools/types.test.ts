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
