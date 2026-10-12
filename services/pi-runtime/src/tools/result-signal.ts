/** 工具结果信号契约（spec docs/superpowers/specs/2026-10-12-tool-details-contract-design.md §2/§3/§5）。 */
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

export interface ToolResultSignal {
	status: "ok" | "partial" | "failed";
	/** 三态语义（§5）：true 仅确知可重试写；false 仅确知不可重试写；缺省 = 未判明。 */
	retryable?: boolean;
	truncated?: boolean;
	/** read 类工具：防「局部当全量」静默答错（get_canvas_summary 病例）。 */
	coverage?: "full" | "partial" | "empty";
	errorCode?: string;
}

/** §2.2 族契约（TDetails 必填字段；_signal 由 isToolResultSignal 独立守卫，不在此重复）。 */
export interface GenDetails {
	modelUsed: string;
	generationParams: Record<string, unknown>;
}
export interface WriteDetails {
	/** 工具直报的实际生效数；⭐ 禁止从 actions 反推（§2.1 护栏）。 */
	affectedCount: number;
}
export interface ReadSummaryDetails {
	coverage: "full" | "partial" | "empty";
	scope: string;
}

/** 本地域事实分类（§5 职责边界）：工具自己知道、vendor 分类器管不着。 */
const LOCAL_NON_RETRYABLE_STATUS = new Set(["empty_result", "invalid_params", "validation", "fallback_pending"]);
const PARTIAL_STATUS = new Set(["timeout", "upstream_timeout", "fallback_pending", "empty_result"]);

export function isToolResultSignal(v: unknown): v is ToolResultSignal {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		(o.status === "ok" || o.status === "partial" || o.status === "failed") &&
		(o.retryable === undefined || typeof o.retryable === "boolean") &&
		(o.truncated === undefined || typeof o.truncated === "boolean") &&
		(o.errorCode === undefined || typeof o.errorCode === "string") &&
		(o.coverage === undefined ||
			o.coverage === "full" ||
			o.coverage === "partial" ||
			o.coverage === "empty")
	);
}

export function isGenDetails(v: unknown): v is GenDetails {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.modelUsed === "string" && typeof o.generationParams === "object" && o.generationParams !== null
	);
}

export function isWriteDetails(v: unknown): v is WriteDetails {
	if (typeof v !== "object" || v === null) return false;
	return typeof (v as Record<string, unknown>).affectedCount === "number";
}

export function isReadSummaryDetails(v: unknown): v is ReadSummaryDetails {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		(o.coverage === "full" || o.coverage === "partial" || o.coverage === "empty") &&
		typeof o.scope === "string"
	);
}

/**
 * 信号分类单点（§5）：上游可重试性复用 vendor 分类器（唯一接触点）；
 * 本地域事实（empty_result/invalid_params/fallback_pending）在此判定，两者不重叠。
 * vendor 返回 false 时无法区分「配额/计费耗尽」与「pattern 未识别」（patterns 未导出）
 * ⇒ 按三态语义一律「未判明」不写 retryable；unknown 计数 metrics 驱动上游分类修复工单。
 */
export function signalFromUpstream(data: unknown): ToolResultSignal {
	if (typeof data !== "object" || data === null) return { status: "ok" };
	const o = data as Record<string, unknown>;
	const statusField = typeof o.status === "string" ? o.status : "";
	const errorCode =
		typeof o.errorCode === "string"
			? o.errorCode
			: typeof o.error_code === "string"
				? o.error_code
				: undefined;
	const base: ToolResultSignal = { status: "ok", ...(errorCode !== undefined ? { errorCode } : {}) };

	// 本地域事实优先：不依赖文本匹配，工具自己知道的事实自己断言。
	if (LOCAL_NON_RETRYABLE_STATUS.has(statusField)) {
		return {
			...base,
			status: PARTIAL_STATUS.has(statusField) ? "partial" : "failed",
			retryable: false,
		};
	}

	const isFailure = o.ok === false || PARTIAL_STATUS.has(statusField) || o.error !== undefined;
	if (!isFailure) return base;

	const rawText = [
		typeof o.message === "string" ? o.message : "",
		typeof o.error === "string" ? o.error : "",
		errorCode ?? "",
		statusField,
	]
		.filter(Boolean)
		.join("; ");
	// vendor 只读 stopReason + errorMessage 两字段 → 合成形状调用（§5 薄适配层）。
	const vendorRetryable = isRetryableAssistantError({
		stopReason: "error",
		errorMessage: rawText || "unknown",
	} as AssistantMessage);
	return {
		...base,
		status: PARTIAL_STATUS.has(statusField) ? "partial" : "failed",
		...(vendorRetryable ? { retryable: true } : {}),
	};
}

/** 展开 details 保留全部既有键（actions/confirmed 是消费方契约，绝不能丢）；注入键 = _signal。
 *  返回类型显式反映 _signal 注入（类型增强），调用方拿到的 details 类型即含 _signal。 */
export function withSignal<A extends { details: object }, S extends ToolResultSignal>(
	base: A,
	signal: S,
): Omit<A, "details"> & { details: A["details"] & { _signal: S } } {
	// 展开语义（保留全部既有键）由单测锁定；泛型交叉展开 TS 无法直接验证，此处单点收口。
	return { ...base, details: { ...base.details, _signal: signal } } as Omit<A, "details"> & {
		details: A["details"] & { _signal: S };
	};
}
