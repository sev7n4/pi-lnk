/**
 * 上下文压缩判定（诊断 F-01）。
 *
 * vendor 已提供决策原语但从不在内部调用它们（2026-09-30 审查结论）：harness src 内
 * `shouldCompact` 零生产消费点，pi-runtime 亦零处调用 `lane.compact()`，导致
 * `enabled:true` 这个开关什么都不控制。本模块把 vendor 原语接到 pi-runtime 侧，
 * 并把 vendor 的布尔结果展开为带 threshold 的可观测对象（threshold 用于日志与指标）。
 */
import {
	calculateContextTokens,
	getLastAssistantUsage,
	shouldCompact,
	type Entry,
} from "@earendil-works/pi-agent-core";
import type { CompactionConfig } from "./runtime-config.js";

/** 未触发压缩的理由；全部为「可容忍」，不进错误率。 */
export type CompactionSkipReason = "disabled" | "no_window" | "no_usage" | "below_threshold";

export type CompactionOutcome = "nothing_to_compact" | "lane_busy" | "closed" | "unknown";

export interface CompactionDecision {
	shouldRun: boolean;
	/** 参与判定的上下文 token 数；无 usage 时缺省。 */
	contextTokens?: number;
	/** 触发阈值 = contextWindow - reserveTokens；无窗口时缺省。 */
	threshold?: number;
	skipReason?: CompactionSkipReason;
}

/** 有效窗口 = 有限的正数。NaN/Infinity/0/负数一律视为「无窗口」。 */
function effectiveWindow(contextWindow: number | undefined): number | undefined {
	if (typeof contextWindow !== "number") return undefined;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	return contextWindow;
}

export function decideCompaction(
	entries: readonly Entry[],
	contextWindow: number | undefined,
	settings: CompactionConfig,
): CompactionDecision {
	if (!settings.enabled) return { shouldRun: false, skipReason: "disabled" };
	const window = effectiveWindow(contextWindow);
	if (window === undefined) return { shouldRun: false, skipReason: "no_window" };
	const usage = getLastAssistantUsage(entries as Entry[]);
	if (!usage) return { shouldRun: false, skipReason: "no_usage" };
	const contextTokens = calculateContextTokens(usage);
	const threshold = window - settings.reserveTokens;
	if (!shouldCompact(contextTokens, window, settings)) {
		return { shouldRun: false, contextTokens, threshold, skipReason: "below_threshold" };
	}
	return { shouldRun: true, contextTokens, threshold };
}

/**
 * 归类 `lane.compact()` 的错误。
 *
 * 用 constructor.name 而非 instanceof：这三个错误类未在 `index.ts` 的导出清单里
 * （清单只有 BranchSummaryError / CompactionError / ExecutionError / FileError），
 * 拿不到运行时引用，故按类名判别；未能识别时一律 unknown，保证不会漏统计。
 */
export function classifyCompactionError(error: unknown): CompactionOutcome {
	const name = (error as { constructor?: { name?: string } } | null)?.constructor?.name;
	if (name === "NothingToCompact") return "nothing_to_compact";
	if (name === "LaneBusy") return "lane_busy";
	if (name === "Closed") return "closed";
	return "unknown";
}
