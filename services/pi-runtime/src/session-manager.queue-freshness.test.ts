/**
 * P2：steer/followUp 队列新鲜度门禁回归锁（2026-11-08）。
 *
 * 锁住「入队超 queueFreshnessMs 仍滞留队列的过期指令，drain 时**绝不静默注入**」这一根因修复：
 *   - 过期项：cancel 移除 + 记录 entry.staleDropped + 指标 stale_dropped，且不调用 lane.prompt 注入；
 *   - 新鲜项：行为与旧版一致（cancel + 非空 prompt 开一轮）；
 *   - 回归：queueFreshnessMs 默认 600s 下，正常 idle 插话仍被正常排空接住。
 *
 * 关键构造：fake lane 的 `watch().snapshot.queues` 的 entryId 与 steer/followUp 回传的 entryId
 * **对齐**（生产里就是同一条），否则新鲜度映射对不上、测试会假红。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-fresh-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(freshMs: number): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `f${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		queueFreshnessMs: freshMs,
	};
}

interface LaneCalls {
	steer: string[];
	followUp: string[];
	prompt: string[];
	cancelQueued: string[];
}

/** 与现有 queue.test.ts 不同：watch 的 entryId 与 steer/followUp 回传 entryId 严格对齐。 */
function makeP2Lane(calls: LaneCalls) {
	let sSeq = 0;
	let fSeq = 0;
	return {
		steer: async (msg: string) => {
			calls.steer.push(msg);
			return { ok: true, value: { entryId: `e-steer-${++sSeq}` } };
		},
		followUp: async (msg: string) => {
			calls.followUp.push(msg);
			return { ok: true, value: { entryId: `e-fu-${++fSeq}` } };
		},
		prompt: async (text?: string) => {
			calls.prompt.push(text ?? "");
			return { ok: true };
		},
		cancelQueued: async (entryId: string) => {
			calls.cancelQueued.push(entryId);
			return { ok: true, value: { kind: "cancelled" as const } };
		},
		watch: async () => ({
			snapshot: {
				queues: [
					...calls.steer.map((text, i) => ({
						entryId: `e-steer-${i + 1}`,
						kind: "steer",
						type: "message",
						message: { content: [{ type: "text", text }] },
					})),
					...calls.followUp.map((text, i) => ({
						entryId: `e-fu-${i + 1}`,
						kind: "followUp",
						type: "message",
						message: { content: [{ type: "text", text }] },
					})),
				],
			},
			unsubscribe: () => {},
		}),
	};
}

function makeManager(calls: LaneCalls, freshMs: number, metrics?: unknown) {
	const lane = makeP2Lane(calls);
	const factory = async () =>
		({
			harness: {
				events: { on: () => () => {} },
				lane: async () => lane,
				close: async () => {},
			},
		} as never);
	const sm = new SessionManager(
		[],
		"",
		undefined,
		factory,
		undefined,
		undefined,
		testConfig(freshMs),
		undefined,
		metrics as never,
	);
	return { sm, lane };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

describe("P2 新鲜度门禁：过期 steer/followUp 不静默注入", () => {
	it("过期项：cancel 移除 + 记录，绝不调用 lane.prompt 注入", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const metricsCalls: Array<[string, string, string]> = [];
		const metrics = {
			observeQueueOp: (op: string, kind: string, outcome: string) =>
				metricsCalls.push([op, kind, outcome]),
		};
		const { sm, lane } = makeManager(calls, 5, metrics);
		await sm.create("p2-stale", { userId: "u1" });
		const entry = (sm as unknown as { sessions: Map<string, any> }).sessions.values().next().value;

		// 预置一条真实停留在队列里的过期 steer（入队 100s 前，远超 5ms 阈值）
		calls.steer.push("执行生成");
		entry.queuedEnqueueAt.set("e-steer-1", Date.now() - 100_000);
		entry.staleDropped = [];

		await (sm as unknown as { drainQueued: (e: unknown, l: unknown) => Promise<void> }).drainQueued(entry, lane);
		await settle();

		assert.ok(!calls.prompt.includes("执行生成"), "过期 steer 绝不应被注入 run");
		assert.ok(calls.cancelQueued.includes("e-steer-1"), "过期 steer 应被撤回移除");
		assert.equal(entry.staleDropped.length, 1, "应留痕一条过期丢弃");
		assert.deepEqual(
			metricsCalls,
			[["drain", "steer", "stale_dropped"]],
			"指标应记一次 stale_dropped",
		);
	});

	it("新鲜项：行为与旧版一致（cancel + 非空 prompt 开一轮接住）", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const { sm, lane } = makeManager(calls, 5);
		await sm.create("p2-fresh", { userId: "u1" });
		const entry = (sm as unknown as { sessions: Map<string, any> }).sessions.values().next().value;

		// 预置一条新鲜 steer（刚入队，未超阈值）
		calls.steer.push("执行生成");
		entry.queuedEnqueueAt.set("e-steer-1", Date.now());
		entry.staleDropped = [];

		await (sm as unknown as { drainQueued: (e: unknown, l: unknown) => Promise<void> }).drainQueued(entry, lane);
		await settle();

		assert.ok(calls.prompt.includes("执行生成"), "新鲜 steer 应被注入 run（行为不变）");
		assert.equal(entry.staleDropped.length, 0, "新鲜项不应被记为过期丢弃");
	});

	it("回归：queueFreshnessMs 默认 600s 下，正常 idle 插话仍被排空接住", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		// 用默认阈值（600_000），刚入队的指令必然新鲜
		const { sm } = makeManager(calls, 600_000);
		await sm.create("p2-default", { userId: "u1" });

		await sm.steer("p2-default", "换个风格再生成一次");
		await settle();

		assert.ok(
			calls.prompt.includes("换个风格再生成一次"),
			"默认阈值下 idle 插话应以文案为非空 prompt 自动开一轮，行为不变",
		);
	});
});
