/**
 * K-1：create body 的 llm 字段白名单校验（spec §3.2 / §4）
 *
 * 设计立场：畸形 llm **拒绝（400）而非静默兜底** —— 宁可本轮失败，也不能
 * "以为用了 BYOK 实际走平台 key"（错账）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLlmOverride } from "./llm-override.js";

const VALID = {
	model: "deepseek-flash",
	apiKey: "sk-abc",
	baseUrl: "https://api.deepseek.com/",
	providerRef: "ch_1::deepseek-flash",
	source: "user",
};

describe("parseLlmOverride", () => {
	it("缺字段 / null → absent（走 env 装配，兼容旧 Nest）", () => {
		assert.equal(parseLlmOverride(undefined).state, "absent");
		assert.equal(parseLlmOverride(null).state, "absent");
	});

	it("五必填齐全 → ok，且原样带上可选能力字段", () => {
		const r = parseLlmOverride({ ...VALID, reasoning: true, contextWindow: 64_000, maxTokens: 4_096 });
		assert.equal(r.state, "ok");
		assert.equal(r.state === "ok" && r.value.reasoning, true);
		assert.equal(r.state === "ok" && r.value.contextWindow, 64_000);
		assert.equal(r.state === "ok" && r.value.maxTokens, 4_096);
	});

	// 2026-10-03 识图事故第二段根因：#123 在 model-assembly 消费 supportsVision、
	// #127 在 Nest 侧发送，但本 parse 层从未透传该字段 —— 生产实测
	// parseLlmOverride({...,supportsVision:true}).value.supportsVision === undefined，
	// 于是 resolveSupportsVision 恒 false → input:["text"] → 图片仍被降级占位。
	// 本组测试把 parse 层钉死，防止「定义了字段但解析层丢弃」再次静默发生。
	it("supportsVision=true → 透传（识图链路硬判据）", () => {
		const r = parseLlmOverride({ ...VALID, supportsVision: true });
		assert.equal(r.state, "ok");
		assert.equal(r.state === "ok" && r.value.supportsVision, true);
	});

	it("supportsVision=false → 显式透传 false（不得静默丢成 undefined）", () => {
		const r = parseLlmOverride({ ...VALID, supportsVision: false });
		assert.equal(r.state, "ok");
		assert.equal(r.state === "ok" && r.value.supportsVision, false);
	});

	it("supportsVision 缺省 → 字段不出现（交回 model-assembly 的「不猜」默认）", () => {
		const r = parseLlmOverride({ ...VALID });
		assert.equal(r.state, "ok");
		assert.equal(r.state === "ok" && "supportsVision" in r.value, false);
	});

	it("supportsVision 类型错 → invalid", () => {
		assert.equal(parseLlmOverride({ ...VALID, supportsVision: "yes" }).state, "invalid");
	});

	it("source=platform 也接受", () => {
		const r = parseLlmOverride({ ...VALID, source: "platform" });
		assert.equal(r.state, "ok");
	});

	it("缺任一必填 → invalid（不静默兜底）", () => {
		for (const key of ["model", "apiKey", "baseUrl", "providerRef", "source"]) {
			const rest: Record<string, unknown> = { ...VALID };
			delete rest[key];
			assert.equal(parseLlmOverride(rest).state, "invalid", `缺 ${key} 应 invalid`);
		}
	});

	it("必填为空串 / 非字符串 → invalid", () => {
		assert.equal(parseLlmOverride({ ...VALID, model: "" }).state, "invalid");
		assert.equal(parseLlmOverride({ ...VALID, apiKey: "   " }).state, "invalid");
		assert.equal(parseLlmOverride({ ...VALID, baseUrl: 123 }).state, "invalid");
		assert.equal(parseLlmOverride({ ...VALID, providerRef: null }).state, "invalid");
	});

	it("source 非法值 → invalid", () => {
		assert.equal(parseLlmOverride({ ...VALID, source: "unknown" }).state, "invalid");
	});

	it("可选能力字段类型错 → invalid", () => {
		assert.equal(parseLlmOverride({ ...VALID, reasoning: "yes" }).state, "invalid");
		assert.equal(parseLlmOverride({ ...VALID, contextWindow: "64000" }).state, "invalid");
		assert.equal(parseLlmOverride({ ...VALID, maxTokens: -1 }).state, "invalid");
	});

	it("非对象 → invalid", () => {
		assert.equal(parseLlmOverride("nope").state, "invalid");
		assert.equal(parseLlmOverride(42).state, "invalid");
	});
});
