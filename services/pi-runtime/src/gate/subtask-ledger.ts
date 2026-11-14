/**
 * D2 子任务单据（spec docs/superpowers/specs/2026-11-14-subagent-contract-d2-nonblock-design.md §6.1）。
 *
 * JSONL append-only 账本：子任务 spawned/terminal 两条记录落盘（生产落在 PVC，
 * PI_RUNTIME_DATA_DIR）。定位是**观测与取证设施**，不是关键路径——append 失败静默降级
 * （degraded 标志），绝不阻断子代理主流程。
 *
 * 恢复语义（诚实边界，§6.5）：pod 重启后 replay 只能取证「spawned 无 terminal = interrupted」，
 * 不做续跑（续跑属 D2 二期）；block 派发的中断归因仍由 Nest 账本（turn_interrupted）承担。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SubagentStatus } from "./subagent.js";

export interface SubtaskSpawnRecord {
	type: "spawned";
	callId: string;
	sessionKey: string;
	/** 前 200 字符，防账本膨胀 */
	taskPreview: string;
	mode: "block" | "background";
	ts: number;
}

export interface SubtaskTerminalRecord {
	type: "terminal";
	callId: string;
	status: SubagentStatus;
	turns: number;
	durationMs: number;
	/** 报告原文超限被截（与 SubagentOutcome.truncated 同源） */
	truncated?: boolean;
	reportChars: number;
	/** 全文随行落盘（≤20k）——collect 重启后若 terminal 在账本则报告仍可取回 */
	report: string;
	ts: number;
}

export type SubtaskRecord = SubtaskSpawnRecord | SubtaskTerminalRecord;

/** replay 的终态投影（无 terminal 的 callId 不在 Map 中） */
export interface LedgerTerminalState {
	status: SubagentStatus;
	turns: number;
	durationMs: number;
	truncated?: boolean;
	report: string;
}

export class SubtaskLedger {
	readonly filePath: string;
	/** append 失败（盘满/只读）后置 true——collect 不再指望磁盘恢复，主流程不受影响 */
	degraded = false;
	#writeFailed = false;

	constructor(dir: string) {
		this.filePath = join(dir, "subtasks.jsonl");
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
		} catch {
			this.#writeFailed = true;
			this.degraded = true;
		}
	}

	append(record: SubtaskRecord): void {
		if (this.#writeFailed) return;
		try {
			appendFileSync(this.filePath, JSON.stringify(record) + "\n");
		} catch {
			this.#writeFailed = true;
			this.degraded = true;
		}
	}

	/** 逐行解析；坏行/空行跳过不抛；同 callId 后行覆盖前行（spawned 建 stub、terminal 收敛）。 */
	replay(): Map<string, LedgerTerminalState> {
		const out = new Map<string, LedgerTerminalState>();
		if (!existsSync(this.filePath)) return out;
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			return out;
		}
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let rec: SubtaskRecord;
			try {
				rec = JSON.parse(trimmed) as SubtaskRecord;
			} catch {
				continue; // 坏行跳过——账本是观测设施，容错优先
			}
			if (rec?.type === "terminal" && typeof rec.callId === "string") {
				out.set(rec.callId, {
					status: rec.status,
					turns: rec.turns,
					durationMs: rec.durationMs,
					truncated: rec.truncated,
					report: rec.report,
				});
			}
		}
		return out;
	}

	/** 账本中出现过 spawned 的 callId 集合（用于重启后区分 interrupted vs unknown）。 */
	spawnedCallIds(): Set<string> {
		const ids = new Set<string>();
		if (!existsSync(this.filePath)) return ids;
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			return ids;
		}
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const rec = JSON.parse(trimmed) as SubtaskRecord;
				if (typeof rec?.callId === "string") ids.add(rec.callId);
			} catch {
				continue;
			}
		}
		return ids;
	}
}
