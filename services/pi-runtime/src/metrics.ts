/**
 * 最小 Prometheus 指标（spec K2 5xx 率 / K3 p99 的度量入口）
 *
 * 零依赖：直接输出 text/plain; version=0.0.4 文本格式。
 * 覆盖：
 *   - pi_runtime_http_requests_total{route,status}      请求计数（K2 分母/5xx）
 *   - pi_runtime_http_request_duration_seconds{route}   响应耗时直方图（K3 p99）
 *   - pi_runtime_llm_prompt_errors_total{reason}        prompt 阶段错误（429/上游 5xx 等）
 *   - pi_runtime_sessions_active                        活跃会话数 gauge
 *   - pi_runtime_build_info / pi_runtime_uptime_seconds
 */

const HIST_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

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
	private toolCalls = new Map<string, number>(); // key: tool|result
	private skillsLoaded = 0;
	private skillsPromptTokens = 0;
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

	observeToolCall(tool: string, outcome: "ok" | "error" | "circuit_open"): void {
		const key = `${tool}|${outcome}`;
		this.toolCalls.set(key, (this.toolCalls.get(key) ?? 0) + 1);
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

		lines.push("# HELP pi_runtime_skills_loaded Skills discovered at startup.");
		lines.push("# TYPE pi_runtime_skills_loaded gauge");
		lines.push(`pi_runtime_skills_loaded ${this.skillsLoaded}`);

		lines.push("# HELP pi_runtime_prompt_skills_tokens Approx tokens of the resident skills index block.");
		lines.push("# TYPE pi_runtime_prompt_skills_tokens gauge");
		lines.push(`pi_runtime_prompt_skills_tokens ${this.skillsPromptTokens}`);

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
			const [tool, result] = key.split("|");
			lines.push(`pi_runtime_tool_calls_total{tool="${esc(tool)}",result="${result}"} ${count}`);
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
