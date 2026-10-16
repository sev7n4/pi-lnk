/**
 * 终审 C1 回归锁：SessionManager 必须以 run 级 `toolExecution: "sequential"` 创建 harness
 * （spec 2026-10-16-canvas-write-tool-chain-design.md §4.1 P1a）。
 *
 * 为什么是配置捕获断言而非行为断言：harness 运行时栈不消费 per-tool executionMode
 * （pi-agent-core harness/runtime/harness.js:46 默认 "parallel"，run 级唯一消费点在
 * AgentHarness.create options，agent-harness.d.ts:632），串行是 canvas-id-binding
 * 捕获/重写的时序前置——options 形状本身就是接线契约，捕获断言是最诚实的机制
 * （真实 harness 并行/串行行为归 vendor 测试管）。
 *
 * 骨架同 session-manager.test.ts「harnessFactory 注入缝」组的捕获式 fake factory。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-sm-toolexec-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `c${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 捕获 create options 的最小 fake harnessFactory（同 session-manager.test.ts 范式）。 */
function fakeHarnessFactory(captured: { cfg?: unknown }) {
	return async (cfg: unknown) => {
		captured.cfg = cfg;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		} as never;
	};
}

describe("SessionManager run 级 toolExecution（终审 C1）", () => {
	it("create() 传给 harnessFactory 的 options 含 toolExecution === 'sequential'", async () => {
		const captured: { cfg?: unknown } = {};
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory(captured), undefined, undefined, testConfig());
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });
		const cfg = captured.cfg as { toolExecution?: unknown };
		assert.equal(
			cfg.toolExecution,
			"sequential",
			"run 级串行缺失 ⇒ per-tool executionMode 死配置 ⇒ 同批 upsert 窗口未落定 set/propose 已触发（事故复现）",
		);
	});
});
