import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadRuntimeConfig, parseBool, parsePositiveInt, DEFAULT_RUNTIME_CONFIG, askUserBlocking, askUserTimeoutMs, effectiveCompactionSettings } from "./runtime-config.js";

describe("parsePositiveInt", () => {
	it("合法正整数原样返回", () => {
		assert.equal(parsePositiveInt("1800000", 1), 1800000);
	});
	it("非数字 / 0 / 负数 / 空串一律回退", () => {
		assert.equal(parsePositiveInt("abc", 7), 7);
		assert.equal(parsePositiveInt("0", 7), 7);
		assert.equal(parsePositiveInt("-5", 7), 7);
		assert.equal(parsePositiveInt("", 7), 7);
		assert.equal(parsePositiveInt(undefined, 7), 7);
	});
	it("小数截断为整数", () => {
		assert.equal(parsePositiveInt("12.9", 7), 12);
	});
	it("科学计数法按数值解析（P0-B：helm float64 → Go %v 渲染出 1.8e+06）", () => {
		// 修复前 parseInt("1.8e+06") = 1 → TTL 变 1ms；parseInt("3.221225472e+09") = 3 → maxBytes=3
		assert.equal(parsePositiveInt("1.8e+06", 7), 1_800_000);
		assert.equal(parsePositiveInt("3.221225472e+09", 7), 3_221_225_472);
		assert.equal(parsePositiveInt("6e2", 7), 600);
	});
	it("数字后带杂质的串不再被 parseInt 截断（更严：整体必须是数）", () => {
		assert.equal(parsePositiveInt("12abc", 7), 7);
	});
});

describe("parseBool", () => {
	it("true/1/yes/on 为真；false/0/no/off 为假；其余回退", () => {
		assert.equal(parseBool("true", false), true);
		assert.equal(parseBool("1", false), true);
		assert.equal(parseBool("yes", false), true);
		assert.equal(parseBool("on", false), true);
		assert.equal(parseBool("false", true), false);
		assert.equal(parseBool("0", true), false);
		assert.equal(parseBool("no", true), false);
		assert.equal(parseBool("off", true), false);
		assert.equal(parseBool("maybe", true), true);
		assert.equal(parseBool(undefined, true), true);
	});
});

describe("loadRuntimeConfig", () => {
	it("dynamicBudget：缺省 on/48000；off 与非法数值回退", () => {
		const def = loadRuntimeConfig({});
		assert.equal(def.dynamicBudget, true);
		assert.equal(def.dynamicBudgetTotalChars, 48000);
		const off = loadRuntimeConfig({ PI_RUNTIME_DYNAMIC_BUDGET: "off" });
		assert.equal(off.dynamicBudget, false);
		const bad = loadRuntimeConfig({ PI_RUNTIME_DYNAMIC_BUDGET_TOTAL_CHARS: "abc" });
		assert.equal(bad.dynamicBudgetTotalChars, 48000);
		const ok = loadRuntimeConfig({ PI_RUNTIME_DYNAMIC_BUDGET_TOTAL_CHARS: "24000" });
		assert.equal(ok.dynamicBudgetTotalChars, 24000);
	});
	it("空 env 返回默认值", () => {
		const cfg = loadRuntimeConfig({});
		assert.equal(cfg.sessionTtlMs, DEFAULT_RUNTIME_CONFIG.sessionTtlMs);
		assert.equal(cfg.sweepIntervalMs, DEFAULT_RUNTIME_CONFIG.sweepIntervalMs);
		assert.equal(cfg.sessionsMaxBytes, DEFAULT_RUNTIME_CONFIG.sessionsMaxBytes);
		assert.equal(cfg.sessionsMaxCount, DEFAULT_RUNTIME_CONFIG.sessionsMaxCount);
		assert.deepEqual(cfg.compaction, DEFAULT_RUNTIME_CONFIG.compaction);
	});
	it("dataRoot 缺省为 cwd 下 .pi-runtime-data（对齐既有 DATA_ROOT 语义）", () => {
		const cfg = loadRuntimeConfig({});
		assert.equal(cfg.dataRoot, process.env.PI_RUNTIME_DATA_DIR ?? join(process.cwd(), ".pi-runtime-data"));
	});
	it("env 覆盖生效且非法值回退到默认", () => {
		const cfg = loadRuntimeConfig({
			PI_RUNTIME_DATA_DIR: "/data/sessions",
			PI_RUNTIME_SESSION_TTL_MS: "60000",
			PI_RUNTIME_SESSION_SWEEP_MS: "oops",
			PI_RUNTIME_SESSIONS_MAX_COUNT: "5",
			PI_RUNTIME_COMPACTION_ENABLED: "false",
			PI_RUNTIME_COMPACTION_RESERVE_TOKENS: "1024",
		});
		assert.equal(cfg.dataRoot, "/data/sessions");
		assert.equal(cfg.sessionTtlMs, 60000);
		assert.equal(cfg.sweepIntervalMs, DEFAULT_RUNTIME_CONFIG.sweepIntervalMs);
		assert.equal(cfg.sessionsMaxCount, 5);
		assert.equal(cfg.sessionsMaxBytes, DEFAULT_RUNTIME_CONFIG.sessionsMaxBytes);
		assert.equal(cfg.compaction.enabled, false);
		assert.equal(cfg.compaction.reserveTokens, 1024);
		assert.equal(cfg.compaction.keepRecentTokens, DEFAULT_RUNTIME_CONFIG.compaction.keepRecentTokens);
	});
	it("compaction 三个旧字段与 vendor DEFAULT_COMPACTION_SETTINGS 同值（targetRatio 为 host 侧新增，单测于下方专组）", () => {
		assert.deepEqual(
			{
				enabled: DEFAULT_RUNTIME_CONFIG.compaction.enabled,
				reserveTokens: DEFAULT_RUNTIME_CONFIG.compaction.reserveTokens,
				keepRecentTokens: DEFAULT_RUNTIME_CONFIG.compaction.keepRecentTokens,
			},
			{
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
			},
		);
	});
});

describe("askUser 配置", () => {
	it("askUserBlocking: 缺省 true，off/false/0 关闭", () => {
		assert.equal(askUserBlocking({}), true);
		assert.equal(askUserBlocking({ ASK_USER_BLOCKING: "off" }), false);
		assert.equal(askUserBlocking({ ASK_USER_BLOCKING: "1" }), true);
	});
	it("askUserTimeoutMs: 缺省 5min（2026-10-01 由 30min 下调），非法回退，小数截断", () => {
		assert.equal(askUserTimeoutMs({}), 300_000);
		assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "60000" }), 60_000);
		assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "abc" }), 300_000);
		assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "1500.7" }), 1500);
	});
});

describe("compactionContextWindow（诊断 F-01 · Review Focus #1）", () => {
	it("缺省为 undefined —— 未配置时沿用 model.contextWindow 的声明值", () => {
		assert.equal(loadRuntimeConfig({}).compactionContextWindow, undefined);
	});
	it("可被 env 覆盖；非法值回退为 undefined 而非塞一个真实数", () => {
		const at = (raw: string) => loadRuntimeConfig({ PI_RUNTIME_COMPACTION_CONTEXT_WINDOW: raw }).compactionContextWindow;
		assert.equal(at("128000"), 128000);
		assert.equal(at("0"), undefined);
		assert.equal(at("-1"), undefined);
		assert.equal(at("abc"), undefined);
		assert.equal(at(""), undefined);
	});
	it("科学计数法按数值解析（helm 数字型 env 的老坑在此同样适用）", () => {
		// 部署若误用 --set 而非 --set-string，128000 会被渲染成 1.28e+05；
		// 该字段必须与其他数字型 env 一样走 parsePositiveInt，不能被 parseInt 截成 1。
		assert.equal(
			loadRuntimeConfig({ PI_RUNTIME_COMPACTION_CONTEXT_WINDOW: "1.28e+05" }).compactionContextWindow,
			128000,
		);
	});
});

describe("PI_RUNTIME_COMPACTION_TARGET_RATIO（审计 P0-①：触发点 = 窗口比例口径）", () => {
	it("默认 0.7", () => {
		assert.equal(loadRuntimeConfig({}).compaction.targetRatio, 0.7);
	});
	it("显式 RESERVE_TOKENS 存在时 ratio 失效（旧口径优先）", () => {
		const cfg = loadRuntimeConfig({
			PI_RUNTIME_COMPACTION_RESERVE_TOKENS: "16384",
			PI_RUNTIME_COMPACTION_TARGET_RATIO: "0.7",
		});
		assert.equal(cfg.compaction.targetRatio, undefined);
		assert.equal(cfg.compaction.reserveTokens, 16384);
	});
	it("非法 ratio（0 / 1 / 负数 / 非数字）回退 undefined（= 旧口径）；空串 = 未配置 → 默认 0.7", () => {
		const at = (raw: string) => loadRuntimeConfig({ PI_RUNTIME_COMPACTION_TARGET_RATIO: raw }).compaction.targetRatio;
		assert.equal(at("0"), undefined);
		assert.equal(at("1"), undefined);
		assert.equal(at("-0.5"), undefined);
		assert.equal(at("abc"), undefined);
		assert.equal(at(""), 0.7);
	});
	it("合法 ratio（0.6）生效", () => {
		assert.equal(loadRuntimeConfig({ PI_RUNTIME_COMPACTION_TARGET_RATIO: "0.6" }).compaction.targetRatio, 0.6);
	});
});

describe("effectiveCompactionSettings（审计 P0-①）", () => {
	const BASE = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, targetRatio: 0.7 };
	it("1M 窗口：触发点 = 70%（reserve=300k）", () => {
		const s = effectiveCompactionSettings(BASE, 1_000_000);
		assert.equal(s.reserveTokens, 300_000);
		assert.equal(s.keepRecentTokens, 20_000);
		assert.equal(s.enabled, true);
	});
	it("128k 窗口（生产 compactionContextWindow 覆盖值）：reserve=38.4k，两渠道口径拉齐", () => {
		assert.equal(effectiveCompactionSettings(BASE, 128_000).reserveTokens, 38_400);
	});
	it("targetRatio undefined：走旧 reserveTokens（16_384）", () => {
		const s = effectiveCompactionSettings({ ...BASE, targetRatio: undefined }, 1_000_000);
		assert.equal(s.reserveTokens, 16_384);
	});
	it("极小窗口：clamp 到 window − keepRecent − 1，不产生负数 / 永不触发", () => {
		const s = effectiveCompactionSettings(BASE, 8_192);
		assert.ok(s.reserveTokens < 8_192, `reserve=${s.reserveTokens} 必须 < window`);
		assert.ok(s.reserveTokens >= 0);
	});
	it("keepRecent 大于窗口一半时先缩 keepRecent 再算 cap", () => {
		const s = effectiveCompactionSettings({ ...BASE, keepRecentTokens: 20_000 }, 30_000);
		assert.ok(s.keepRecentTokens <= 15_000);
	});
	it("enabled=false：透传关闭，不掺和窗口计算", () => {
		const s = effectiveCompactionSettings({ ...BASE, enabled: false }, 1_000_000);
		assert.equal(s.enabled, false);
	});
});
	it("directImages：缺省 true；PI_RUNTIME_DIRECT_IMAGES=off → false", () => {
		const def = loadRuntimeConfig({});
		assert.equal(def.directImages, true);
		const off = loadRuntimeConfig({ PI_RUNTIME_DIRECT_IMAGES: "off" });
		assert.equal(off.directImages, false);
	});

	it("工具结果统一上限：缺省开启 24000；可整体关闭、可改上限", () => {
		const def = loadRuntimeConfig({});
		assert.equal(def.toolResultBudget, true);
		assert.equal(def.toolResultMaxChars, 24_000);
		const off = loadRuntimeConfig({ PI_RUNTIME_TOOL_RESULT_BUDGET: "off" });
		assert.equal(off.toolResultBudget, false);
		const sized = loadRuntimeConfig({ PI_RUNTIME_TOOL_RESULT_MAX_CHARS: "8000" });
		assert.equal(sized.toolResultMaxChars, 8_000);
		const bad = loadRuntimeConfig({ PI_RUNTIME_TOOL_RESULT_MAX_CHARS: "0" });
		assert.equal(bad.toolResultMaxChars, 24_000, "非正数回落缺省，绝不静默变成 0 上限");
	});

	it("compactionRetention：缺省 true；PI_RUNTIME_COMPACTION_RETENTION=off → false", () => {
		const def = loadRuntimeConfig({});
		assert.equal(def.compactionRetention, true);
		const off = loadRuntimeConfig({ PI_RUNTIME_COMPACTION_RETENTION: "off" });
		assert.equal(off.compactionRetention, false);
		const on = loadRuntimeConfig({ PI_RUNTIME_COMPACTION_RETENTION: "true" });
		assert.equal(on.compactionRetention, true);
	});
	it("directImageHistoryRounds：缺省 2；非法值回退；显式值生效", () => {
		const def = loadRuntimeConfig({});
		assert.equal(def.directImageHistoryRounds, 2);
		const bad = loadRuntimeConfig({ PI_RUNTIME_DIRECT_IMAGE_HISTORY_ROUNDS: "abc" });
		assert.equal(bad.directImageHistoryRounds, 2);
		const ok = loadRuntimeConfig({ PI_RUNTIME_DIRECT_IMAGE_HISTORY_ROUNDS: "4" });
		assert.equal(ok.directImageHistoryRounds, 4);
	});
