/**
 * 工具调用的结果与错误分类（spec §4.1/ §4.4）
 *
 * 为什么要闭集枚举 + 正则兜底：上游只给自由文本，没有结构化错误码。
 * 闭集保证 Prometheus label 有界；正则必然有误判，故兜底落 `internal`
 * 保留可见性 —— 归错类可接受，看不见不可接受。
 *
 * ⚠️ 禁止把 resultText 原文放进返回值（会变label ⇒ 基数爆炸）。
 */

export type ToolErrorClass =
	| "blocked_terminate"
	| "aborted"
	| "upstream_4xx"
	| "upstream_5xx"
	| "timeout"
	| "network"
	| "gate_blocked"
	| "validation"
	| "internal";

export type ToolOutcome = "ok" | "error" | "blocked";

/**
 * 判定顺序即优先级，自上而下首个命中即定。
 *
 * 顺序要点：
 * - terminate 必须在 isError 之前 —— 模型主动终止往往同时带 isError，
 *   但它不是「错误」，归 blocked 才不会污染错误率。
 * - 4xx 先于 5xx 先于 timeout/network：更具体的原因优先。
 */
export function classifyToolOutcome(input: {
	isError: boolean;
	terminate: boolean;
	resultText: string;
}): { outcome: ToolOutcome; errorClass: ToolErrorClass | null } {
	if (input.terminate) return { outcome: "blocked", errorClass: "blocked_terminate" };
	if (!input.isError) return { outcome: "ok", errorClass: null };

	const text = input.resultText.toLowerCase();

	// aborted 要先于 4xx/5xx：「request aborted」里可能同时含错误码字样。
	if (/\babort(ed)?\b|取消|中断/.test(text)) return { outcome: "error", errorClass: "aborted" };
	if (/\b429\b|rate.?limit|too many requests/.test(text)) {
		return { outcome: "error", errorClass: "upstream_4xx" };
	}
	if (/\b5\d\d\b|upstream|bad gateway|service unavailable/.test(text)) {
		return { outcome: "error", errorClass: "upstream_5xx" };
	}
	if (/timeout|超时|etimedout/.test(text)) return { outcome: "error", errorClass: "timeout" };
	if (/econnrefused|econnreset|enotfound|fetch failed|network/.test(text)) {
		return { outcome: "error", errorClass: "network" };
	}
	if (/gate|hitl|未授权|unauthorized|forbidden/.test(text)) {
		return { outcome: "error", errorClass: "gate_blocked" };
	}
	if (/invalid|validation|参数|校验|expected/.test(text)) {
		return { outcome: "error", errorClass: "validation" };
	}
	return { outcome: "error", errorClass: "internal" };
}
