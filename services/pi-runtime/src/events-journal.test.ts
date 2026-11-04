import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	EventJournal,
	JOURNAL_EVENT_TYPES,
	journalPath,
	readJournal,
	recoverNextSeq,
	type NormalizedEventType,
} from "./events-journal.js";

/**
 * P2 事件流持久化 · journal 模块单测。
 *
 * 设计判据（计划 docs/superpowers/plans/2026-11-04-multi-device-consistency-p2-durable.md）：
 * 1. 写放大防线：delta 类（message_update）绝不落盘 —— 名单穷举断言钉死。
 * 2. 损坏行 fail-soft：不抛错、跳过并继续（对齐 session-manager 写盘失败不阻断的取舍）。
 * 3. recoverNextSeq = max(seq)+1：跨重启游标连续性的根基。
 * 4. append 串行保序：同一 seq 的行在文件里按 append 顺序排列。
 */

describe("events-journal", () => {
	let dir: string;
	let cleanup: string[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ejournal-"));
		cleanup.push(dir);
	});

	afterEach(() => {
		for (const d of cleanup) rmSync(d, { recursive: true, force: true });
		cleanup = [];
	});

	const ev = (type: NormalizedEventType, seq: number) =>
		({ type, seq, id: `e${seq}`, payload: {} }) as never;

	it("append 后 read 原样返回，recoverNextSeq = max(seq)+1", async () => {
		const j = await EventJournal.open(dir);
		j.append({ seq: 1, event: ev("turn_start", 1) });
		j.append({ seq: 7, event: ev("error", 7) });
		await j.close();

		const recs = await readJournal(dir);
		assert.deepEqual(recs.map((r) => r.seq), [1, 7]);
		assert.equal(recoverNextSeq(recs), 8);
	});

	it("close 前 readJournal 也能读到已 flush 的内容（节流窗内不丢已 flush 行）", async () => {
		const j = await EventJournal.open(dir);
		j.append({ seq: 1, event: ev("turn_start", 1) });
		await j.flush();
		const recs = await readJournal(dir);
		assert.equal(recs.length, 1);
		await j.close();
	});

	it("损坏行 fail-soft 跳过（不抛错、不中断后续合法行）", async () => {
		const j = await EventJournal.open(dir);
		j.append({ seq: 1, event: ev("turn_start", 1) });
		await j.close();
		// 模拟半行写入（进程崩溃截断的典型形态）
		writeFileSync(journalPath(dir), "{corrupted\n", { flag: "a" });
		const j2 = await EventJournal.open(dir);
		j2.append({ seq: 2, event: ev("turn_end", 2) });
		await j2.close();

		const recs = await readJournal(dir);
		assert.deepEqual(recs.map((r) => r.seq), [1, 2]);
	});

	it("无日志文件时 readJournal 返回空数组（旧会话目录 fail-soft）", async () => {
		const empty = mkdtempSync(join(tmpdir(), "ejournal-empty-"));
		cleanup.push(empty);
		assert.deepEqual(await readJournal(empty), []);
		assert.equal(recoverNextSeq([]), 0, "空日志 ⇒ nextSeq 对齐 SessionEntry 初始值 0");
	});

	it("close 后再 append 是 no-op（TTL 驱逐竞态防线）", async () => {
		const j = await EventJournal.open(dir);
		j.append({ seq: 1, event: ev("turn_start", 1) });
		await j.close();
		j.append({ seq: 2, event: ev("turn_end", 2) }); // 不抛错即可
		await j.close();
		const recs = await readJournal(dir);
		assert.equal(recs.length, 1);
	});

	it("写放大防线：message_update 不在结构性名单内", () => {
		assert.equal(JOURNAL_EVENT_TYPES.has("message_update"), false);
	});

	it("穷举：名单 = NormalizedEventType 全集 − message_update（新增类型漂移即红）", () => {
		const ALL: NormalizedEventType[] = [
			"agent_start",
			"agent_end",
			"turn_start",
			"turn_end",
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"compaction",
			"error",
			"waiting_user",
			"activity",
			"recovery",
			"node_status",
		];
		const expected = ALL.filter((t) => t !== "message_update").sort();
		assert.deepEqual([...JOURNAL_EVENT_TYPES].sort(), expected);
		assert.equal(JOURNAL_EVENT_TYPES.size, 15);
	});

	it("journalPath = dir/events.jsonl，readJournal 读回的内容与文件逐字节对应", async () => {
		const j = await EventJournal.open(dir);
		j.append({ seq: 3, event: ev("node_status", 3) });
		await j.close();
		const raw = readFileSync(journalPath(dir), "utf8");
		assert.equal(raw.split("\n").filter((l) => l.trim()).length, 1);
		assert.ok(raw.includes("\"seq\":3"));
	});
});
