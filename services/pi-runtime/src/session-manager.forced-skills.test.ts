import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withForcedSkills } from "./session-manager.js";

describe("withForcedSkills（可观测性专项 ④）", () => {
	it("已知 skill：正文注入 + 显式调用前缀", () => {
		const out = withForcedSkills("帮我做白底图", ["ecommerce-product-photo"], (name) =>
			name === "ecommerce-product-photo" ? "# 电商商品图生成\n步骤…" : undefined,
		);
		assert.ok(out.includes("[用户显式调用 skill: ecommerce-product-photo]"));
		assert.ok(out.includes("# 电商商品图生成"));
		assert.ok(out.endsWith("用户请求：帮我做白底图"));
	});

	it("A5: 未知名 fail-soft：注入不存在提示，不抛错", () => {
		const out = withForcedSkills("做图", ["no-such-skill"], () => undefined);
		assert.ok(out.includes("no-such-skill"));
		assert.ok(out.includes("用户请求：做图"));
	});

	it("forceSkills 为空时原文返回", () => {
		assert.strictEqual(withForcedSkills("原文", undefined, () => "# body"), "原文");
		assert.strictEqual(withForcedSkills("原文", [], () => "# body"), "原文");
	});
});
