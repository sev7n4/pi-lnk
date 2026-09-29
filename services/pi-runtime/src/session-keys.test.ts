import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	composeSystemPrompt,
	isSameLlmIdentity,
	isTurnContextEqual,
	toSessionKey,
} from "./session-manager.js";

describe("toSessionKey", () => {
	it("确定性：同输入同输出", () => {
		assert.equal(toSessionKey("s1:t1"), toSessionKey("s1:t1"));
	});
	it("非法字符替换为 _，并追加原文哈希前 8 位", () => {
		assert.match(toSessionKey("s1:t1"), /^s1_t1-[0-9a-f]{8}$/);
	});
	it("无碰撞：仅非法字符不同的两键不相等", () => {
		assert.notEqual(toSessionKey("a:b"), toSessionKey("a_b"));
		assert.notEqual(toSessionKey("a:b"), toSessionKey("a/b"));
	});
	it("纯字母数字键保持可读（前缀即原文）", () => {
		assert.ok(toSessionKey("abc-123").startsWith("abc-123-"));
	});
	it("空串 / 纯空白拒绝", () => {
		assert.throws(() => toSessionKey(""), /non-empty/);
		assert.throws(() => toSessionKey("   "), /non-empty/);
	});
	it("两端空白被 trim 后再处理", () => {
		assert.equal(toSessionKey("  s1:t1  "), toSessionKey("s1:t1"));
	});
	it("非幂等：二次应用产生不同键（调用方只应转换一次）", () => {
		assert.notEqual(toSessionKey(toSessionKey("s1:t1")), toSessionKey("s1:t1"));
	});
});

describe("composeSystemPrompt", () => {
	it("静态段在前、动态段在后、空段过滤", () => {
		assert.equal(composeSystemPrompt("RULES", ["CANVAS", "SIDEBAR"]), "RULES\n\nCANVAS\n\nSIDEBAR");
	});
	it("无动态段原样返回静态段", () => {
		assert.equal(composeSystemPrompt("RULES", []), "RULES");
	});
	it("静态段为空时只返回动态段", () => {
		assert.equal(composeSystemPrompt("", ["CANVAS"]), "CANVAS");
	});
	it("空白动态块被过滤", () => {
		assert.equal(composeSystemPrompt("RULES", ["", "  ", "CANVAS"]), "RULES\n\nCANVAS");
	});
	it("稳定前缀必须排在动态内容之前", () => {
		const out = composeSystemPrompt("RULES", ["CANVAS"]);
		assert.ok(out.indexOf("RULES") < out.indexOf("CANVAS"));
	});
});

describe("isSameLlmIdentity", () => {
	it("同 provider 同 model 为 true", () => {
		assert.equal(
			isSameLlmIdentity({ provider: "agnes", model: "agnes-2.5-pro" }, { provider: "agnes", model: "agnes-2.5-pro" }),
			true,
		);
	});
	it("同 provider 不同 model 为 false", () => {
		assert.equal(isSameLlmIdentity({ provider: "agnes", model: "a" }, { provider: "agnes", model: "b" }), false);
	});
	it("BYOK 与平台渠道为 false（同 model 也 false）", () => {
		assert.equal(
			isSameLlmIdentity({ provider: "byok-abc123def456", model: "m" }, { provider: "agnes", model: "m" }),
			false,
		);
	});
	it("不同 BYOK 渠道（provider 哈希不同）为 false", () => {
		assert.equal(
			isSameLlmIdentity({ provider: "byok-aaaaaaaaaaaa", model: "m" }, { provider: "byok-bbbbbbbbbbbb", model: "m" }),
			false,
		);
	});
});

describe("isTurnContextEqual", () => {
	it("字段与数组元素全等为 true", () => {
		assert.equal(
			isTurnContextEqual({ dynamicBlocks: ["A"], mentionedKeys: ["I1"] }, { dynamicBlocks: ["A"], mentionedKeys: ["I1"] }),
			true,
		);
	});
	it("数组顺序不同为 false", () => {
		assert.equal(isTurnContextEqual({ mentionedKeys: ["I1", "I2"] }, { mentionedKeys: ["I2", "I1"] }), false);
	});
	it("undefined 与空数组等价", () => {
		assert.equal(isTurnContextEqual({ mentionedKeys: undefined }, { mentionedKeys: [] }), true);
		assert.equal(isTurnContextEqual({}, {}), true);
	});
	it("多出字段为 false", () => {
		assert.equal(isTurnContextEqual({ focusNodeId: "n1" }, {}), false);
	});
	it("attachments 逐字段比较", () => {
		assert.equal(
			isTurnContextEqual({ attachments: [{ url: "u", mediaType: "image" }] }, { attachments: [{ url: "u", mediaType: "image" }] }),
			true,
		);
		assert.equal(
			isTurnContextEqual({ attachments: [{ url: "u", mediaType: "image" }] }, { attachments: [{ url: "u", mediaType: "video" }] }),
			false,
		);
	});
});
