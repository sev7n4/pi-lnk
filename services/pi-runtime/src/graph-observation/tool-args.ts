/**
 * 从 `tool_start` 的 `args` 里只取出**安全可观测**的部分。
 *
 * ⛔ 安全判据：Prometheus 的 label 只允许工具**参数名**（代码内枚举）与
 * 枚举校验过的 `view` 取值。**参数值一律不得进 label** ——
 * `title="沙丘"` 这类用户可控文本写进监控面既是注入面，也违反 label 的格式约束。
 */
import { isKnownViewName } from "./graph-metrics.js";

/** 参数名列表（顺序稳定：对象插入序）。非对象一律返回空数组。 */
export function extractParamNames(args: unknown): string[] {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
	return Object.keys(args as Record<string, unknown>);
}

/**
 * `view` 取值 —— 仅在**已知枚举内**时返回，否则 `undefined`。
 *
 * 模型给的是自由文本（工具 schema 的枚举在运行时不强制），未知值返回 undefined
 * ⇒ 下游不落 label，而不是把模型输出原样写进监控面。
 */
export function extractViewName(args: unknown): string | undefined {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
	const v = (args as Record<string, unknown>).view;
	if (typeof v !== "string") return undefined;
	return isKnownViewName(v) ? v : undefined;
}
