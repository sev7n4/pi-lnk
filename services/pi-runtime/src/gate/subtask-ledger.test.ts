/**
 * D2 子任务账本测试（spec docs/superpowers/specs/2026-11-14-subagent-contract-d2-nonblock-design.md §6.1）。
 * tmpdir 往返 + 坏行容错 + degraded 降级——账本是观测设施，容错优先于一致性。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubtaskLedger, type SubtaskTerminalRecord } from "./subtask-ledger.js";

function terminal(callId: string, overrides: Partial<SubtaskTerminalRecord> = {}): SubtaskTerminalRecord {
	return {
		type: "terminal", callId, status: "completed", turns: 2, durationMs: 100,
		reportChars: 6, report: "REPORT", ts: Date.now(), ...overrides,
	};
}

describe("SubtaskLedger（D2 子任务单据）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "subtask-ledger-"));
	});

	it("append + replay 往返：spawned 建 stub，terminal 收敛出终态", () => {
		const l = new SubtaskLedger(dir);
		l.append({ type: "spawned", callId: "c1", sessionKey: "k", taskPreview: "调研A", mode: "background", ts: 1 });
		l.append(terminal("c1"));
		const t = l.replay();
		assert.equal(t.size, 1);
		assert.equal(t.get("c1")!.status, "completed");
		assert.equal(t.get("c1")!.report, "REPORT");
	});

	it("同 callId 两条 terminal：后行覆盖前行", () => {
		const l = new SubtaskLedger(dir);
		l.append(terminal("c1", { status: "timeout", report: "first" }));
		l.append(terminal("c1", { status: "completed", report: "second" }));
		const t = l.replay();
		assert.equal(t.get("c1")!.status, "completed");
		assert.equal(t.get("c1")!.report, "second");
	});

	it("坏行/空行/半截 JSON 跳过不抛；文件不存在返回空 Map", () => {
		const l = new SubtaskLedger(dir);
		l.append(terminal("c1"));
		appendFileSync(l.filePath, "这不是JSON\n\n{\"type\":\"terminal\"}\n{\"type\":\"terminal\",\"callId\":\"c2\",\"status\":\"failed\"}\n");
		const t = l.replay();
		assert.equal(t.size, 2); // c1 有效 + 半截行被跳过；c2 缺必填字段但形状可解析——按宽松解析收录
		assert.equal(t.get("c1")!.report, "REPORT");
		assert.equal(t.get("c2")!.status, "failed");
		const empty = new SubtaskLedger(join(dir, "does-not-exist-yet"));
		assert.equal(empty.replay().size, 0);
	});

	it("spawned 无 terminal：不在 replay Map；但 spawnedCallIds 能查到（interrupted 判据）", () => {
		const l = new SubtaskLedger(dir);
		l.append({ type: "spawned", callId: "ghost", sessionKey: "k", taskPreview: "t", mode: "block", ts: 1 });
		assert.equal(l.replay().size, 0);
		assert.ok(l.spawnedCallIds().has("ghost"));
	});

	it("目录不可写：append 不抛且 degraded=true（环境忽略只读位则跳过）", () => {
		const ro = mkdtempSync(join(tmpdir(), "subtask-ro-"));
		chmodSync(ro, 0o500);
		try {
			const l = new SubtaskLedger(ro);
			l.append(terminal("c1"));
			if (l.degraded) {
				assert.equal(l.replay().size, 0);
			}
			// root/部分 FS 忽略 chmod：degraded 未置位时仅要求不抛（不判定）
		} finally {
			chmodSync(ro, 0o700);
			rmSync(ro, { recursive: true, force: true });
		}
		assert.ok(true);
	});
});
