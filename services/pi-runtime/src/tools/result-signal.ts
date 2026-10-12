/** P0 工具结果信号契约（spec docs/agent/tool-result-quality-signal-gap.md §四/§十 P0）。 */

export interface ToolResultSignal {
	status: "ok" | "partial" | "failed";
	/** 规则启发式判定：429/timeout 类 → true（模型可退避重试而非改 prompt）。 */
	retryable?: boolean;
	truncated?: boolean;
	/** read 类工具：防「局部当全量」静默答错（get_canvas_summary 病例）。 */
	coverage?: "full" | "partial" | "empty";
	errorCode?: string;
}

const RETRYABLE_CODES = new Set([
	"rate_limited",
	"upstream_timeout",
	"timeout",
	"too_many_requests",
	"429",
	"503",
	"service_unavailable",
]);

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

export function signalFromUpstream(data: unknown): ToolResultSignal {
	if (typeof data !== "object" || data === null) return { status: "ok", retryable: false };
	const o = data as Record<string, unknown>;
	const statusField = typeof o.status === "string" ? o.status : "";
	const errorCode =
		typeof o.errorCode === "string"
			? o.errorCode
			: typeof o.error_code === "string"
				? o.error_code
				: undefined;
	if (o.ok === false) {
		const retryable =
			RETRYABLE_CODES.has(statusField) || (errorCode !== undefined && RETRYABLE_CODES.has(errorCode));
		return {
			status: statusField === "upstream_timeout" ? "partial" : "failed",
			retryable,
			...(errorCode !== undefined ? { errorCode } : {}),
		};
	}
	if (RETRYABLE_CODES.has(statusField)) {
		return {
			status: "partial",
			retryable: true,
			...(errorCode !== undefined ? { errorCode } : {}),
		};
	}
	if (statusField === "fallback_pending") return { status: "partial", retryable: false };
	return { status: "ok", retryable: false };
}

/** 展开 details 保留全部既有键（actions/confirmed 是消费方契约，绝不能丢）。 */
export function withSignal<A extends { details: object }>(base: A, signal: ToolResultSignal): A {
	return { ...base, details: { ...base.details, signal } };
}
