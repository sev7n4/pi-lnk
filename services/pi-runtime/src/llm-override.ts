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
		},
	};
}
