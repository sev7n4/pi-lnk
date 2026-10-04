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

/**
 * `inflight` 条目的最长保留时长（毫秒），导出供测试锁定。
 *
 * 取 15 分钟：显著大于 `DURATION_BUCKETS` 上限 660s（视频生成轮询上限），
 * 所以**正常在跑的工具绝不会因清扫被误删**（否则会凭空多出一条 orphan）。
 * 只有「有start 无 end」的孤儿条目——工具进程崩溃 / 被kill / lane 被 abandon
 * ——才会被回收。没有这个上限时，那些条目会随 pod 存活数天而慢性堆积。
 */
export const INFLIGHT_TTL_MS = 15 * 60 * 1000;

/**
 * `settled` 幂等窗口的条数上限，导出供测试锁定。
 *
 * **为什么「永久集」是错的**：`settled` 挂在单例 `ToolMetrics` 上，随pod 活数天。
 * 永久保留意味着每个 `toolCallId` 都在内存里永驻 ⇒ 集合大小 ≈
 * 进程生命周期内的工具调用总数 ⇒ 无界增长 ⇒ 慢性OOM。
 *
 * **有界化带来的语义取舍（必须知情）**：幂等窗口只覆盖「断线重连重放」窗口
 * （秒级~分钟级）。超出 `SETTLED_MAX` 后，最旧的 `toolCallId` 被淘汰，
 * 若它此时被重放，**会被二次计数**。这是刻意的取舍：
 * - 选永久集 ⇒ 内存无界（确定的故障，只是来得慢）；
 * - 选有界窗口 ⇒ 极长连接上的极旧重放可能重复计数（概率随量级衰减）。
 *后者可用更大的上限换更多内存，代价是对数级而非线性。二者不可兼得。
 *
 * 取 4096：远大于任何合理重放窗口内的 toolCallId 数量，内存占用可忽略。
 */
export const SETTLED_MAX = 4096;

type Hist = { count: number; sum: number; buckets: number[] };

function newHist(): Hist {
	return { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) };
}

/**
 * LLM 调用阶段闭集（spec §4.2）。
 *
 * ⚠️ `"unknown"` **不是真实阶段**，而是「vendor 事件不足以判定阶段」的显式占位。
 * 见 `session-manager.ts` 里 `retry_scheduled` 订阅处的完整说明：vendor 有三处
 * 发这个事件（主轮 / compaction / branch_summary），但载荷里没有任何字段能区分它们
 * （`step` 两侧都是 uuid7，`maxAttempts`/`delayMs` 两侧都取同一个 retryPolicy，
 * in-run compaction 的 `runId` 与主轮同一个 operation）。**宁可挂 `unknown` 让
 * 缺口在看板上可见，也不要写一个猜测的映射**——后者会把错误映射成看似精确的数据，
 * 比现在这个硬编码更糟。
 *
 * 消掉它的办法在 vendor 侧：给事件加一个判别字段（如 `stage` 或 `kind`）。
 * 该字段落地后把本行改成调用方传入即可，无需改动结算器与渲染。
 */
export type LlmStage = "main_turn" | "compaction" | "tool_result_summarize" | "deferred" | "unknown";

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
	/** key: toolCallId → 开始时刻。**有界**：超过 `INFLIGHT_TTL_MS` 的条目在 `renderInto` 时清扫。 */
	private inflight = new Map<string, number>();
	/** key: tool|outcome[|errorClass] */
	private calls = new Map<string, number>();
	/** key: tool */
	private durations = new Map<string, Hist>();
	/** key: stage|errorClass|channel|model */
	private llmErrors = new Map<string, number>();
	/** key: stage|channel|model */
	private llmRetries = new Map<string, number>();
	/**
	 * 已见 `end` 的 toolCallId，用于幂等。**有界**：上限 `SETTLED_MAX`，
	 * 超出时淘汰插入最早的（即Set 迭代序首个）。为何不能是永久集见 `SETTLED_MAX` 注释。
	 */
	private settled = new Set<string>();

	private orphaned = 0;
	private duplicates = 0;

	observeStart(e: { toolCallId: string }): void {
		// 同一 toolCallId 重新 start（recovery 重放）时直接覆盖旧时间戳：
		// 否则第二次 start 会被第一次的残留时间戳影响，且旧条目永不回收。
		this.inflight.set(e.toolCallId, Date.now());
	}

	observeEnd(e: ToolLifecycleEvent): void {
		// 幂等：断线重连会重放同一 end，重复结算会双倍计数。
		if (this.settled.has(e.toolCallId)) {
			this.duplicates += 1;
			// 关键：这里必须**同时清掉 inflight**。recovery 重放是「start→end」成对的，
			// 第二次 end 撞幂等早退后，若不在此清理，第二次 observeStart 塞进 inflight 的
			// 条目将永久残留（实测：首次结算后 inflight=0，重放后 inflight=1）。
			this.inflight.delete(e.toolCallId);
			return;
		}
		this.settled.add(e.toolCallId);
		this.evictSettled();

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

	/**
	 * `ended` 的真实语义：**已见 `end` 的唯一 toolCallId 数量**，
	 * **含孤儿 end**（无配对 start 的那些）。
	 *
	 * 它不是「结算次数」：孤儿 end 同样计入（它已完成分类与计数，只是不记时长），
	 * 所以 `ended === orphaned + 有配对 start 的结算数`。字段原名`settled`
	 * 会被读成「结算次数」，与实际语义相反，故改名。
	 */
	stats(): { ended: number; orphaned: number; duplicates: number } {
		return { ended: this.settled.size, orphaned: this.orphaned, duplicates: this.duplicates };
	}

	/** 仅供测试：只读窥视 `inflight` 大小（有界性断言用）。 */
	inflightSizeForTest(): number {
		return this.inflight.size;
	}

	/** 仅供测试：只读窥视 `settled` 大小（有界性断言用）。 */
	settledSizeForTest(): number {
		return this.settled.size;
	}

	/** 淘汰 `settled` 里最旧的条目，直到size ≤ `SETTLED_MAX`。Set 迭代序 === 插入序。 */
	private evictSettled(): void {
		while (this.settled.size > SETTLED_MAX) {
			const oldest = this.settled.values().next();
			if (oldest.done) return;
			this.settled.delete(oldest.value);
		}
	}

	/**
	 * 清扫 `inflight` 中超过 `INFLIGHT_TTL_MS` 未结算的条目。
	 *
	 * 由 `renderInto` 顺带触发（而非 `observeStart`）—— 因为泄漏的根因正是
	 * 「只有 start 没有 end」，这类事件**不会再触发任何 observe***，
	 * 在 `observeStart` 里清扫永远扫不到它们。`/metrics` 被定期抓取，
	 * 顺带清扫即可保证上界，无需额外定时器。
	 */
	private sweepInflight(now: number): void {
		for (const [id, startedAt] of this.inflight) {
			if (now - startedAt > INFLIGHT_TTL_MS) this.inflight.delete(id);
		}
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

	/** 追加渲染行。esc 防 label 注入。 */
	renderInto(lines: string[]): void {
		//顺带清扫过期 inflight（见 sweepInflight 注释：泄漏的根因是「只有 start 没有 end」，
		// 这类条目不会再触发 observe*，故必须由渲染路径兜底回收）。
		this.sweepInflight(Date.now());

		/**
		 * Prometheus 文本格式**用换行分隔样本行**，所以label 值里的 `\n`/`\r`
		 * 会让攻击者伪造出独立指标行（实测：`model` 含 `\n` 可渲染出
		 * `pi_runtime_FAKE 999`）。`\n` → `\\n`、`\r` → `\\r` 是文本格式的
		 * 标准转义，Prometheus 反解后label 值不变。
		 *
		 * 为什么必须转义：`model` 来自用户 BYOK 的 `override.model`，
		 * 而 `llm-override.ts:45` 只校验 `nonEmptyString` ⇒ 允许任意字符串
		 * ⇒这是现实可注入点（`channel` 是 12 位 hex，`toolName` 来自内置工具表，均安全）。
		 *
		 * ⚠️ **存量问题，本轮不修**：`metrics.ts:280` 的既有 `esc()` 有完全相同的缺陷
		 * （已实测：其 `tool` label 含 `\n` 可伪造 `pi_runtime_FAKE3 777`）。
		 * 修它会改动既有 25 个指标族的渲染输出、超出本任务范围，留给单独的整改。
		 * 本处只修 `ToolMetrics` 自己的渲染路径。
		 */
		const esc = (s: string) =>
			s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");

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
