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
	};
}
