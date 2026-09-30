import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadRuntimeConfig, parseBool, parsePositiveInt, DEFAULT_RUNTIME_CONFIG, askUserBlocking, askUserTimeoutMs } from "./runtime-config.js";

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
	it("compaction 默认值与 vendor DEFAULT_COMPACTION_SETTINGS 同值", () => {
		assert.deepEqual(DEFAULT_RUNTIME_CONFIG.compaction, {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
	});
});

describe("askUser 配置", () => {
	it("askUserBlocking: 缺省 true，off/false/0 关闭", () => {
		assert.equal(askUserBlocking({}), true);
		assert.equal(askUserBlocking({ ASK_USER_BLOCKING: "off" }), false);
		assert.equal(askUserBlocking({ ASK_USER_BLOCKING: "1" }), true);
	});
	it("askUserTimeoutMs: 缺省 30min，非法回退，小数截断", () => {
		assert.equal(askUserTimeoutMs({}), 1_800_000);
		assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "60000" }), 60_000);
		assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "abc" }), 1_800_000);
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
