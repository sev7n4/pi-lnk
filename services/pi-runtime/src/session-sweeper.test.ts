import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toSessionKey } from "./session-manager.js";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "./runtime-config.js";
import { PendingToolRegistry } from "./pending-registry.js";

function makeManager(root: string, overrides: Partial<RuntimeConfig> = {}) {
	const closed: string[] = [];
	const factory = (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {
				closed.push("x");
			},
		},
	})) as never;
	const sm = new SessionManager([], "", undefined, factory, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: root,
		sweepIntervalMs: 10 ** 6,
		...overrides,
	});
	return { sm, closed };
}

describe("sweepOnce TTL", () => {
	it("超过 TTL 的会话被关闭内存句柄，但磁盘目录保留", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-"));
		try {
			const { sm, closed } = makeManager(root, { sessionTtlMs: 1000 });
			await sm.create("s1:t1", {});
			const key = toSessionKey("s1:t1");
			assert.ok(readdirSync(root).includes(key));
			// 人为把 now 推到 TTL 之后
			const out = await sm.sweepOnce(Date.now() + 10_000);
			assert.deepEqual(out.closed, [key]);
			assert.equal(closed.length, 1);
			assert.ok(readdirSync(root).includes(key), "磁盘目录必须保留");
			assert.equal(sm.hasKey("s1:t1"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("未超 TTL 的会话不会被回收", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-"));
		try {
			const { sm } = makeManager(root, { sessionTtlMs: 1000 });
			await sm.create("s1:t1", {});
			const out = await sm.sweepOnce();
			assert.deepEqual(out.closed, []);
			assert.equal(sm.hasKey("s1:t1"), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("阻塞等待中的会话（prompting=true + registry pending）不被 TTL 回收", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const factory = (async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({
						prompt: async () => {
							await gate;
							return { ok: true };
						},
					}),
					close: async () => {},
				},
			})) as never;
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, {
				...DEFAULT_RUNTIME_CONFIG,
				dataRoot: root,
				sessionTtlMs: 1000,
			});
			// ask_user 阻塞等待：waitForUser 挂起期间 prompting 仍为 true（工具在
			// lane.prompt 执行栈内 await），故 sweeper 豁免走既有 entry.prompting 路径
			// （session-manager.ts sweepOnce 的 `if (entry.prompting) continue`）——
			// 无需为 registry pending 新增生产豁免代码，本用例钉住该回归。
			const registry = new PendingToolRegistry();
			sm.setPendingRegistry(registry);
			await sm.create("s1:t1", {});
			await sm.prompt("s1:t1", "长任务");
			const wait = registry.waitForUser("canvas-1", "c1", "ask_user", 60_000);
			assert.equal(registry.hasPending("canvas-1"), true);
			const out = await sm.sweepOnce(Date.now() + 10_000);
			assert.deepEqual(out.closed, []);
			assert.equal(sm.hasKey("s1:t1"), true);
			// 收尾：释放 gate + 结算 pending，防 node:test 白等
			registry.abortAll("canvas-1");
			await wait;
			release(undefined);
			await new Promise((r) => setTimeout(r, 0));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("TTL 回收只关内存：随后 create 同键从磁盘恢复（status=resumed）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-"));
		try {
			const { sm } = makeManager(root, { sessionTtlMs: 1000 });
			await sm.create("s1:t1", {});
			await sm.sweepOnce(Date.now() + 10_000);
			const again = await sm.create("s1:t1", {});
			assert.equal(again.status, "resumed");
			assert.equal(again.resumedFrom, "disk");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("sweepOnce 磁盘 LRU", () => {
	it("超 count 时删最旧目录，且活跃会话目录不被删", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-lru-"));
		try {
			// 造 3 个「历史遗留」目录（无内存会话），mtime 递增
			["aaaa-11111111", "bbbb-22222222", "cccc-33333333"].forEach((name, i) => {
				mkdirSync(join(root, name), { recursive: true });
				writeFileSync(join(root, name, "sessions.jsonl"), "x".repeat(10));
				utimesSync(join(root, name), 100 + i * 10, 100 + i * 10);
			});
			const { sm } = makeManager(root, { sessionsMaxCount: 2, sessionTtlMs: 10 ** 9 });
			await sm.create("live:t1", {}); // 活跃会话，其目录必须豁免
			const out = await sm.sweepOnce();
			assert.ok(out.removedFromDisk.includes("aaaa-11111111"));
			const remaining = readdirSync(root);
			assert.ok(remaining.includes(toSessionKey("live:t1")), "活跃会话目录不得被删");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("超字节上限时淘汰最旧目录，活跃会话目录仍豁免", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-lru-"));
		try {
			mkdirSync(join(root, "huge-00000000"), { recursive: true });
			writeFileSync(join(root, "huge-00000000", "sessions.jsonl"), "x".repeat(2_000_000));
			utimesSync(join(root, "huge-00000000"), 100, 100);
			const { sm } = makeManager(root, {
				sessionsMaxBytes: 50_000,
				sessionsMaxCount: 1000,
				sessionTtlMs: 10 ** 9,
			});
			await sm.create("live:t1", {});
			const out = await sm.sweepOnce();
			assert.ok(out.removedFromDisk.includes("huge-00000000"));
			assert.ok(readdirSync(root).includes(toSessionKey("live:t1")), "活跃会话目录不得被删");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("sweeper 定时器", () => {
	it("startSweeper 幂等；stopSweeper 可重复调用", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweeper-"));
		try {
			const { sm } = makeManager(root);
			sm.startSweeper();
			sm.startSweeper();
			sm.stopSweeper();
			sm.stopSweeper();
			sm.startSweeper();
			sm.stopSweeper();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("到点自动回收（轮询等待，不依赖固定 sleep）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweeper-"));
		try {
			const { sm } = makeManager(root, { sessionTtlMs: 0, sweepIntervalMs: 5 });
			await sm.create("s1:t1", {});
			sm.startSweeper();
			try {
				const deadline = Date.now() + 3000;
				while (sm.activeKeys().size > 0 && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 10));
				}
				assert.equal(sm.activeKeys().size, 0);
			} finally {
				sm.stopSweeper();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
