/**
 * 运行期配置单一解析处（spec §5.6）。
 *
 * 归口理由：TTL / 磁盘上限 / compaction 参数此前没有归属地（env 读取散落在
 * session-manager / model-assembly / index 三处），新增参数无处可放。
 */
import { join } from "node:path";
import type { CompactionSettings, QueueMode } from "@earendil-works/pi-agent-core";

/**
 * 队列模式解析（2026-10-02 steering/followUp 接入口）。
 *
 * ⚠️ 历史化石：charts/pi-lnk-runtime/templates/configmap.yaml 曾写
 * `"steeringMode":"one-at-a-time"` / `"followUpMode":"one-at-a-time"`，但 `RuntimeConfig`
 * 无这两个字段、建 harness 时也不传、deployment 还没挂载这个 configmap —— 是一处**死配置**，
 * 实际生效值统统是 vendor 的 durable 默认 `"all"`（harness.ts:66-67），与配置字面**方向相反**。
 * 本次把它收进 env 口径（与其余 PI_RUNTIME_* 同构，helm `--set-string` 可管），
 * configmap 里那两行随之删除，不再留下"写了没人读"的化石。
 */
const QUEUE_MODES = new Set(["all", "one-at-a-time"]);

export function parseQueueMode(raw: string | undefined, fallback: QueueMode): QueueMode {
	if (raw === undefined) return fallback;
	const v = raw.trim().toLowerCase();
	return (QUEUE_MODES.has(v) ? v : fallback) as QueueMode;
}

/** 默认队列模式：`one-at-a-time`（每轮至多注入一条 steer/followUp，避免用户连发时灌爆上下文）。 */
export const DEFAULT_QUEUE_MODE: QueueMode = "one-at-a-time";

export interface CompactionConfig {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/**
	 * 触发点 = 有效窗口 × targetRatio（审计 P0-①，行业口径 0.6~0.7）。
	 * 显式设置 PI_RUNTIME_COMPACTION_RESERVE_TOKENS 时本字段失效（旧口径优先）。
	 */
	targetRatio?: number;
}

export interface RuntimeConfig {
	dataRoot: string;
	/** 内存句柄 idle 回收阈值（磁盘永不因 TTL 删除）。 */
	sessionTtlMs: number;
	/** sweeper 扫描周期。 */
	sweepIntervalMs: number;
	sessionsMaxBytes: number;
	sessionsMaxCount: number;
	compaction: CompactionConfig;
	/**
	 * 工具渐进加载开关（审计 P0-④）。off = 全量常驻、无 load_tools、无延迟索引块
	 * （行为与本开关引入前逐字节一致）。缺省 true。
	 */
	toolTiering?: boolean;
	/**
	 * 信任边界开关（审计 #8）。off = 不注册 transform_context hook，进 LLM 前不做
	 * 目标复述与工具结果来源标注（行为与本开关引入前逐字节一致）。缺省 true。
	 */
	trustBoundary?: boolean;
	/**
	 * dynamicBlocks 预算开关（T3）。off = composeSystemPrompt 不做预算截断
	 * （行为与本开关引入前逐字节一致）。缺省 true。
	 */
	dynamicBudget?: boolean;
	/** dynamicBlocks 总预算（chars，≈CJK token/4 口径）。缺省 48000。 */
	dynamicBudgetTotalChars?: number;
	/**
	 * 多模态直通开关（T1）。off = prompt 载荷里的 images 字段被忽略
	 * （lane.prompt 第二参恒 undefined，行为与本开关引入前一致）。缺省 true。
	 */
	directImages?: boolean;
	/** before_payload 历史图片保留轮数（T2）。缺省 2，调大=少裁剪。 */
	directImageHistoryRounds?: number;
	/**
	 * 压缩保留段开关（Round2 判断 4 / 首轮 P2-1）。off = `lane.compact` 传 `undefined`
	 * （摘要 prompt 与本开关引入前逐字节一致）。缺省 true。
	 */
	compactionRetention?: boolean;
	/**
	 * 工具结果统一上限开关（审计「缺统一上限」）。off = after_tool 不做预算截断
	 * （行为与本开关引入前逐字节一致）。缺省 true。
	 */
	toolResultBudget?: boolean;
	/** 单条工具结果的字符上限。缺省 24000（高于现存各工具自带截断，只兜异常值）。 */
	toolResultMaxChars?: number;
	/**
	 * steering 队列消费模式（vendor `AgentHarnessOptions.steeringMode`）。
	 *
	 * "all" = 每个 turn 边界把队列里**全部** steer 一次性注入；"one-at-a-time" = 每轮只注入
	 * 第一条、其余留到下一轮（vendor 称 "silent deferral of late steer"，boundary.ts:86）。
	 * 本项目默认 one-at-a-time：用户连发多条时逐轮消化，而不是一轮灌满整条上下文。
	 */
	steeringMode: QueueMode;
	/** followUp 队列消费模式（vendor `AgentHarnessOptions.followUpMode`）。缺省同 steeringMode 口径。 */
	followUpMode: QueueMode;
	/**
	 * 压缩判定用的上下文窗口覆盖值；缺省表示沿用 model.contextWindow 的声明值。
	 *
	 * 存在理由：agnes provider 把 contextWindow 声明为 1_000_000，使默认阈值
	 * `1_000_000 - 16_384` 永不触及——接通触发而不过载此值时表现为「代码在跑但生产
	 * 从不压缩」，极易被误判为已修好（2026-09-30 诊断 F-01 · Review Focus #1）。
	 */
	compactionContextWindow?: number;
	/**
	 * 运行期无进展看护开关（2026-10-07生产事故 P1）。缺省 true。
	 *
	 * ⚠️ 这**不是**provider 请求超时：`openai@6` 客户端自带 `DEFAULT_TIMEOUT = 600000`
	 * （10min，`client.js:695`）已兜住 HTTP 层挂起，所以再调 `streamOptions.timeoutMs`
	 * 只是改这个总数、且会连带砍掉正常的长生成 —— 那条路是错的。
	 * 真正缺的是「不依赖卡在哪一层」的看护：会话在跑却长时间零事件 ⇒ 强制结算。
	 */
	stallWatchdog?: boolean;
	/**
	 * 无进展判定阈值（ms）：处于 prompting/compacting 且**没有任何 harness 事件**
	 * 超过这么久 ⇒ 判定卡死并强制结算。缺省 900_000（15min）。
	 *
	 * 取值权衡：必须**明显大于** openai SDK 的 10min 默认超时，否则会抢在 SDK 之前
	 * 砍掉正在正常流式返回（长 reasoning / 大画布轮）的一轮；15min 让 SDK 先走完它
	 * 自己的错误路径，看护只兜「SDK 兜不住」的那些（卡在 effect_pending / hook / 工具）。
	 */
	stallWatchdogMs?: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
	dataRoot: process.env.PI_RUNTIME_DATA_DIR ?? join(process.cwd(), ".pi-runtime-data"),
	sessionTtlMs: 1_800_000,
	sweepIntervalMs: 300_000,
	sessionsMaxBytes: 3_221_225_472,
	sessionsMaxCount: 200,
	// 与 vendor DEFAULT_COMPACTION_SETTINGS 同值：显式化以便配置面可见可调。
	// targetRatio 0.7：触发点 = 有效窗口 70%（agnes 与 BYOK 两渠道口径拉齐，审计 P0-①）。
	compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, targetRatio: 0.7 },
	steeringMode: DEFAULT_QUEUE_MODE,
	followUpMode: DEFAULT_QUEUE_MODE,
	stallWatchdog: true,
	stallWatchdogMs: 900_000,
};

/** 正整数解析：非法（非数字 / 0 / 负数 / 空）一律回退，小数截断。
 *
 * ⚠️ 必须用 `Number` 而非 `parseInt`（P0-B，2026-09-29）：helm 把 release values
 * 反序列化成 float64，Go 模板 `%v` 会把大数渲染成**科学计数法**（实测
 * `PI_RUNTIME_SESSION_TTL_MS=1.8e+06`、`SESSIONS_MAX_BYTES=3.221225472e+09`），
 * `parseInt("1.8e+06")` 只取前导整数 → **1**（TTL 变 1ms）、`parseInt("3.22e+09")` → **3**。
 * `Number` 能正确解析两种写法；非数字（含 `"12abc"`）返回 NaN → 走回退（比 parseInt 更严）。
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Math.trunc(Number(raw));
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	const v = raw.trim().toLowerCase();
	if (TRUE_VALUES.has(v)) return true;
	if (FALSE_VALUES.has(v)) return false;
	return fallback;
}

export function loadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
	const d = DEFAULT_RUNTIME_CONFIG;
	return {
		dataRoot: env.PI_RUNTIME_DATA_DIR ?? d.dataRoot,
		sessionTtlMs: parsePositiveInt(env.PI_RUNTIME_SESSION_TTL_MS, d.sessionTtlMs),
		sweepIntervalMs: parsePositiveInt(env.PI_RUNTIME_SESSION_SWEEP_MS, d.sweepIntervalMs),
		sessionsMaxBytes: parsePositiveInt(env.PI_RUNTIME_SESSIONS_MAX_BYTES, d.sessionsMaxBytes),
		sessionsMaxCount: parsePositiveInt(env.PI_RUNTIME_SESSIONS_MAX_COUNT, d.sessionsMaxCount),
		compaction: (() => {
			const enabled = parseBool(env.PI_RUNTIME_COMPACTION_ENABLED, d.compaction.enabled);
			const reserveTokens = parsePositiveInt(env.PI_RUNTIME_COMPACTION_RESERVE_TOKENS, d.compaction.reserveTokens);
			const keepRecentTokens = parsePositiveInt(
				env.PI_RUNTIME_COMPACTION_KEEP_RECENT_TOKENS,
				d.compaction.keepRecentTokens,
			);
			// 显式 RESERVE_TOKENS = 旧口径（审计前行为），targetRatio 失效——两者只留一个权威。
			if (env.PI_RUNTIME_COMPACTION_RESERVE_TOKENS !== undefined && env.PI_RUNTIME_COMPACTION_RESERVE_TOKENS.trim() !== "") {
				return { enabled, reserveTokens, keepRecentTokens, targetRatio: undefined };
			}
			const raw = env.PI_RUNTIME_COMPACTION_TARGET_RATIO;
			let targetRatio = d.compaction.targetRatio;
			if (raw !== undefined && raw.trim() !== "") {
				const n = Number(raw);
				targetRatio = Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
			}
			return { enabled, reserveTokens, keepRecentTokens, targetRatio };
		})(),
		// 未配置 / 非法值一律 undefined（= 沿用 model 声明值）。刻意不给 fallback 一个真实数，
		// 否则「没配」与「配了非法值」不可区分。
	compactionContextWindow: parsePositiveInt(env.PI_RUNTIME_COMPACTION_CONTEXT_WINDOW, 0) || undefined,
	toolTiering: parseBool(env.PI_RUNTIME_TOOL_TIERING, true),
	trustBoundary: parseBool(env.PI_RUNTIME_TRUST_BOUNDARY, true),
	dynamicBudget: parseBool(env.PI_RUNTIME_DYNAMIC_BUDGET, true),
	directImages: parseBool(env.PI_RUNTIME_DIRECT_IMAGES, true),
	directImageHistoryRounds: parsePositiveInt(env.PI_RUNTIME_DIRECT_IMAGE_HISTORY_ROUNDS, 2),
	dynamicBudgetTotalChars: parsePositiveInt(env.PI_RUNTIME_DYNAMIC_BUDGET_TOTAL_CHARS, 48_000),
		compactionRetention: parseBool(env.PI_RUNTIME_COMPACTION_RETENTION, true),
		toolResultBudget: parseBool(env.PI_RUNTIME_TOOL_RESULT_BUDGET, true),
		toolResultMaxChars: parsePositiveInt(env.PI_RUNTIME_TOOL_RESULT_MAX_CHARS, 24_000),
		// steering/followUp 队列模式（2026-10-02 由 configmap 化石收编为 env 口径）
		steeringMode: parseQueueMode(env.PI_RUNTIME_STEERING_MODE, d.steeringMode),
		followUpMode: parseQueueMode(env.PI_RUNTIME_FOLLOW_UP_MODE, d.followUpMode),
		stallWatchdog: parseBool(env.PI_RUNTIME_STALL_WATCHDOG, true),
		stallWatchdogMs: parsePositiveInt(env.PI_RUNTIME_STALL_WATCHDOG_MS, d.stallWatchdogMs ?? 900_000),
	};
}

/**
 * 压缩触发的有效设置（审计 P0-①）：触发点 = 有效窗口 × targetRatio。
 *
 * reserveTokens 由窗口反推（= window × (1 − ratio)），floor 16384 保住「摘要 prompt +
 * 输出」的头寸语义，cap = window − keepRecent − 1 防极小窗口出现负数 / 永不触发。
 * window 必须传**有效窗口**（compactionContextWindow ?? model.contextWindow）。
 * ⚠️ 阈值口径只由 post-run hook（decideCompaction）遵循本函数；vendor 的中途自动
 * 压缩路径（drive/structural.ts:1144）固定用 model.contextWindow 作分母，只读 vendor
 * 无法对齐——**不要**因「reserveTokens 同源」就认为两条路径等价而删掉 post-run hook，
 * 那会让中途压缩退回 ~96% 才触发（正是 F-01 诊断的病灶形态）。
 * targetRatio 缺失/非法时走旧口径（显式 reserveTokens），行为与审计前逐字节一致。
 */
export function effectiveCompactionSettings(
	compaction: CompactionConfig,
	contextWindow: number,
): CompactionSettings {
	if (!compaction.enabled) {
		return { enabled: false, reserveTokens: 0, keepRecentTokens: compaction.keepRecentTokens };
	}
	if (compaction.targetRatio === undefined || compaction.targetRatio <= 0 || compaction.targetRatio >= 1) {
		return {
			enabled: true,
			reserveTokens: compaction.reserveTokens,
			keepRecentTokens: compaction.keepRecentTokens,
		};
	}
	const keepRecentTokens = Math.min(compaction.keepRecentTokens, Math.floor(contextWindow / 2));
	// round 而非 ceil：1M×0.3 在浮点下是 300000.00000000006，ceil 会多出 1（可观测性断言会咬）。
	const byRatio = Math.round(contextWindow * (1 - compaction.targetRatio));
	// cap 在 floor 之内收敛：极小窗口（如 BYOK 自报 8k）下 floor 会让 reserve ≥ window（永不触发），
	// 此时取 cap 本身——压缩几乎立即触发是 8k 窗口下唯一安全的行为，但绝不产生负数。
	const reserveTokens = Math.min(Math.max(byRatio, 16_384), contextWindow - keepRecentTokens - 1);
	return { enabled: true, reserveTokens, keepRecentTokens };
}

/** B-1/B-5：阻塞式确认类工具开关（ask_user / propose_generation）。off = 退回非阻塞 v1 行为。 */
export function askUserBlocking(env: Record<string, string | undefined> = process.env): boolean {
	return parseBool(env.ASK_USER_BLOCKING, true);
}

/**
 * B-1：阻塞等待上限，缺省 **5min**（2026-10-01 由 30min 下调）。
 *
 * 下调理由（生产实证）：30min 的等待在 UI 上就是「生成回复中 · 1800s」——用户判定卡死、
 * 反复点停止/重发（同一会话两次实证：10:18 轮 38min 无果、12:23 轮 931s 即被举报）。
 * 超时不是失败：工具以带 status 的正常值交还，模型拿到「用户未响应」后自主续行，
 * 用户之后仍可作答/确认。5min 足以完成「看一眼画布 → 点确认」，又不会把一轮对话冻住。
 * ⚠️ helm 部署必须 --set-string（科学计数法事故）。
 */
export function askUserTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	return parsePositiveInt(env.ASK_USER_TIMEOUT_MS, 300_000);
}

/** C3 Plan 确认门开关（spec §3.7）：off = propose_plan 不注册 + gate 不拦 + followUp 不注入。
 * 已知降级：task_tool.md 点名悬空 → 模型直调吃 vendor unavailable error 后自行回退（仅止血用）。 */
export function planGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseBool(env.PI_RUNTIME_PLAN_GATE, true);
}
