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
	// `gate` 必须带词边界：否则 investigate/aggregate/mitigate/navigate/delegated
	// 都会因内含 "gate" 子串被误判成 gate_blocked。
	if (/\bgate\b|hitl|未授权|unauthorized|forbidden/.test(text)) {
		return { outcome: "error", errorClass: "gate_blocked" };
	}
	if (/invalid|validation|参数|校验|expected/.test(text)) {
		return { outcome: "error", errorClass: "validation" };
	}
	return { outcome: "error", errorClass: "internal" };
}

/**
 * LLM 上游错误文本分类（spec §4.4）。
 *
 * **为什么复用 `classifyToolOutcome` 而不是另写一套正则**：本仓已有两处判「上游报了什么」——
 * 工具结果侧与 LLM 调用侧。若各自维护正则，两者会各自演化，最终同一个错误在
 * `pi_runtime_tool_calls_total` 与 `pi_runtime_llm_errors_total` 里落到不同 error_class，
 * 跨指标对账时看起来像数据 bug，实则是规则漂移。故此处只做**参数化**：
 * 强制 `isError: true, terminate: false`（LLM 错误恒为错误、且不存在工具那套 terminate 语义），
 * 判定规则完全交给同一个函数。
 *
 * @param text 上游错误原文。**仅作判定输入，绝不可作为 label 渲染出去**（同文件头警告）。
 * @returns闭集内的 errorClass；无法判定时由`classifyToolOutcome` 兜底为 `"internal"`
 *   （恒有值，不会返回 null——`isError: true` 分支不产出 null）。
 */
export function classifyLlmErrorText(text: string): ToolErrorClass {
	// 恒有值：`isError: true` 走过所有正则后必有 `return`，最后一次兜底为 "internal"，
	// 该分支不产出 null。故此处不需要 `?? "internal"`（那会把不存在的 null 路径写成看似可选）。
	const { errorClass } = classifyToolOutcome({ isError: true, terminate: false, resultText: text });
	if (errorClass === null) throw new Error("classifyToolOutcome 在 isError:true 下返回了 null，分类器契约被破坏");
	return errorClass;
}
