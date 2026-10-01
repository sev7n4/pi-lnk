import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approxTokens } from "./registry.js";

/** 审计 P0-②：len/4 对中文低估 3~4 倍，CJK 字符按 ≈1 token/字计。 */
describe("approxTokens（CJK-aware）", () => {
	it("CJK 每字约 1 token（旧口径低估 3 倍）", () => {
		assert.equal(approxTokens("四个中文字符"), 6);
	});
	it("纯 ASCII 维持 1/4 口径", () => {
		assert.equal(approxTokens("abcdefgh"), 2);
	});
	it("混合文本（4 CJK + 8 ASCII → 4 + 2）", () => {
		assert.equal(approxTokens("两个汉字abcdefgh"), 6);
	});
	it("CJK 标点/全角也按 1 计", () => {
		// 3 个全角标点 → 3
		assert.equal(approxTokens("，。！"), 3);
	});
	it("空串为 0", () => {
		assert.equal(approxTokens(""), 0);
	});
});
