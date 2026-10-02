/**
 * 最小 Prometheus 指标（spec K2 5xx 率 / K3 p99 的度量入口）
 *
 * 零依赖：直接输出 text/plain; version=0.0.4 文本格式。
 * 覆盖：
 *   - pi_runtime_http_requests_total{route,status}      请求计数（K2 分母/5xx）
 *   - pi_runtime_http_request_duration_seconds{route}   响应耗时直方图（K3 p99）
 *   - pi_runtime_llm_prompt_errors_total{reason}        prompt 阶段错误（429/上游 5xx 等）
 *   - pi_runtime_sessions_active                        活跃会话数 gauge
 *   - pi_runtime_sessions_live                         内存驻留会话数 gauge（P0-①：与 active 同源别名）
 *   - pi_runtime_session_resumes_total{outcome}         会话 create 三态计数（new/memory/disk/rebuilt）
 *   - pi_runtime_compactions_total{result}              上下文压缩结果计数（ok/error）
 *   - pi_runtime_compaction_skips_total{reason}         未触发压缩的理由计数（可容忍跳过）
 *   - pi_runtime_prompt_rejections_total{reason}        被拒 prompt 计数（busy）
 *   - pi_runtime_tool_search_calls_total{outcome}       tool_search 搜索结果计数（hit/miss/empty）
 *   - pi_runtime_tool_search_activated_total            经 tool_search 激活的延迟工具数累计
 *   - pi_runtime_build_info / pi_runtime_uptime_seconds
 */

// type-only：擦除后不留运行时依赖，只把 reason 的取值域锁到决策器的两个来源上。
import type { CompactionOutcome, CompactionSkipReason } from "./compaction-check.js";

const HIST_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

/** 工具结果体积直方图桶（字节）（③：工具结果 token 观测的原始量）。 */
const BYTES_BUCKETS = [256, 1024, 4096, 16384, 65536, 262144, 1_048_576];

/** 工具调用错误分类（③）；`retry` 为 V-γ 重试放行打点（非错误）。 */
export type ToolErrorKind =
	| "upstream_4xx" | "upstream_5xx" | "envelope" | "timeout" | "network" | "gate_blocked" | "retry";

interface HistogramState {
	count: number;
	sum: number;
	buckets: number[]; // cumulative, aligned with HIST_BUCKETS
}

function newHistogram(): HistogramState {
	return { count: 0, sum: 0, buckets: HIST_BUCKETS.map(() => 0) };
}

export class Metrics {
	private httpTotal = new Map<string, number>(); // key: route|method|status
	private httpHist = new Map<string, HistogramState>(); // key: route
	private promptErrors = new Map<string, number>(); // key: reason
	private toolCalls = new Map<string, number>(); // key: tool|result[|kind]
	private toolResultBytes = new Map<string, HistogramState>(); // key: tool
	private sessionResumes = new Map<string, number>(); // key: outcome (new|memory|disk|rebuilt)
	private compactions = new Map<string, number>(); // key: result (ok|error)
	/** key: 未触发压缩的理由（disabled|no_window|no_usage|below_threshold|nothing_to_compact|lane_busy|closed|unknown）。 */
	private compactionSkips = new Map<string, number>();
	private promptRejections = new Map<string, number>(); // key: reason (busy)
	/**
	 * steering / followUp 队列操作计数（2026-10-02 接入），key 形如 `enqueue|steer|ok`。
	 *
	 * 刻意与 promptRejections 分开：用户插话入队**本身就是这条链路的目标行为**，
	 * 把它计进「被拒的 prompt」会把队列功能的成功率稀释成噪声，真出问题时反而看不见。
	 */
	private queueOps = new Map<string, number>();
	private skillsLoaded = 0;
	private skillsPromptTokens = 0;
	private usageTokens = new Map<string, number>(); // key: kind (input|output|cache_read|cache_write)
	private usageCost = new Map<string, number>(); // key: kind 同上
	private toolSearchCalls = new Map<string, number>(); // key: outcome (hit|miss|empty)
	private toolSearchActivated = 0; // 命中激活的工具个数累计（配合 calls 可算平均激活数）
	private compactionGaps = new Map<string, number>(); // key: 摘要缺失段标题（REQUIRED_SECTIONS 原文）
	private startedAt = Date.now();

	observeHttp(route: string, method: string, status: number, durationSec: number): void {
		const totalKey = `${route}|${method}|${status}`;
		this.httpTotal.set(totalKey, (this.httpTotal.get(totalKey) ?? 0) + 1);
		let h = this.httpHist.get(route);
		if (!h) {
			h = newHistogram();
			this.httpHist.set(route, h);
		}
		h.count += 1;
		h.sum += durationSec;
		for (let i = 0; i < HIST_BUCKETS.length; i++) {
			if (durationSec <= HIST_BUCKETS[i]) h.buckets[i] += 1;
		}
	}

	observePromptError(reason: string): void {
		this.promptErrors.set(reason, (this.promptErrors.get(reason) ?? 0) + 1);
	}

	observeToolCall(tool: string, outcome: "ok" | "error" | "circuit_open", kind?: ToolErrorKind): void {
		const key = kind ? `${tool}|${outcome}|${kind}` : `${tool}|${outcome}`;
		this.toolCalls.set(key, (this.toolCalls.get(key) ?? 0) + 1);
	}

	/** 工具结果体积观测（字节）：返回给模型的内容序列化后大小，用于上下文预算回归。 */
	observeToolResult(tool: string, bytes: number): void {
		let h = this.toolResultBytes.get(tool);
		if (!h) {
			h = { count: 0, sum: 0, buckets: BYTES_BUCKETS.map(() => 0) };
			this.toolResultBytes.set(tool, h);
		}
		h.count += 1;
		h.sum += bytes;
		for (let i = 0; i < BYTES_BUCKETS.length; i++) {
			if (bytes <= BYTES_BUCKETS[i]) h.buckets[i] += 1;
		}
	}

	/** P0-① 会话 create 结果：new（新建）/ memory（内存复用）/ disk（磁盘恢复）/ rebuilt（身份变更重建）。 */
	observeSessionResume(outcome: "memory" | "disk" | "new" | "rebuilt"): void {
		this.sessionResumes.set(outcome, (this.sessionResumes.get(outcome) ?? 0) + 1);
	}

	/** 上下文压缩结果（只在 compaction_end 且 status=completed/failed 时计入）。 */
	observeCompaction(result: "ok" | "error"): void {
		this.compactions.set(result, (this.compactions.get(result) ?? 0) + 1);
	}

	/**
	 * 未发生压缩的理由计数：disabled / no_window / no_usage / below_threshold /
	 * lane_unavailable / entries_unavailable / nothing_to_compact / lane_busy / closed / unknown。
	 *
	 * 刻意与 pi_runtime_compactions_total 分开：这些是「可容忍跳过」，混进压缩结果会稀释失败率。
	 * reason 取值域用联合类型而非自由 string 锁在两个来源里（决策器的 skipReason 与错误归类器
	 * 的 outcome），防止未来随手传值导致 Prometheus label 基数爆炸。
	 */
	observeCompactionSkip(reason: CompactionSkipReason | CompactionOutcome): void {
		this.compactionSkips.set(reason, (this.compactionSkips.get(reason) ?? 0) + 1);
	}

	/** 被拒的 prompt。busy_compacting = 压缩在途（短期可重试），与真并发 busy 分开观测。 */
	observePromptRejection(reason: "busy" | "busy_compacting"): void {
		this.promptRejections.set(reason, (this.promptRejections.get(reason) ?? 0) + 1);
	}

	/**
	 * 队列操作观测（steering / followUp）。
	 *
	 * - `enqueue` + ok       = 用户插话进了 vendor 队列（durable 落盘），链路成立
	 * - `enqueue` + rejected = vendor 拒收（Closed / 空消息等），需要回溯为什么队列没接住
	 * - `drain`   + ok       = idle 排空成功接住积压（此前是「发了不理你」的静默丢消息）
	 * - `drain`   + busy     = 撞上其它 operation（压缩在途），积压保留、等下一次时机
	 */
	observeQueueOp(
		op: "enqueue" | "drain",
		kind: "steer" | "followUp",
		outcome: "ok" | "rejected" | "busy" | "empty",
	): void {
		const key = `${op}|${kind}|${outcome}`;
		this.queueOps.set(key, (this.queueOps.get(key) ?? 0) + 1);
	}

	/** usage 事件累计（审计 P0-③）：tokens 按 kind；cost 按 kind 落账。
	 *  费率未配置时 cost 恒 0（vendor calculateCost 产物），指标存在但为 0。 */
	observeUsage(usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
		cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	}): void {
		const bump = (map: Map<string, number>, key: string, delta: number) => {
			if (!Number.isFinite(delta) || delta < 0) return;
			map.set(key, (map.get(key) ?? 0) + delta);
		};
		bump(this.usageTokens, "input", usage.input);
		bump(this.usageTokens, "output", usage.output);
		bump(this.usageTokens, "cache_read", usage.cacheRead);
		bump(this.usageTokens, "cache_write", usage.cacheWrite);
		const c = usage.cost;
		if (!c) return;
		bump(this.usageCost, "input", c.input);
		bump(this.usageCost, "output", c.output);
		bump(this.usageCost, "cache_read", c.cacheRead);
		bump(this.usageCost, "cache_write", c.cacheWrite);
	}

	/** tool_search 搜索语义观测（官方模式健康度）：hit=命中并激活 / miss=未命中只回目录 /
	 *  empty=空 query。activated = 本次激活的工具个数（仅 hit 非零）。 */
	observeToolSearch(outcome: "hit" | "miss" | "empty", activated: number): void {
		this.toolSearchCalls.set(outcome, (this.toolSearchCalls.get(outcome) ?? 0) + 1);
		if (activated > 0) this.toolSearchActivated += activated;
	}

	/** 压缩摘要必需段缺失观测（审计 #6）：section 取 REQUIRED_SECTIONS 原文；纯告警不阻断。 */
	observeCompactionSummaryGap(sections: string[]): void {
		for (const s of sections) {
			this.compactionGaps.set(s, (this.compactionGaps.get(s) ?? 0) + 1);
		}
	}

	setSkillsLoaded(n: number): void {
		this.skillsLoaded = n;
	}
	/** skills index 块的 approx token 数（进程内恒定，启动时设一次；未配置为 0）。 */
	setSkillsPromptTokens(n: number): void {
		this.skillsPromptTokens = n;
	}

	render(activeSessions: number, version: string): string {
		const lines: string[] = [];
		const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		lines.push("# HELP pi_runtime_build_info Build metadata.");
		lines.push("# TYPE pi_runtime_build_info gauge");
		lines.push(`pi_runtime_build_info{version="${esc(version)}"} 1`);

		lines.push("# HELP pi_runtime_uptime_seconds Process uptime in seconds.");
		lines.push("# TYPE pi_runtime_uptime_seconds gauge");
		lines.push(`pi_runtime_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(1)}`);

		lines.push("# HELP pi_runtime_sessions_active Currently active sessions.");
		lines.push("# TYPE pi_runtime_sessions_active gauge");
		lines.push(`pi_runtime_sessions_active ${activeSessions}`);

		// P0-①：显式区分「内存驻留」语义（TTL 回收只看内存；磁盘会话数另由 LRU 扫描决定）。
		lines.push("# HELP pi_runtime_sessions_live Sessions resident in memory.");
		lines.push("# TYPE pi_runtime_sessions_live gauge");
		lines.push(`pi_runtime_sessions_live ${activeSessions}`);

		lines.push("# HELP pi_runtime_session_resumes_total Session create outcomes.");
		lines.push("# TYPE pi_runtime_session_resumes_total counter");
		for (const [outcome, count] of [...this.sessionResumes.entries()].sort()) {
			lines.push(`pi_runtime_session_resumes_total{outcome="${esc(outcome)}"} ${count}`);
		}

		lines.push("# HELP pi_runtime_compactions_total Context compactions by result.");
		lines.push("# TYPE pi_runtime_compactions_total counter");
		for (const [result, count] of [...this.compactions.entries()].sort()) {
			lines.push(`pi_runtime_compactions_total{result="${esc(result)}"} ${count}`);
		}

	lines.push("# HELP pi_runtime_compaction_skips_total Compactions skipped, by reason.");
	lines.push("# TYPE pi_runtime_compaction_skips_total counter");
	for (const [reason, count] of [...this.compactionSkips.entries()].sort()) {
		lines.push(`pi_runtime_compaction_skips_total{reason="${esc(reason)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_compaction_summary_missing_total Compaction summaries missing required sections, by section title.");
	lines.push("# TYPE pi_runtime_compaction_summary_missing_total counter");
	for (const [section, count] of [...this.compactionGaps.entries()].sort()) {
		lines.push(`pi_runtime_compaction_summary_missing_total{section="${esc(section)}"} ${count}`);
	}

		lines.push("# HELP pi_runtime_prompt_rejections_total Prompt rejections by reason.");
		lines.push("# TYPE pi_runtime_prompt_rejections_total counter");
		for (const [reason, count] of [...this.promptRejections.entries()].sort()) {
			lines.push(`pi_runtime_prompt_rejections_total{reason="${esc(reason)}"} ${count}`);
		}

		lines.push("# HELP pi_runtime_queue_ops_total Queue operations (enqueue/drain) by kind and result.");
		lines.push("# TYPE pi_runtime_queue_ops_total counter");
		for (const [key, count] of [...this.queueOps.entries()].sort()) {
			const [op, kind, outcome] = key.split("|");
			lines.push(`pi_runtime_queue_ops_total{op="${esc(op)}",kind="${esc(kind)}",outcome="${esc(outcome)}"} ${count}`);
		}

		lines.push("# HELP pi_runtime_skills_loaded Skills discovered at startup.");
		lines.push("# TYPE pi_runtime_skills_loaded gauge");
		lines.push(`pi_runtime_skills_loaded ${this.skillsLoaded}`);

	lines.push("# HELP pi_runtime_prompt_skills_tokens Approx tokens of the resident skills index block.");
	lines.push("# TYPE pi_runtime_prompt_skills_tokens gauge");
	lines.push(`pi_runtime_prompt_skills_tokens ${this.skillsPromptTokens}`);

	lines.push("# HELP pi_runtime_usage_tokens_total LLM usage tokens by kind (from harness usage events).");
	lines.push("# TYPE pi_runtime_usage_tokens_total counter");
	for (const [kind, v] of [...this.usageTokens.entries()].sort()) {
		lines.push(`pi_runtime_usage_tokens_total{kind="${kind}"} ${v}`);
	}

	lines.push("# HELP pi_runtime_usage_cost_total LLM usage cost (USD) by kind; 0 until cost rates configured.");
	lines.push("# TYPE pi_runtime_usage_cost_total counter");
	for (const [kind, v] of [...this.usageCost.entries()].sort()) {
		lines.push(`pi_runtime_usage_cost_total{kind="${kind}"} ${v.toFixed(6)}`);
	}

	lines.push("# HELP pi_runtime_tool_search_calls_total tool_search invocations by search outcome.");
	lines.push("# TYPE pi_runtime_tool_search_calls_total counter");
	for (const [outcome, count] of [...this.toolSearchCalls.entries()].sort()) {
		lines.push(`pi_runtime_tool_search_calls_total{outcome="${esc(outcome)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_tool_search_activated_total Deferred tools activated via tool_search (cumulative count).");
	lines.push("# TYPE pi_runtime_tool_search_activated_total counter");
	lines.push(`pi_runtime_tool_search_activated_total ${this.toolSearchActivated}`);

		lines.push("# HELP pi_runtime_http_requests_total HTTP requests processed.");
		lines.push("# TYPE pi_runtime_http_requests_total counter");
		for (const [key, count] of [...this.httpTotal.entries()].sort()) {
			const [route, method, status] = key.split("|");
			lines.push(`pi_runtime_http_requests_total{route="${esc(route)}",method="${method}",status="${status}"} ${count}`);
		}

		lines.push("# HELP pi_runtime_http_request_duration_seconds HTTP request latency in seconds.");
		lines.push("# TYPE pi_runtime_http_request_duration_seconds histogram");
		for (const [route, h] of [...this.httpHist.entries()].sort()) {
			for (let i = 0; i < HIST_BUCKETS.length; i++) {
				lines.push(`pi_runtime_http_request_duration_seconds_bucket{route="${esc(route)}",le="${HIST_BUCKETS[i]}"} ${h.buckets[i]}`);
			}
			lines.push(`pi_runtime_http_request_duration_seconds_bucket{route="${esc(route)}",le="+Inf"} ${h.count}`);
			lines.push(`pi_runtime_http_request_duration_seconds_sum{route="${esc(route)}"} ${h.sum.toFixed(4)}`);
			lines.push(`pi_runtime_http_request_duration_seconds_count{route="${esc(route)}"} ${h.count}`);
		}

		lines.push("# HELP pi_runtime_llm_prompt_errors_total Prompt-stage failures by reason.");
		lines.push("# TYPE pi_runtime_llm_prompt_errors_total counter");
		for (const [reason, count] of [...this.promptErrors.entries()].sort()) {
			lines.push(`pi_runtime_llm_prompt_errors_total{reason="${esc(reason)}"} ${count}`);
		}

		lines.push("# HELP pi_runtime_tool_calls_total Tool invocations by tool and result.");
		lines.push("# TYPE pi_runtime_tool_calls_total counter");
		for (const [key, count] of [...this.toolCalls.entries()].sort()) {
			const [tool, result, kind] = key.split("|");
			const labels =
				kind !== undefined
					? `tool="${esc(tool)}",result="${esc(result)}",kind="${esc(kind)}"`
					: `tool="${esc(tool)}",result="${esc(result)}"`;
			lines.push(`pi_runtime_tool_calls_total{${labels}} ${count}`);
		}

		lines.push("# HELP pi_runtime_tool_result_bytes Tool result size returned to the model (serialized bytes).");
		lines.push("# TYPE pi_runtime_tool_result_bytes histogram");
		for (const [tool, h] of [...this.toolResultBytes.entries()].sort()) {
			for (let i = 0; i < BYTES_BUCKETS.length; i++) {
				lines.push(`pi_runtime_tool_result_bytes_bucket{tool="${esc(tool)}",le="${BYTES_BUCKETS[i]}"} ${h.buckets[i]}`);
			}
			lines.push(`pi_runtime_tool_result_bytes_bucket{tool="${esc(tool)}",le="+Inf"} ${h.count}`);
			lines.push(`pi_runtime_tool_result_bytes_sum{tool="${esc(tool)}"} ${h.sum.toFixed(0)}`);
			lines.push(`pi_runtime_tool_result_bytes_count{tool="${esc(tool)}"} ${h.count}`);
		}

		return `${lines.join("\n")}\n`;
	}
}

/** build_info 版本：部署时由 chart env PI_RUNTIME_VERSION 注入（与镜像 tag 对齐），未设置回退 dev。 */
export const VERSION = process.env.PI_RUNTIME_VERSION ?? "dev";

/** 把 request.url 归一成 route 模板（/sessions/:id/prompt），避免 label 基数爆炸。 */
export function routeLabel(url: string): string {
	const path = url.split("?")[0];
	const parts = path.split("/").filter(Boolean);
	if (parts.length === 0) return "root";
	if (parts[0] !== "sessions") return parts[0]; // healthz / readyz / metrics
	if (parts.length === 1) return "sessions";
	// /sessions/:id 或 /sessions/:id/<action>
	const action = parts.length >= 3 ? `/${parts[2].replace(/[^a-z]/gi, "")}` : "";
	return `sessions/:id${action}`;
}
