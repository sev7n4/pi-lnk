/**
 * K-1：BYOK 会话级模型装配（spec `docs/superpowers/specs/2026-09-26-byok-into-pi-runtime-design.md` §3.2）
 *
 * 覆盖：
 *   - 无 override → env 装配（providerId=agnes，与改造前逐字节一致）
 *   - 有 override → 用会话注入的 model/baseUrl/key，五字段全量生效
 *   - 能力字段（reasoning/contextWindow/maxTokens）保守默认 + 显式覆盖
 *   - providerId 由 providerRef 哈希派生（避免多渠道 Map 键冲突）
 *   - 红线自证：装配结果的可序列化面里不含 apiKey 明文
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assembleModel, type SessionLlmOverride } from "./model-assembly.js";

const OVERRIDE: SessionLlmOverride = {
	model: "deepseek-flash",
	apiKey: "sk-SECRET-DO-NOT-LEAK",
	baseUrl: "https://api.deepseek.com/",
	providerRef: "cmrrxageh000bql01xg1y6kjn::deepseek-flash",
	source: "user",
};

describe("assembleModel 会话级 override（K-1）", () => {
	it("无 override：env 装配，providerId 仍是 agnes（平台用户零变化）", () => {
		const { providerId } = assembleModel();
		assert.equal(providerId, "agnes");
	});

	it("agnes provider 声明 image 输入（spike 实测生产链路接受视觉输入）", () => {
		const { model } = assembleModel();
		assert.deepEqual(model.input, ["text", "image"]);
	});

	it("BYOK override 未声明视觉能力时仍只声明 text（不猜 = 不让上游 400）", () => {
		const { model } = assembleModel(OVERRIDE);
		assert.deepEqual(model.input, ["text"]);
	});

	// ↓ 2026-10-03 识图失效事故回归锁（生产实测，见 PR 描述）
	// 旧行为「BYOK 一律 input:["text"]」让 vendor transform-messages.ts:36 把图片
	// 静默替换成 "(image omitted: model does not support images)"，请求照样 200，
	// 表现为「模型说看不见图」。声明能力必须可由上游传入。
	it("override 声明 supportsVision=true ⇒ 声明 image 输入（图片不再被降级为占位符）", () => {
		const { model } = assembleModel({ ...OVERRIDE, supportsVision: true });
		assert.deepEqual(model.input, ["text", "image"]);
	});

	it("override 显式 supportsVision=false ⇒ 不声明 image（负例，不得被真值蒙混过关）", () => {
		const { model } = assembleModel({ ...OVERRIDE, supportsVision: false });
		assert.deepEqual(model.input, ["text"]);
	});

	it("env VISION_CAPABLE_MODELS 可强制声明视觉（运维覆盖，逗号分隔模型名）", () => {
		process.env.VISION_CAPABLE_MODELS = "deepseek-flash";
		try {
			const { model } = assembleModel(OVERRIDE);
			assert.deepEqual(model.input, ["text", "image"], "env 名单应覆盖「未声明」");
		} finally {
			delete process.env.VISION_CAPABLE_MODELS;
		}
	});

	it("env 名单是精确匹配，不是子串包含（防 'flash' 误伤 'flash-vision'）", () => {
		process.env.VISION_CAPABLE_MODELS = "deepseek-v4-pro";
		try {
			const { model } = assembleModel({ ...OVERRIDE, model: "deepseek-flash" });
			assert.deepEqual(model.input, ["text"], "deepseek-flash 不在该名单里");
		} finally {
			delete process.env.VISION_CAPABLE_MODELS;
		}
	});

	it("有 override：model / baseUrl 取会话注入值，providerId 为哈希派生", () => {
		const { providerId, model } = assembleModel(OVERRIDE);
		assert.equal(model.id, "deepseek-flash");
		assert.equal(model.baseUrl, "https://api.deepseek.com/");
		assert.match(providerId, /^byok-[0-9a-f]{12}$/);
	});

	it("能力字段保守默认：reasoning=false / contextWindow=128000 / maxTokens=8192", () => {
		const { model } = assembleModel(OVERRIDE);
		assert.equal(model.reasoning, false);
		assert.equal(model.contextWindow, 128_000);
		assert.equal(model.maxTokens, 8_192);
	});

	it("能力字段可显式覆盖（reasoning 模型 + 小上下文窗）", () => {
		const { model } = assembleModel({
			...OVERRIDE,
			reasoning: true,
			contextWindow: 64_000,
			maxTokens: 4_096,
		});
		assert.equal(model.reasoning, true);
		assert.equal(model.contextWindow, 64_000);
		assert.equal(model.maxTokens, 4_096);
	});

	it("不同 providerRef → 不同 providerId（Map 键不冲突）；同 ref → 稳定", () => {
		const a = assembleModel(OVERRIDE).providerId;
		const b = assembleModel({ ...OVERRIDE, providerRef: "ch_other::gpt-5" }).providerId;
		const a2 = assembleModel(OVERRIDE).providerId;
		assert.notEqual(a, b);
		assert.equal(a, a2);
	});

	it("红线①：装配结果的可序列化面不含 apiKey 明文", () => {
		const { models, model, providerId } = assembleModel(OVERRIDE);
		const serialized = JSON.stringify({
			providerId,
			model: { id: model.id, baseUrl: model.baseUrl, provider: model.provider },
			models: models.getModels(providerId),
		});
		assert.ok(!serialized.includes("sk-SECRET-DO-NOT-LEAK"), "apiKey 不得出现在可序列化面");
	});
});

describe("cost 费率（审计 P0-③：vendor calculateCost 只认 model.cost，此前被硬写 0 抹平）", () => {
	const COST_KEYS = [
		"AGNES_COST_INPUT_PER_M",
		"AGNES_COST_OUTPUT_PER_M",
		"AGNES_COST_CACHE_READ_PER_M",
		"AGNES_COST_CACHE_WRITE_PER_M",
	] as const;
	function clearCostEnv() {
		for (const k of COST_KEYS) delete process.env[k];
	}

	it("env 未配置：agnes 四项全 0（现状不变）", () => {
		clearCostEnv();
		const { model } = assembleModel();
		assert.equal(model.cost.input, 0);
		assert.equal(model.cost.output, 0);
		assert.equal(model.cost.cacheRead, 0);
		assert.equal(model.cost.cacheWrite, 0);
	});

	it("agnes 费率从 env 读取（每百万 token，USD）", () => {
		clearCostEnv();
		process.env.AGNES_COST_INPUT_PER_M = "2.5";
		process.env.AGNES_COST_OUTPUT_PER_M = "10";
		process.env.AGNES_COST_CACHE_READ_PER_M = "0.25";
		process.env.AGNES_COST_CACHE_WRITE_PER_M = "1.25";
		try {
			const { model } = assembleModel();
			assert.equal(model.cost.input, 2.5);
			assert.equal(model.cost.output, 10);
			assert.equal(model.cost.cacheRead, 0.25);
			assert.equal(model.cost.cacheWrite, 1.25);
		} finally {
			clearCostEnv();
		}
	});

	it("非法费率字符串回退 0（NaN / 负数）", () => {
		clearCostEnv();
		process.env.AGNES_COST_INPUT_PER_M = "abc";
		process.env.AGNES_COST_OUTPUT_PER_M = "-1";
		try {
			const { model } = assembleModel();
			assert.equal(model.cost.input, 0);
			assert.equal(model.cost.output, 0);
		} finally {
			clearCostEnv();
		}
	});

	it("BYOK override.cost 透传到 model.cost（seam：Nest 今日不填，留渠道费率目录接入点）", () => {
		clearCostEnv();
		const { model } = assembleModel({
			...OVERRIDE,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
		});
		assert.equal(model.cost.input, 1);
		assert.equal(model.cost.output, 2);
		assert.equal(model.cost.cacheRead, 0.5);
		assert.equal(model.cost.cacheWrite, 0.25);
	});

	it("BYOK 无 cost 字段：全 0（与现状一致）", () => {
		clearCostEnv();
		const { model } = assembleModel(OVERRIDE);
		assert.equal(model.cost.input, 0);
		assert.equal(model.cost.output, 0);
	});
});
