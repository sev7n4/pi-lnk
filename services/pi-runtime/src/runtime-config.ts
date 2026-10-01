/**
 * 运行期配置单一解析处（spec §5.6）。
 *
 * 归口理由：TTL / 磁盘上限 / compaction 参数此前没有归属地（env 读取散落在
 * session-manager / model-assembly / index 三处），新增参数无处可放。
 */
import { join } from "node:path";

export interface CompactionConfig {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
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
	 * 压缩判定用的上下文窗口覆盖值；缺省表示沿用 model.contextWindow 的声明值。
	 *
	 * 存在理由：agnes provider 把 contextWindow 声明为 1_000_000，使默认阈值
	 * `1_000_000 - 16_384` 永不触及——接通触发而不过载此值时表现为「代码在跑但生产
	 * 从不压缩」，极易被误判为已修好（2026-09-30 诊断 F-01 · Review Focus #1）。
	 */
	compactionContextWindow?: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
	dataRoot: process.env.PI_RUNTIME_DATA_DIR ?? join(process.cwd(), ".pi-runtime-data"),
	sessionTtlMs: 1_800_000,
	sweepIntervalMs: 300_000,
	sessionsMaxBytes: 3_221_225_472,
	sessionsMaxCount: 200,
	// 与 vendor DEFAULT_COMPACTION_SETTINGS 同值：显式化以便配置面可见可调
	compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
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
		compaction: {
			enabled: parseBool(env.PI_RUNTIME_COMPACTION_ENABLED, d.compaction.enabled),
			reserveTokens: parsePositiveInt(env.PI_RUNTIME_COMPACTION_RESERVE_TOKENS, d.compaction.reserveTokens),
			keepRecentTokens: parsePositiveInt(
				env.PI_RUNTIME_COMPACTION_KEEP_RECENT_TOKENS,
				d.compaction.keepRecentTokens,
			),
		},
		// 未配置 / 非法值一律 undefined（= 沿用 model 声明值）。刻意不给 fallback 一个真实数，
		// 否则「没配」与「配了非法值」不可区分。
		compactionContextWindow: parsePositiveInt(env.PI_RUNTIME_COMPACTION_CONTEXT_WINDOW, 0) || undefined,
	};
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
