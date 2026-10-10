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
 *   - pi_runtime_skill_loads_total{skill,outcome}       load_skill 按技能名的路由计数（ok/unknown/read_error）
 *   - pi_runtime_queue_ops_total{op,kind,outcome}       steer/followUp 队列操作计数
 *   - pi_runtime_pending_ops_total{tool,status}         阻塞等待结算（answered/timeout/aborted）
 *   - pi_runtime_tool_search_activated_total            经 tool_search 激活的延迟工具数累计
 *   - pi_runtime_build_info / pi_runtime_uptime_seconds
 */

// type-only：擦除后不留运行时依赖，只把 reason 的取值域锁到决策器的两个来源上。
import type { CompactionOutcome, CompactionSkipReason } from "./compaction-check.js";
import { ToolMetrics } from "./tool-metrics.js";

const HIST_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

/**
 * prompt 版本指纹（Nest 侧 `PromptManifest` 的可观测子集）。
 *
 *⚠️ 字段全是「可能缺失」：旧 Nest 不传（灰度期）、直连 runtime 的测试不传。
 * 故消费方一律按 `n/a` 兜底，不做必填假设。
 */
export interface PromptInfo {
	/** 提示词内容版本（规则/Registry 内容变更时由 Nest bump）。 */
	promptVersion?: string;
	/** 本轮拼装结果的稳定哈希（判「同一批请求是否同一版」）。 */
	promptHash?: string;
	/** Registry 自身版本（规则资产的版本，与拼装结果区分）。 */
	registryVersion?: string;
	/** Registry 内容哈希（判「规则文件被谁改过」）。 */
	registryHash?: string;
}

/** 工具结果体积直方图桶（字节）（③：工具结果 token 观测的原始量）。 */
const BYTES_BUCKETS = [256, 1024, 4096, 16384, 65536, 262144, 1_048_576];

/**
 * 工具调用的结果与错误分类（③）；`retry` 为 V-γ 重试放行打点（非错误）。
 *
 * ⚠️ 本类型现在只是 `pi_runtime_tool_error_kinds_total` 的**label 取值域**。
 * 计数职责已移交事件层的 `ToolMetrics`（见 `tool-metrics.ts`），
 * `observeToolCall` / `tool_calls_total` 的旧渲染方已于 2026-10-04 删除
 * （两者同时渲染会让 Prometheus 报 `second HELP line for metric name` 并丢弃整个指标）。
 * `gate_blocked` / `retry` 暂无写入方：HITL 拦截与重试放行的归因改由
 * `retry_scheduled` 事件驱动 `pi_runtime_llm_retries_total` 承担。
 */
export type ToolErrorKind =
	| "upstream_4xx" | "upstream_5xx" | "envelope" | "timeout" | "network" | "gate_blocked" | "retry" | "circuit_open";

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
	private toolResultBytes = new Map<string, HistogramState>(); // key: tool
	/** key: tool|kind —— Nest 侧结构化错误分类（计数职责在事件层，这里只留精确分类通道）。 */
	private toolErrorKinds = new Map<string, number>();
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
	private pendingOps = new Map<string, number>(); // key: tool|status
	private planProposed = 0; // C3 propose_plan 调用数
	private planDecisions = new Map<string, number>(); // key: decision (execute|refine|keep|timeout|aborted)
	private planGateBlocked = new Map<string, number>(); // key: tool——planPending 期间被拦的写工具
	private turnBudgetWarned = 0; // C2 预算将尽 steer 提醒次数
	private turnBudgetExceeded = 0; // C2 超限硬停次数
	private skillsLoaded = 0;
	private skillsPromptTokens = 0;
	/**
	 * 当前生效的 prompt 版本指纹（P0-3 收尾 / 审计 L-2）。
	 *
	 * ⭐ 为什么 Nest 侧算了 manifest 还不够：Nest 只打 `logger.log`，
	 * 生产侧**无法按版本区间聚合查询**「09:00–09:30 那批请求用的哪版提示词」。
	 * 首轮审计原话：「出一次『假称已出图』事故，事后无法回答那批请求用的是不是
	 * 同一版提示词，回溯链条断在最关键一环」—— 指标才能回答。
	 *
	 * 刻意用 **gauge 而非 counter**（与 `build_info` 同款）：语义是「现在跑的是哪版」，
	 * 不是「历史上一共出现过几版」。历史版本查 git / Nest 日志。
	 * 未设置时**不输出样本行**（与其他 gauge 一致），避免零流量时谎报「版本为空」。
	 */
	private promptInfo: PromptInfo | undefined;
	private usageTokens = new Map<string, number>(); // key: kind (input|output|cache_read|cache_write)
	private usageCost = new Map<string, number>(); // key: kind 同上
	private toolSearchCalls = new Map<string, number>(); // key: outcome (hit|miss|empty)
	private toolSearchActivated = 0; // 命中激活的工具个数累计（配合 calls 可算平均激活数）
	private memorySuppressed = 0; // M6b：被反哺抑制的记忆条数累计（幂等计数）
	private skillLoads = new Map<string, number>(); // key: `${skill}|${outcome}`（ok|unknown|read_error）
	private transformContextRuns = new Map<string, number>(); // key: goal (on|off)——是否注入了目标复述
	private transformAnnotated = 0; // 信任标注覆盖的 toolResult 条数累计
	private dynamicBudgetDrops = new Map<string, number>(); // key: kind (canvas|vision|sidebar|general)——发生截断的块数
	private unknownBlockKind = 0; // 块首标记未识别（约定漂移告警）
	private systemPromptBytes = 0; // 最近一次 systemPrompt 总长（gauge，水位观测）
	private directImages = new Map<string, number>(); // key: outcome (sent|downscaled|fallback)
	private directImageTokens = 0; // 直通图片 token 估算累计（成本闸门观测）
	private payloadTrims = new Map<string, number>(); // key: reason (history_image|overflow|text_overflow)
	private toolResultTrims = new Map<string, number>(); // key: tool（统一上限触发的截断次数）
	private compactionGaps = new Map<string, number>(); // key: 摘要缺失段标题（REQUIRED_SECTIONS 原文）
	private startedAt = Date.now();
	/**
	 * 工具/LLM 指标的事件层结算器（spec §4.1/§4.2）。
	 *
	 * 为什么放在这里而不是各工具内部：harness 的 `tool_start`/`tool_end` 是全工具统一
	 * 事件，载荷自带 toolCallId / isError / terminate ⇒ 39 个工具零改动全覆盖。
	 * 它是 `pi_runtime_tool_calls_total` 的**唯一渲染方**（旧的 `kind` label 渲染块已删，
	 * 否则同名指标出现两行 HELP 会让 Prometheus 丢弃整个指标）。
	 */
	// 字段名刻意带 `Settler` 后缀：不能叫 `toolMetrics`——那会与下面的
	// `toolMetrics()` 方法同名，类字段定义会覆盖原型方法（实测 `metrics.toolMetrics
	// is not a function`，7/9 用例红）。
	private readonly toolMetricsSettler = new ToolMetrics();

	/**
	 * 事件层结算器。**生产代码也调它**（`session-manager.ts` 的 `attachEvents` 喂事件），
	 * 测试则直接驱动同一实例。
	 *
	 * 刻意**不叫** `toolMetricsForTest()`：本仓 `ForTest` 后缀的既有语义是
	 * 「仅供测试的只读窥视」（见 `tool-metrics.ts` 的 `inflightSizeForTest()`、
	 * `session-manager.ts` 的 `resolveSystemPromptForTest()`），本仓没有任何
	 * 「生产代码调用 `ForTest` 方法」的先例。沿用那个后缀会让后来读者误判可见性边界。
	 */
	toolMetrics(): ToolMetrics {
		return this.toolMetricsSettler;
	}

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

	/**
	 * Nest 侧返回的**结构化**错误分类（`pi_runtime_tool_error_kinds_total{tool,kind}`）。
	 *
	 * 刻意与事件层的 `ToolMetrics` 分开：工具调用的**计数**与**耗时**由事件层统一结算
	 * （`tool_start`/`tool_end` 覆盖全部 39 个工具，见 spec §3.2），但事件层只能靠
	 * `resultText` 正则猜错误类；这里拿到的是 `NestClient` 直接从 HTTP 状态码 /
	 * 包络判定出的 `errorKind`，**更精确**。若一并删掉，Nest 侧的
	 * `gate_blocked`/`upstream_4xx` 归因会退化成正则猜测，错误率分子失真。
	 *
	 * ⚠️ 方法名**不得**改回 `observeToolCall`：那个方法连同 `tool_calls_total`
	 * 的旧渲染方一起删掉了（同名会造成「已删除」判断失效），且它只写本指标，
	 * 不碰 `tool_calls_total`。
	 */
	observeToolErrorKind(tool: string, kind: ToolErrorKind): void {
		const key = `${tool}|${kind}`;
		this.toolErrorKinds.set(key, (this.toolErrorKinds.get(key) ?? 0) + 1);
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

	/**
	 * M6b：反哺抑制的记忆数（累计）。结构性满足 tools/memory.ts 的 `SuppressionObserver` 接口
	 * （#182 解耦时约定的对接点）。调用方 markSuppressed 已做幂等（同 id 只在首标时通知），
	 * 这里只管累加。⚠️ 恒 0 = 标记链路未触发，**不是**「没有污染记忆」。
	 */
	observeMemorySuppressed(): void {
		this.memorySuppressed += 1;
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

	/**
	 * 阻塞等待结算观测（2026-10-02 补：此前 ask_user / propose_generation 一块完全无指标）。
	 *
	 * 这是用户肉眼可见最多的一块（卡片超时、反复被问同一题），此前排障答不出「卡片超时率多少」。
	 * 刻意与 queue_ops 分开：一个在 agent 跑动时的消息通道，一个在等用户输入，超时口径完全不同。
	 */
	observePendingOp(tool: string, status: "answered" | "timeout" | "aborted"): void {
		const key = `${tool}|${status}`;
		this.pendingOps.set(key, (this.pendingOps.get(key) ?? 0) + 1);
	}

	/** C3 Plan 确认门观测（spec §3.7）：proposed/decision 在工具层，blocked 在 before_tool 层。 */
	observePlanProposed(): void {
		this.planProposed += 1;
	}

	observePlanDecision(decision: string): void {
		this.planDecisions.set(decision, (this.planDecisions.get(decision) ?? 0) + 1);
	}

	observePlanGateBlocked(tool: string): void {
		this.planGateBlocked.set(tool, (this.planGateBlocked.get(tool) ?? 0) + 1);
	}

	/** C2 turnBudget 观测（spec §3.5）：warned 在事件层软着陆时，exceeded 在硬停时。 */
	observeTurnBudgetWarned(): void {
		this.turnBudgetWarned += 1;
	}

	observeTurnBudgetExceeded(): void {
		this.turnBudgetExceeded += 1;
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

	/**
	 * load_skill 路由观测（Round2 W2② / 首轮 P1-6 前置判据）：按**技能名**分组，而非只计调用次数。
	 *
	 * 为什么不能只看 `tool_calls_total{tool="load_skill"}`：那只回答"调了几次"，
	 * 而 P1-6 要回答"**路由对不对**"——unknown 占比高说明模型在猜名字，
	 * ok 的分布则说明哪些 skill 是真实热点（决定该给谁补触发 fixture）。
	 *
	 * outcome：ok=正文读取成功 / unknown=索引里没这个名字 / read_error=条目存在但正文读失败。
	 */
	observeSkillLoad(skill: string, outcome: "ok" | "unknown" | "read_error"): void {
		const key = `${skill}|${outcome}`;
		this.skillLoads.set(key, (this.skillLoads.get(key) ?? 0) + 1);
	}

	/** dynamicBlocks 预算观测（T3）：kind=发生截断的块类别；unknownKind=块首标记未识别（约定漂移）。 */
	observeDynamicBudgetDrop(kind: string): void {
		this.dynamicBudgetDrops.set(kind, (this.dynamicBudgetDrops.get(kind) ?? 0) + 1);
	}

	observeUnknownBlockKind(): void {
		this.unknownBlockKind += 1;
	}

	/** 直通图片观测（T1）：outcome 计数 + token 估算累计。 */
	observeDirectImage(outcome: "sent" | "downscaled" | "fallback", tokensEst: number): void {
		this.directImages.set(outcome, (this.directImages.get(outcome) ?? 0) + 1);
		this.directImageTokens += tokensEst;
	}

	/** before_payload 治理观测（T2）：被降级/截断的 part 计数。 */
	observeBeforePayloadTrim(reason: string): void {
		this.payloadTrims.set(reason, (this.payloadTrims.get(reason) ?? 0) + 1);
	}

	/**
	 * 工具结果统一上限触发的截断（审计「缺统一上限」）。
	 * 未打点时 Map 为空 ⇒ 不渲染数据行，使「从未超预算」与「超了但计数为 0」可区分。
	 */
	observeToolResultTrim(tool: string): void {
		this.toolResultTrims.set(tool, (this.toolResultTrims.get(tool) ?? 0) + 1);
	}

	/** systemPrompt 总长水位（static+dynamic），每次组装后刷新（gauge 语义：取最新值）。 */
	observeSystemPromptBytes(n: number): void {
		this.systemPromptBytes = n;
	}

	/** transform_context 观测（审计 #8）：goalReinjected=本轮是否注入目标复述；annotated=信任标注条数。 */
	observeTransformContext(goalReinjected: boolean, annotated: number): void {
		const key = goalReinjected ? "on" : "off";
		this.transformContextRuns.set(key, (this.transformContextRuns.get(key) ?? 0) + 1);
		if (annotated > 0) this.transformAnnotated += annotated;
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

	/**
	 * 记录当前 prompt 版本指纹（Nest 侧每轮随 turnContext 送来）。
	 *
	 * 后写覆盖先写（gauge 语义）。缺字段由 render 补 `n/a`——
	 * ⭐ **不能省略标签**：标签集随字段有无而变会让同名指标有时 4 标签、有时 2 标签，
	 * Prometheus 侧就查不出来了。
	 */
	setPromptInfo(info: PromptInfo): void {
		this.promptInfo = info;
	}

	render(activeSessions: number, version: string): string {
		const lines: string[] = [];
		const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		lines.push("# HELP pi_runtime_build_info Build metadata.");
		lines.push("# TYPE pi_runtime_build_info gauge");
		lines.push(`pi_runtime_build_info{version="${esc(version)}"} 1`);

		// prompt 版本指纹（P0-3 / L-2）。未设置时只出 HELP/TYPE，不出样本行——
		// 与其他 gauge 同口径：零流量时不谎报「当前是空版本」（否则告警会永远 firing）。
		lines.push("# HELP pi_runtime_prompt_info Current prompt version fingerprint (labels are stable; missing values are n/a).");
		lines.push("# TYPE pi_runtime_prompt_info gauge");
		if (this.promptInfo) {
			const info = this.promptInfo;
			// ⭐ 标签集恒定四项，缺失填 n/a —— 缺一个就换标签集会让指标查不出来。
			lines.push(
				`pi_runtime_prompt_info{promptVersion="${esc(info.promptVersion || "n/a")}",promptHash="${esc(info.promptHash || "n/a")}",registryVersion="${esc(info.registryVersion || "n/a")}",registryHash="${esc(info.registryHash || "n/a")}"} 1`,
			);
		}

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

		// M6b：恒渲染（0 也出样本），让「链路从未触发」与「指标缺失」可区分。
		lines.push("# HELP pi_runtime_memory_suppressed_total Memories suppressed by feedback loop.");
		lines.push("# TYPE pi_runtime_memory_suppressed_total counter");
		lines.push(`pi_runtime_memory_suppressed_total ${this.memorySuppressed}`);

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

	lines.push("# HELP pi_runtime_pending_ops_total Blocking-wait settlements (user answered / timeout / aborted).");
	lines.push("# TYPE pi_runtime_pending_ops_total counter");
	for (const [key, count] of [...this.pendingOps.entries()].sort()) {
		const [tool, status] = key.split("|");
		lines.push(`pi_runtime_pending_ops_total{tool="${esc(tool)}",status="${esc(status)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_plan_proposed_total propose_plan invocations (C3 plan gate).");
	lines.push("# TYPE pi_runtime_plan_proposed_total counter");
	lines.push(`pi_runtime_plan_proposed_total ${this.planProposed}`);

	lines.push("# HELP pi_runtime_plan_decisions_total Plan confirmation outcomes by decision.");
	lines.push("# TYPE pi_runtime_plan_decisions_total counter");
	for (const [decision, count] of [...this.planDecisions.entries()].sort()) {
		lines.push(`pi_runtime_plan_decisions_total{decision="${esc(decision)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_plan_gate_blocked_total Write tools blocked by the plan gate, by tool.");
	lines.push("# TYPE pi_runtime_plan_gate_blocked_total counter");
	for (const [tool, count] of [...this.planGateBlocked.entries()].sort()) {
		lines.push(`pi_runtime_plan_gate_blocked_total{tool="${esc(tool)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_turn_budget_warned_total Turn-budget nearing-exhaustion steer warnings (C2).");
	lines.push("# TYPE pi_runtime_turn_budget_warned_total counter");
	lines.push(`pi_runtime_turn_budget_warned_total ${this.turnBudgetWarned}`);

	lines.push("# HELP pi_runtime_turn_budget_exceeded_total Runs hard-stopped by the turn budget (C2).");
	lines.push("# TYPE pi_runtime_turn_budget_exceeded_total counter");
	lines.push(`pi_runtime_turn_budget_exceeded_total ${this.turnBudgetExceeded}`);

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

	// 与 tool_search 同形态：counter 型 Map 为空时不渲染数据行，使「从未触发」与「触发过但 0」可区分。
	lines.push("# HELP pi_runtime_skill_loads_total load_skill invocations by requested skill name and outcome.");
	lines.push("# TYPE pi_runtime_skill_loads_total counter");
	for (const [key, count] of [...this.skillLoads.entries()].sort()) {
		const [skill, outcome] = key.split("|");
		lines.push(`pi_runtime_skill_loads_total{skill="${esc(skill ?? "")}",outcome="${esc(outcome ?? "")}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_dynamic_budget_drops_total dynamicBlocks truncated by kind budget (cumulative count).");
	lines.push("# TYPE pi_runtime_dynamic_budget_drops_total counter");
	for (const [kind, count] of [...this.dynamicBudgetDrops.entries()].sort()) {
		lines.push(`pi_runtime_dynamic_budget_drops_total{kind="${esc(kind)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_dynamic_budget_unknown_kind_total dynamicBlocks with unrecognized header marker (convention drift warning).");
	lines.push("# TYPE pi_runtime_dynamic_budget_unknown_kind_total counter");
	lines.push(`pi_runtime_dynamic_budget_unknown_kind_total ${this.unknownBlockKind}`);

	lines.push("# HELP pi_runtime_system_prompt_bytes Last composed systemPrompt total length (static+dynamic).");
	lines.push("# TYPE pi_runtime_system_prompt_bytes gauge");
	lines.push(`pi_runtime_system_prompt_bytes ${this.systemPromptBytes}`);

	lines.push("# HELP pi_runtime_direct_images_total Direct-prompt images by outcome (sent = forwarded to lane.prompt).");
	lines.push("# TYPE pi_runtime_direct_images_total counter");
	for (const [outcome, count] of [...this.directImages.entries()].sort()) {
		lines.push(`pi_runtime_direct_images_total{outcome="${esc(outcome)}"} ${count}`);
	}
	lines.push("# HELP pi_runtime_direct_image_tokens_estimated Cumulative estimated token cost of direct images.");
	lines.push("# TYPE pi_runtime_direct_image_tokens_estimated counter");
	lines.push(`pi_runtime_direct_image_tokens_estimated ${this.directImageTokens}`);

	lines.push("# HELP pi_runtime_before_payload_trims_total Parts degraded/truncated by before_payload governance, by reason.");
	lines.push("# TYPE pi_runtime_before_payload_trims_total counter");
	for (const [reason, count] of [...this.payloadTrims.entries()].sort()) {
		lines.push(`pi_runtime_before_payload_trims_total{reason="${esc(reason)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_tool_result_trims_total Tool results capped by the unified tool-result budget, by tool.");
	lines.push("# TYPE pi_runtime_tool_result_trims_total counter");
	for (const [tool, count] of [...this.toolResultTrims.entries()].sort()) {
		lines.push(`pi_runtime_tool_result_trims_total{tool="${esc(tool)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_transform_context_runs_total transform_context hook runs, by whether the goal was restated.");
	lines.push("# TYPE pi_runtime_transform_context_runs_total counter");
	for (const [goal, count] of [...this.transformContextRuns.entries()].sort()) {
		lines.push(`pi_runtime_transform_context_runs_total{goal="${esc(goal)}"} ${count}`);
	}

	lines.push("# HELP pi_runtime_transform_context_annotated_total Tool results wrapped with a trust-boundary source header (cumulative count).");
	lines.push("# TYPE pi_runtime_transform_context_annotated_total counter");
	lines.push(`pi_runtime_transform_context_annotated_total ${this.transformAnnotated}`);

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

		lines.push("# HELP pi_runtime_tool_error_kinds_total Tool call error kinds as classified by the Nest client (structured, more precise than the event layer's regex).");
		lines.push("# TYPE pi_runtime_tool_error_kinds_total counter");
		for (const [key, count] of [...this.toolErrorKinds.entries()].sort()) {
			const [tool, kind] = key.split("|");
			lines.push(`pi_runtime_tool_error_kinds_total{tool="${esc(tool ?? "")}",kind="${esc(kind ?? "")}"} ${count}`);
		}

		// 事件层结算器在**尾部追加**：既有指标族的输出顺序与内容逐字不变，只在末尾多出工具/LLM 族。
		this.toolMetricsSettler.renderInto(lines);

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
