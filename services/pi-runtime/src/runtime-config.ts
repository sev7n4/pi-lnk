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

/** 正整数解析：非法（非数字 / 0 / 负数 / 空）一律回退，小数截断。 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
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
