import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toSessionKey } from "./session-manager.js";
import { journalPath, readJournal } from "./events-journal.js";
import type { RuntimeConfig } from "./runtime-config.js";

/**
 * P2 · journal 在 SessionManager 的接线行为测试（Task 1 Step 4 验收）。
 *
 * 判据（计划 Review Focus 1/4 + 「已落地事实」纪律——走真实 dispatch，禁 stub 合成）：
 * 1. 写放大防线：dispatch 100 条 message_update 后 events.jsonl 仍只有结构性事件；
 * 2. TTL 等价（destroyMemoryOnly）只关句柄不删文件，且关句柄后 append 不再写入；
 * 3. destroy（remove）随会话目录删除 events.jsonl。
 *
 * dispatch 是 private：经由真实方法对象的反射调用（既有先例 :789 反射 sessions），
 * 事件骨架形态与生产 dispatch 调用点一致。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-journal-"));
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

type EntryLike = {
	journal?: { append: (r: { seq: number; event: unknown }) => void; close: () => Promise<void> };
};

async function createEntry(sm: SessionManager, key: string): Promise<EntryLike> {
	await sm.create(key, { userId: "u1" });
	const entry = (
		sm as unknown as { sessions: Map<string, EntryLike> }
	).sessions.get(toSessionKey(key));
	assert.ok(entry, "entry should exist after create");
	assert.ok(entry.journal, "journal should be opened by build()");
	return entry;
}

function dispatchRaw(sm: SessionManager, entry: EntryLike, type: string, extra: Record<string, unknown> = {}) {
	(sm as unknown as {
		dispatch: (e: EntryLike, ev: Record<string, unknown>) => void;
	}).dispatch(entry, { type, payload: {}, ...extra });
}

describe("SessionManager × events journal 接线（P2 Task 1）", () => {
	it("create 后 journal 已打开；结构性事件落盘、message_update 不落盘", async () => {
		const sm = makeManager();
		const key = "j-main";
		const entry = await createEntry(sm, key);
		const dir = join((sm as unknown as { config: { dataRoot: string } }).config.dataRoot, toSessionKey(key));

		dispatchRaw(sm, entry, "turn_start");
		for (let i = 0; i < 100; i++) dispatchRaw(sm, entry, "message_update", { payload: { delta: "x" } });
		dispatchRaw(sm, entry, "turn_end");

		await entry.journal!.close();
		const recs = await readJournal(dir);
		// 100 条 delta 全部被排除；两条结构性事件按 seq 保序
		assert.deepEqual(
			recs.map((r) => r.event.type),
			["turn_start", "turn_end"],
		);
		assert.deepEqual(recs.map((r) => r.seq), [0, 101]);
	});

	it("TTL 等价：destroyMemoryOnly 关句柄、文件保留；关后 append 不再写入", async () => {
		const sm = makeManager();
		const key = "j-ttl";
		const entry = await createEntry(sm, key);
		const sk = toSessionKey(key);
		const dir = join((sm as unknown as { config: { dataRoot: string } }).config.dataRoot, sk);

		dispatchRaw(sm, entry, "turn_start");
		await (sm as unknown as { destroyMemoryOnly: (k: string) => Promise<void> }).destroyMemoryOnly(sk);

		assert.ok(existsSync(journalPath(dir)), "journal 文件必须随 TTL 驱逐保留（不删磁盘）");
		const recs = await readJournal(dir);
		assert.equal(recs.length, 1);
		// 句柄已关：再 append 是 no-op（EventJournal 单测已覆盖，此处验证接线层一致）
		await entry.journal!.close();
		assert.equal((await readJournal(dir)).length, 1);
	});

	it("destroy（remove）随会话目录删除 events.jsonl", async () => {
		const sm = makeManager();
		const key = "j-del";
		const entry = await createEntry(sm, key);
		const sk = toSessionKey(key);
		const dir = join((sm as unknown as { config: { dataRoot: string } }).config.dataRoot, sk);

		dispatchRaw(sm, entry, "turn_start");
		await entry.journal!.close();
		assert.ok(existsSync(journalPath(dir)));

		await sm.remove(key);
		assert.equal(existsSync(journalPath(dir)), false, "remove 必须连带删除 journal 文件");
	});
});
