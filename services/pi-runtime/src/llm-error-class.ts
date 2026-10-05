import { classifyToolOutcome, type ToolErrorClass } from "./tool-error-class.js";

/**
 * LLM 主路径的失败分类（spec §4.5 —— 补 1.5-a 的缺口）
 *
 * 背景：`session-manager.ts` 里 `lane.prompt(...)` 的失败分支只 `dispatch` 一个 SSE error 事件，
 * 零指标 ⇒ `pi_runtime_llm_errors_total` 只能反映「入口早拒」，看不到「模型调用失败」。
 *
 * ⚠️ 为什么精度有限：vendor 的 `toError(error)`（`harness/result.ts`）把错误压成
 * `unknown`/`Error`，**拿不到 status / retryable 等结构化字段** ⇒ 只能拿文本做正则分类。
 * 这是先做入口早拒（那里有真实错误文本）再补主路径的原因。
 *
 * ⚠️ **禁止把错误原文放进返回值**——这些值会变成 Prometheus label。
 */

export interface ClassifiedLlmError {
	/** 闭集 9值，与工具侧共用同一套分类器。 */
	errorClass: ToolErrorClass;
	/** 闭集 5 值。压缩期的失败必须与主轮区分开，否则看板无法定位。 */
	stage: "main_turn" | "compaction";
}

/**
 * 这条失败该不该计入错误。
 *
 * **用户主动取消不算错误** —— 计进去会污染错误率的分子（分母是全部调用）。
 * 与既有 `session-manager.ts` 里 `entry.userAborted` 早退分支的判断保持一致。
 */
export function shouldCountLlmFailure(input: { aborted: boolean; text: string }): boolean {
	return input.aborted !== true;
}

/**
 * 分类一条 LLM 主路径的失败。
 *
 * @param aborted 是否为用户主动取消（调用方传 `entry.userAborted`）
 * @param compacting 当前是否在压缩期（调用方传 `entry.compacting`）⇒ 决定 stage
 */
export function classifyLlmFailure(input: {
	aborted: boolean;
	text: string;
	compacting?: boolean;
}): ClassifiedLlmError {
	const { errorClass } = classifyToolOutcome({
		isError: true,
		// 用户取消在语义上不是「模型报的错」，但它仍是一次失败的调用；
		// 交给分类器按文本判（"request aborted" 会自然落 `aborted` 类），
		// 真正的「该不该计数」由 shouldCountLlmFailure 决定，两件事分开。
		terminate: false,
		resultText: input.text,
	});
	return {
		errorClass: errorClass ?? "internal",
		stage: input.compacting === true ? "compaction" : "main_turn",
	};
}
