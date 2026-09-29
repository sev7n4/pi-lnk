import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectSessionDirs, enforceRetention, pickLruVictims, type RetentionEntry } from "./session-retention.js";

const e = (key: string, bytes: number, mtimeMs: number): RetentionEntry => ({ key, bytes, mtimeMs });
const LIMITS = { maxBytes: 1000, maxCount: 3 };

describe("pickLruVictims", () => {
	it("未超限返回空", () => {
		assert.deepEqual(pickLruVictims([e("a", 10, 1), e("b", 10, 2)], LIMITS, new Set()), []);
	});
	it("空目录列表返回空", () => {
		assert.deepEqual(pickLruVictims([], LIMITS, new Set()), []);
	});
	it("只超 count：按 mtime 最旧优先淘汰到限内", () => {
		const out = pickLruVictims(
			[e("new", 10, 300), e("old", 10, 100), e("mid", 10, 200), e("older", 10, 50)],
			LIMITS,
			new Set(),
		);
		assert.deepEqual(out.map((x) => x.key), ["older"]);
	});
	it("只超 bytes：淘汰到字节回到限内", () => {
		const out = pickLruVictims([e("a", 600, 1), e("b", 600, 2), e("c", 600, 3)], LIMITS, new Set());
		assert.deepEqual(out.map((x) => x.key), ["a", "b"]);
	});
	it("count 与 bytes 双超：一次淘汰满足两个约束", () => {
		const out = pickLruVictims([e("a", 900, 1), e("b", 900, 2), e("c", 900, 3), e("d", 10, 4)], LIMITS, new Set());
		assert.deepEqual(out.map((x) => x.key), ["a", "b"]);
	});
	it("active 集合被跳过（活跃会话不因 LRU 被删）", () => {
		const out = pickLruVictims(
			[e("active-old", 10, 1), e("b", 10, 2), e("c", 10, 3), e("d", 10, 4)],
			LIMITS,
			new Set(["active-old"]),
		);
		assert.deepEqual(out.map((x) => x.key), ["b"]);
	});
	it("全部 active 时返回空（宁可超限也不删活跃）", () => {
		const out = pickLruVictims(
			[e("a", 10, 1), e("b", 10, 2), e("c", 10, 3), e("d", 10, 4)],
			LIMITS,
			new Set(["a", "b", "c", "d"]),
		);
		assert.deepEqual(out, []);
	});
});

describe("collectSessionDirs / enforceRetention", () => {
	it("收集目录并累计字节；执行后最旧目录被物理删除", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-retention-"));
		try {
			for (const [name, age] of [
				["old", 100],
				["mid", 200],
				["new", 300],
			] as const) {
				mkdirSync(join(root, name, "sessions"), { recursive: true });
				writeFileSync(join(root, name, "sessions", "s.jsonl"), "x".repeat(50));
				utimesSync(join(root, name), age, age);
			}
			const entries = await collectSessionDirs(root);
			assert.equal(entries.length, 3);
			assert.ok(entries.every((x) => x.bytes > 0));
			const removed = await enforceRetention(root, { maxBytes: 1_000_000, maxCount: 2 }, new Set());
			assert.deepEqual(removed, ["old"]);
			const after = await collectSessionDirs(root);
			assert.deepEqual(after.map((x) => x.key).sort(), ["mid", "new"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("根目录不存在时返回空数组且不抛", async () => {
		assert.deepEqual(await collectSessionDirs("/nonexistent/pi-runtime-x"), []);
	});
	it("enforceRetention 在根目录不存在时不抛且返回空", async () => {
		assert.deepEqual(await enforceRetention("/nonexistent/pi-runtime-x", LIMITS, new Set()), []);
	});
});
