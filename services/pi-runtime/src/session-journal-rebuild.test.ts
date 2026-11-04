import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toSessionKey } from "./session-manager.js";
import { journalPath } from "./events-journal.js";
import type { RuntimeConfig } from "./runtime-config.js";

/**
 * P2 Task 2 · 磁盘 resume rebuild buffer/nextSeq —— 跨重启游标连续性行为测试。
 *
 * 验收（rootfix T5 / 计划 Review Focus 3）：
 * 1. dispatch 结构性事件 → 模拟重启（destroyMemoryOnly 释放内存，磁盘保留）
 *    → 再次 create 命中磁盘 resume → buffer/nextSeq 从 journal rebuild；
 * 2. 重启后新 dispatch 的首条事件 seq == 重启前最后 seq + 1（游标连续性 ⭐）；
 * 3. 旧会话目录无 events.jsonl ⇒ resume fail-soft（buffer 空、nextSeq 对齐初始值 0）。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-p2t2-"));
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
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

type EntryLike = {
	journal?: { append: (r: { seq: number; event: unknown }) => void; close: () => Promise<void>; directory: string };
	buffer: Array<{ type: string; seq: number }>;
	nextSeq: number;
	droppedFromSeq: number;
};

function makeManager() {
	const fakeHarnessFactory = async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {},
		},
	}) as never;
	return new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
}

function smInternals(sm: SessionManager) {
	return sm as unknown as {
		sessions: Map<string, EntryLike>;
		destroyMemoryOnly: (k: string) => Promise<void>;
		dispatch: (e: EntryLike, ev: Record<string, unknown>) => void;
		config: { dataRoot: string };
	};
}

async function createAndGetEntry(sm: SessionManager, key: string): Promise<EntryLike> {
	await sm.create(key, { userId: "u1" });
	const entry = smInternals(sm).sessions.get(toSessionKey(key));
	assert.ok(entry, "entry should exist");
	return entry;
}

describe("P2 磁盘 resume rebuild（跨重启游标连续性）", () => {
	it("重启后：buffer 从 journal rebuild、nextSeq 连续、新事件 seq 接续", async () => {
		const sm = makeManager();
		const internals = smInternals(sm);
		const key = "r-main";
		const sk = toSessionKey(key);

		// ① 第一段生命周期：dispatch 结构性事件 seq 0..2
		const entry1 = await createAndGetEntry(sm, key);
		internals.dispatch(entry1, { type: "turn_start", payload: {} });
		internals.dispatch(entry1, { type: "tool_execution_start", payload: {} });
		internals.dispatch(entry1, { type: "turn_end", payload: {} });
		assert.deepEqual(entry1.buffer.map((e) => e.seq), [0, 1, 2]);
		await entry1.journal!.close();

		// ② 模拟重启：TTL 等价的内存释放（磁盘 journal 保留）
		await internals.destroyMemoryOnly(sk);
		assert.ok(existsSync(journalPath(join(internals.config.dataRoot, sk))), "journal 必须保留");

		// ③ 第二段生命周期：磁盘 resume + rebuild
		const entry2 = await createAndGetEntry(sm, key);
		assert.deepEqual(
			entry2.buffer.map((e) => e.type),
			["turn_start", "tool_execution_start", "turn_end"],
			"buffer 必须从 journal rebuild",
		);
		assert.deepEqual(entry2.buffer.map((e) => e.seq), [0, 1, 2]);
		assert.equal(entry2.nextSeq, 3, "nextSeq = max(seq)+1（跨重启连续 ⭐）");

		// ④ 重启后新事件 seq 接续（不撞号）
		internals.dispatch(entry2, { type: "agent_start", payload: {} });
		const last = entry2.buffer[entry2.buffer.length - 1];
		assert.equal(last.seq, 3, "重启后首条新事件 seq 必须接续（游标断裂即对账失效）");
		await entry2.journal!.close();
	});

	it("无 journal 的旧会话（存量目录）：resume fail-soft，nextSeq 对齐初始值 0", async () => {
		const sm = makeManager();
		const internals = smInternals(sm);
		const key = "r-legacy";
		const sk = toSessionKey(key);

		const entry1 = await createAndGetEntry(sm, key);
		await entry1.journal!.close();
		// 模拟存量旧会话：journal 从未存在
		unlinkSync(journalPath(join(internals.config.dataRoot, sk)));
		await internals.destroyMemoryOnly(sk);

		const entry2 = await createAndGetEntry(sm, key);
		assert.deepEqual(entry2.buffer, [], "无 journal ⇒ buffer 空（fail-soft 降级）");
		assert.equal(entry2.nextSeq, 0);
		assert.equal(entry2.droppedFromSeq, 0);
		await entry2.journal!.close();
	});

	it("溢出 rebuild：journal 超过 BUFFER_LIMIT 时 buffer 截取最近 500 条、droppedFromSeq 对齐", async () => {
		const sm = makeManager();
		const internals = smInternals(sm);
		const key = "r-overflow";
		const sk = toSessionKey(key);

		const entry1 = await createAndGetEntry(sm, key);
		for (let i = 0; i < 505; i++) internals.dispatch(entry1, { type: "turn_start", payload: {} });
		await entry1.journal!.close();
		// 内存路径的溢出语义（对照组）：buffer=500、droppedFromSeq=最早在 buffer 的 seq
		assert.equal(entry1.buffer.length, 500);
		assert.equal(entry1.droppedFromSeq, 5);

		await internals.destroyMemoryOnly(sk);
		const entry2 = await createAndGetEntry(sm, key);
		assert.equal(entry2.buffer.length, 500, "rebuild 同样受 BUFFER_LIMIT 约束");
		assert.deepEqual(entry2.buffer.map((e) => e.seq), entry1.buffer.map((e) => e.seq), "rebuild 后 buffer 与溢出前的内存 buffer 逐条一致");
		assert.equal(entry2.droppedFromSeq, 5, "droppedFromSeq 语义跨重启保持");
		assert.equal(entry2.nextSeq, 505);
		await entry2.journal!.close();
	});
});
