import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import { loadRuntimeConfig, DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";
import type { RuntimeConfig } from "./runtime-config.js";

function baseConfig(root: string): RuntimeConfig {
	return {
		dataRoot: root,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	} as RuntimeConfig;
}

/**
 * fake harness：暴露 force-settle 需要的三个 lane 能力，并记录调用。
 * `currentOperationId` 为空时 `inspectExecution` 报「lane 空闲」。
 */
function makeFactory(opts: { currentOperationId?: string } = {}) {
	const calls = { requestAbort: [] as string[], drive: [] as Array<{ operationId: string }> };
	const factory = (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({
				prompt: async () => ({ ok: true }),
				requestAbort: async (operationId: string) => {
					calls.requestAbort.push(operationId);
					return { ok: true, value: { operationId, newlyRequested: true, steer: [] } };
				},
				drive: async (o: { operationId: string }) => {
					calls.drive.push({ operationId: o.operationId });
					return { ok: true, value: { kind: "settled" } };
				},
				inspectExecution: async () => ({
					lane: "main",
					tipId: null,
					configuredModel: { provider: "p", modelId: "m" },
					current: opts.currentOperationId
						? {
								id: opts.currentOperationId,
								kind: "run" as const,
								startedAt: 0,
								status: "running" as const,
							}
						: null,
					lastOperationId: null,
				}),
			}),
			close: async () => {},
		},
		open: [],
	})) as never;
	return { factory, calls };
}

/** 取会话 entry（测试白盒用：与 session-manager 的 toSessionKey 同构复算内存键）。 */
function entryOf(sm: SessionManager, threadKey: string): Record<string, unknown> {
	// @ts-expect-error 私有字段：白盒取entry
	const sessions = sm.sessions as Map<string, Record<string, unknown>>;
	const key = `${threadKey.replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha256")
		.update(threadKey)
		.digest("hex")
		.slice(0, 8)}`;
	const e = sessions.get(key);
	assert.ok(e, `应存在会话 ${key}`);
	return e;
}

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-stall-"));
	return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("运行期无进展看护（stall watchdog）", () => {
	it("prompting 且零进展超阈值 ⇒ 强制结算（requestAbort + drive），锁被释放", async () => {
		await withRoot(async (root) => {
			const { factory, calls } = makeFactory({ currentOperationId: "op-stuck" });
			const cfg = { ...baseConfig(root), stallWatchdog: true, stallWatchdogMs: 1000 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s1:t1", { userId: "u1" });
			const e = entryOf(sm, "s1:t1");
			e.prompting = true;
			e.lastProgressAt = 10_000;

			const out = await sm.sweepOnce(20_000);
			// sweepOnce 返回内部 session key（toSessionKey 形态），不是 threadKey。
			assert.deepEqual(out.stalled, [entryOf(sm, "s1:t1").id]);
			// 结算是 void 后台执行，等一个微任务让 promise 链落地
			await new Promise((r) => setTimeout(r, 10));
			assert.deepEqual(calls.requestAbort, ["op-stuck"]);
			assert.deepEqual(calls.drive, [{ operationId: "op-stuck" }]);
		});
	});

	it("未超阈值 ⇒ 不动（正常长生成不会被砍）", async () => {
		await withRoot(async (root) => {
			const { factory, calls } = makeFactory({ currentOperationId: "op-stuck" });
			const cfg = { ...baseConfig(root), stallWatchdog: true, stallWatchdogMs: 1000 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s2:t1", { userId: "u1" });
			const e = entryOf(sm, "s2:t1");
			e.prompting = true;
			e.lastProgressAt = 19_500; // 只idle 500ms

			const out = await sm.sweepOnce(20_000);
			assert.deepEqual(out.stalled, []);
			await new Promise((r) => setTimeout(r, 10));
			assert.equal(calls.drive.length, 0);
		});
	});

	it("不在跑（既不 prompting 也不 compacting）⇒ 不动", async () => {
		await withRoot(async (root) => {
			const { factory, calls } = makeFactory({ currentOperationId: "op-stuck" });
			const cfg = { ...baseConfig(root), stallWatchdog: true, stallWatchdogMs: 1000 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s3:t1", { userId: "u1" });
			entryOf(sm, "s3:t1").lastProgressAt = 0;

			const out = await sm.sweepOnce(10_000_000);
			assert.deepEqual(out.stalled, []);
			await new Promise((r) => setTimeout(r, 10));
			assert.equal(calls.drive.length, 0);
		});
	});

	it("开关关闭 ⇒ 完全不动（可运维兜底）", async () => {
		await withRoot(async (root) => {
			const { factory, calls } = makeFactory({ currentOperationId: "op-stuck" });
			const cfg = { ...baseConfig(root), stallWatchdog: false, stallWatchdogMs: 1000 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s4:t1", { userId: "u1" });
			const e = entryOf(sm, "s4:t1");
			e.prompting = true;
			e.lastProgressAt = 0;

			const out = await sm.sweepOnce(10_000_000);
			assert.deepEqual(out.stalled, []);
			await new Promise((r) => setTimeout(r, 10));
			assert.equal(calls.drive.length, 0);
		});
	});

	it("阈值缺省/为 0 ⇒ 视为关闭（未配不误伤）", async () => {
		await withRoot(async (root) => {
			const { factory, calls } = makeFactory({ currentOperationId: "op-stuck" });
			const cfg = { ...baseConfig(root), stallWatchdog: true, stallWatchdogMs: 0 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s5:t1", { userId: "u1" });
			const e = entryOf(sm, "s5:t1");
			e.prompting = true;
			e.lastProgressAt = 0;

			const out = await sm.sweepOnce(10_000_000);
			assert.deepEqual(out.stalled, []);
			await new Promise((r) => setTimeout(r, 10));
			assert.equal(calls.drive.length, 0);
		});
	});

	it("同一 run 只结算一次（sweeper 每轮不重复动手）", async () => {
		await withRoot(async (root) => {
			const { factory, calls } = makeFactory({ currentOperationId: "op-stuck" });
			const cfg = { ...baseConfig(root), stallWatchdog: true, stallWatchdogMs: 1000 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s6:t1", { userId: "u1" });
			const e = entryOf(sm, "s6:t1");
			e.prompting = true;
			e.lastProgressAt = 0;

			await sm.sweepOnce(10_000_000);
			await new Promise((r) => setTimeout(r, 10));
			const second = await sm.sweepOnce(20_000_000);
			await new Promise((r) => setTimeout(r, 10));
			assert.deepEqual(second.stalled, [], "第二次不应重复结算");
			assert.equal(calls.drive.length, 1);
		});
	});

	it("compacting 在途同样受看护", async () => {
		await withRoot(async (root) => {
			const { factory, calls } = makeFactory({ currentOperationId: "op-compact" });
			const cfg = { ...baseConfig(root), stallWatchdog: true, stallWatchdogMs: 1000 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s7:t1", { userId: "u1" });
			const e = entryOf(sm, "s7:t1");
			e.compacting = true;
			e.lastProgressAt = 0;

			const out = await sm.sweepOnce(10_000_000);
			assert.deepEqual(out.stalled, [entryOf(sm, "s7:t1").id]);
			await new Promise((r) => setTimeout(r, 10));
			assert.deepEqual(calls.drive, [{ operationId: "op-compact" }]);
		});
	});

	it("lane 空闲（无 current operation）⇒ 判定 false，不误报", async () => {
		await withRoot(async (root) => {
			const { factory } = makeFactory({}); // lane 空闲
			const cfg = { ...baseConfig(root), stallWatchdog: true, stallWatchdogMs: 1000 };
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s8:t1", { userId: "u1" });
			const e = entryOf(sm, "s8:t1");
			e.prompting = true;
			e.lastProgressAt = 0;

			// 仍会被判为 stalled（宿主侧确实有零进展的 prompt），但 force-settle 返回 false
			const out = await sm.sweepOnce(10_000_000);
			assert.deepEqual(out.stalled, [entryOf(sm, "s8:t1").id]);
		});
	});
});

describe("stall watchdog 配置解析", () => {
	it("缺省开启、缺省 15min", () => {
		const d = DEFAULT_RUNTIME_CONFIG;
		assert.equal(d.stallWatchdog, true);
		assert.equal(d.stallWatchdogMs, 900_000);
	});

	it("env 可覆盖开关与阈值", () => {
		const c = loadRuntimeConfig({
			PI_RUNTIME_STALL_WATCHDOG: "false",
			PI_RUNTIME_STALL_WATCHDOG_MS: "1200000",
		});
		assert.equal(c.stallWatchdog, false);
		assert.equal(c.stallWatchdogMs, 1_200_000);
	});

	it("非法值回退缺省（不因配置写错而误伤）", () => {
		const c = loadRuntimeConfig({
			PI_RUNTIME_STALL_WATCHDOG: "maybe",
			PI_RUNTIME_STALL_WATCHDOG_MS: "abc",
		});
		assert.equal(c.stallWatchdog, true);
		assert.equal(c.stallWatchdogMs, 900_000);
	});

	it("科学计数法能被正确解析（P0-B 既有教训）", () => {
		const c = loadRuntimeConfig({ PI_RUNTIME_STALL_WATCHDOG_MS: "1.2e+06" });
		assert.equal(c.stallWatchdogMs, 1_200_000);
	});
});