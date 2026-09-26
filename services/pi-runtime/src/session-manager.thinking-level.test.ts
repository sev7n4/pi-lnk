import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveThinkingLevel, DEFAULT_THINKING_LEVEL } from "./session-manager.js";

describe("resolveThinkingLevel（P1 thinking 透传）", () => {
	it("合法档位透传；非法值与缺省回落 DEFAULT_THINKING_LEVEL", () => {
		assert.equal(resolveThinkingLevel("off"), "off");
		assert.equal(resolveThinkingLevel("high"), "high");
		assert.equal(resolveThinkingLevel("bogus" as never), DEFAULT_THINKING_LEVEL);
		assert.equal(resolveThinkingLevel(undefined), DEFAULT_THINKING_LEVEL);
	});
});
