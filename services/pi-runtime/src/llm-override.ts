/**
 * K-1：create body 的 `llm` 字段白名单校验（spec §3.2 / §4）
 *
 * 三种结果：
 *   absent  —— 字段缺失（旧 Nest 不发 llm）→ 走 env 装配，零回归
 *   ok      —— 五必填齐全且类型正确 → 会话级 override
 *   invalid —— 畸形（缺字段/空串/类型错）→ 调用方返 400
 *
 * 为什么畸形要 400 而不是静默兜底：llm 缺失与 llm 畸形在 env 兜底下**表象一致**，
 * 但前者是"用户没选 BYOK"，后者是"以为是 BYOK 实际走了平台 key"——后者是错账，
 * 必须让调用方立刻可见（spec §4 失败路径表第 2 行）。
 *
 * 红线：本文件不得打印输入体（apiKey 明文会进日志）。
 */
import type { SessionLlmOverride } from "./model-assembly.js";

export type LlmOverrideParseResult =
	| { state: "absent" }
	| { state: "ok"; value: SessionLlmOverride }
	| { state: "invalid" };

function nonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function optionalBoolean(v: unknown): boolean | undefined | null {
	if (v === undefined) return undefined;
	return typeof v === "boolean" ? v : null; // null = 类型错
}

function optionalPositiveInt(v: unknown): number | undefined | null {
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
	return Math.floor(v);
}

/**
 * 可选 cost（渠道费率，USD / 百万 token）。P1 接线：Nest 侧从渠道
 * `models[].pricing` 解析后随 override 下发，model-assembly 填进 Model.cost，
 * vendor calculateCost 在响应时自动算出 usage.cost。
 *
 * 四个键全部可选（缺 = 0）；对象整体缺省 = 不传（行为不变）。
 * 任何出现的键非法（非有限非负数）→ null = 畸形 → 调用方 400。
 * 四键全缺省时视为未声明（返回 undefined，不产出全零对象）。
 */
function optionalCost(v: unknown): SessionLlmOverride["cost"] | undefined | null {
	if (v === undefined) return undefined;
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const c = v as Record<string, unknown>;
	const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let seen = false;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const raw = c[key];
		if (raw === undefined) continue;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
		out[key] = raw;
		seen = true;
	}
	return seen ? out : undefined;
}

export function parseLlmOverride(raw: unknown): LlmOverrideParseResult {
	if (raw === undefined || raw === null) return { state: "absent" };
	if (typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid" };
	const r = raw as Record<string, unknown>;

	// 五必填：model / apiKey / baseUrl / providerRef / source
	if (
		!nonEmptyString(r.model) ||
		!nonEmptyString(r.apiKey) ||
		!nonEmptyString(r.baseUrl) ||
		!nonEmptyString(r.providerRef)
	) {
		return { state: "invalid" };
	}
	if (r.source !== "user" && r.source !== "platform") return { state: "invalid" };

	const reasoning = optionalBoolean(r.reasoning);
	if (reasoning === null) return { state: "invalid" };
	const contextWindow = optionalPositiveInt(r.contextWindow);
	if (contextWindow === null) return { state: "invalid" };
	const maxTokens = optionalPositiveInt(r.maxTokens);
	if (maxTokens === null) return { state: "invalid" };
	// supportsVision：#123 在 model-assembly 消费、#127 在 Nest 发送，但本层此前
	// 从未透传 —— 生产实测 Nest 发 true 到这里被剥成 undefined，识图继续降级
	// （「image omitted: model does not support images」，请求照常 200 无日志）。
	// 教训与 #126 同形：加了字段没接线。此处缺省 = 字段不出现，交回「不猜」默认。
	const supportsVision = optionalBoolean(r.supportsVision);
	if (supportsVision === null) return { state: "invalid" };
	const cost = optionalCost(r.cost);
	if (cost === null) return { state: "invalid" };

	return {
		state: "ok",
		value: {
			model: r.model,
			apiKey: r.apiKey,
			baseUrl: r.baseUrl,
			providerRef: r.providerRef,
			source: r.source,
			...(reasoning === undefined ? {} : { reasoning }),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
			...(supportsVision === undefined ? {} : { supportsVision }),
			...(cost === undefined ? {} : { cost }),
		},
	};
}
