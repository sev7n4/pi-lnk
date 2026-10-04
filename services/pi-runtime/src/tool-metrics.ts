/**
 * 工具与 LLM 指标结算器（spec §4.1 / §4.2）
 *
 * 为什么放在事件层而不是各工具内部：harness 的 `tool_start`/`tool_end` 是
 * 全工具统一事件，载荷自带 toolCallId / isError / terminate ⇒ 39 个工具
 * 零改动全覆盖，且不必新增任何工具自埋（新增工具自动有指标）。
 *
 * 本类不自己实现 Prometheus 文本渲染，只往宿主 Metrics 提供的 lines 数组里追加，
 * 以保证既有 25 个指标族的输出逐字不变。
 */

import { classifyToolOutcome, type ToolErrorClass, type ToolOutcome } from "./tool-error-class.js";

/** 工具耗时桶（秒）。上限 660s 对齐视频生成轮询上限，见 spec §7.2。 */
const DURATION_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 180, 660];

type Hist = { count: number; sum: number; buckets: number[] };

function newHist(): Hist {
	return { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) };
}

/** LLM 调用阶段闭集（spec §4.2）。 */
export type LlmStage = "main_turn" | "compaction" | "tool_result_summarize" | "deferred";

export interface ToolLifecycleEvent {
	toolName: string;
	toolCallId: string;
	isError: boolean;
	terminate: boolean;
	/** 错误判定用的文本摘要；**绝不可作为 label 渲染出去**。 */
	resultText: string;
	channel: string;
	model: string;
}

export class ToolMetrics {
	/** key: toolCallId → 开始时刻。 */
	private inflight = new Map<string, number>();
	/** key: tool|outcome[|errorClass] */
	private calls = new Map<string, number>();
	/** key: tool */
	private durations = new Map<string, Hist>();
	/** key: stage|errorClass|channel|model */
	private llmErrors = new Map<string, number>();
	/** key: stage|channel|model */
	private llmRetries = new Map<string, number>();
	/** 已结算的 toolCallId，用于幂等。 */
	private settled = new Set<string>();

	private orphaned = 0;
	private duplicates = 0;

	observeStart(e: { toolCallId: string }): void {
		this.inflight.set(e.toolCallId, Date.now());
	}

	observeEnd(e: ToolLifecycleEvent): void {
		// 幂等：断线重连会重放同一 end，重复结算会双倍计数。
		if (this.settled.has(e.toolCallId)) {
			this.duplicates += 1;
			return;
		}
		this.settled.add(e.toolCallId);

		const { outcome, errorClass } = classifyToolOutcome({
			isError: e.isError,
			terminate: e.terminate,
			resultText: e.resultText,
		});
		this.bumpCall(e.toolName, outcome, errorClass);

		const startedAt = this.inflight.get(e.toolCallId);
		if (startedAt === undefined) {
			// 孤儿 end（recovery 重放）：只计数，不记时长——否则污染 p99。
			this.orphaned += 1;
			return;
		}
		this.inflight.delete(e.toolCallId);
		this.observeDuration(e.toolName, (Date.now() - startedAt) / 1000);
	}

	observeLlmError(e: { stage: LlmStage; errorClass: ToolErrorClass; channel: string; model: string }): void {
		const key = `${e.stage}|${e.errorClass}|${e.channel}|${e.model}`;
		this.llmErrors.set(key, (this.llmErrors.get(key) ?? 0) + 1);
	}

	observeLlmRetry(e: { stage: LlmStage; channel: string; model: string }): void {
		const key = `${e.stage}|${e.channel}|${e.model}`;
		this.llmRetries.set(key, (this.llmRetries.get(key) ?? 0) + 1);
	}

	stats(): { settled: number; orphaned: number; duplicates: number } {
		return { settled: this.settled.size, orphaned: this.orphaned, duplicates: this.duplicates };
	}

	private bumpCall(tool: string, outcome: ToolOutcome, errorClass: ToolErrorClass | null): void {
		const key = errorClass ? `${tool}|${outcome}|${errorClass}` : `${tool}|${outcome}`;
		this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
	}

	private observeDuration(tool: string, sec: number): void {
		let h = this.durations.get(tool);
		if (!h) {
			h = newHist();
			this.durations.set(tool, h);
		}
		h.count += 1;
		h.sum += sec;
		for (let i = 0; i < DURATION_BUCKETS.length; i++) {
			if (sec <= DURATION_BUCKETS[i]) h.buckets[i] += 1;
		}
	}

	/** 追加渲染行。esc 防label 注入（label 值含引号会破坏文本格式）。 */
	renderInto(lines: string[]): void {
		const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		lines.push("# HELP pi_runtime_tool_calls_total Tool invocations by tool, result and error class.");
		lines.push("# TYPE pi_runtime_tool_calls_total counter");
		for (const [key, count] of [...this.calls.entries()].sort()) {
			const [tool, outcome, errorClass] = key.split("|");
			const labels = errorClass
				? `tool="${esc(tool)}",result="${esc(outcome)}",error_class="${esc(errorClass)}"`
				: `tool="${esc(tool)}",result="${esc(outcome)}"`;
			lines.push(`pi_runtime_tool_calls_total{${labels}} ${count}`);
		}

		lines.push("# HELP pi_runtime_tool_duration_seconds Tool execution duration in seconds.");
		lines.push("# TYPE pi_runtime_tool_duration_seconds histogram");
		for (const [tool, h] of [...this.durations.entries()].sort()) {
			for (let i = 0; i < DURATION_BUCKETS.length; i++) {
				lines.push(
					`pi_runtime_tool_duration_seconds_bucket{tool="${esc(tool)}",le="${DURATION_BUCKETS[i]}"} ${h.buckets[i]}`,
				);
			}
			lines.push(`pi_runtime_tool_duration_seconds_bucket{tool="${esc(tool)}",le="+Inf"} ${h.count}`);
			lines.push(`pi_runtime_tool_duration_seconds_sum{tool="${esc(tool)}"} ${h.sum.toFixed(4)}`);
			lines.push(`pi_runtime_tool_duration_seconds_count{tool="${esc(tool)}"} ${h.count}`);
		}

		lines.push("# HELP pi_runtime_llm_errors_total LLM errors by stage, class, channel and model.");
		lines.push("# TYPE pi_runtime_llm_errors_total counter");
		for (const [key, count] of [...this.llmErrors.entries()].sort()) {
			const [stage, errorClass, channel, model] = key.split("|");
			lines.push(
				`pi_runtime_llm_errors_total{stage="${esc(stage)}",error_class="${esc(errorClass)}",channel="${esc(channel)}",model="${esc(model)}"} ${count}`,
			);
		}

		lines.push("# HELP pi_runtime_llm_retries_total LLM retry schedules by stage, channel and model.");
		lines.push("# TYPE pi_runtime_llm_retries_total counter");
		for (const [key, count] of [...this.llmRetries.entries()].sort()) {
			const [stage, channel, model] = key.split("|");
			lines.push(
				`pi_runtime_llm_retries_total{stage="${esc(stage)}",channel="${esc(channel)}",model="${esc(model)}"} ${count}`,
			);
		}
	}
}
