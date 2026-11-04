import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { NormalizedEvent, NormalizedEventType } from "./session-manager.js";

export type { NormalizedEvent, NormalizedEventType };

/**
 * P2 · 事件流持久化 journal（多端一致性 durable 对账基座）。
 *
 * 背景：`NormalizedEvent.seq` 权威源是 SessionEntry.nextSeq（内存计数器），
 * 事件 buffer 上限 500 且 `message_update` 每 token 一事件 ⇒ 溢出是常规路径；
 * 代码注释自认「丢掉的 seq 永久不可恢复（内存态，重启即全失）」。
 * 后果：pi-runtime 重启后 `GET /sessions/:id/events` 重放 404/空 ⇒
 * Nest P0 对账 probe 在重启窗恒 missing ⇒ 误杀进行中/刚完成的回合。
 *
 * 本模块把**结构性事件**（全集 − message_update）append 到会话目录的
 * `events.jsonl`，使磁盘 resume 时能 rebuild buffer 与 nextSeq —— 游标跨重启连续。
 *
 * 纪律（对齐 session-manager 既有取舍）：
 * - 写失败只 warn 不阻断事件广播（:879 写盘失败不阻断建会话同源）；
 * - 读损坏行 fail-soft 跳过（半行写入 = 进程崩溃的典型残迹）；
 * - close 后 append 是 no-op（TTL 驱逐与在途 append 的竞态防线）。
 */

/** journal 单条记录：seq + 完整事件（重放时即 NormalizedEvent 原样）。 */
export interface JournalRecord {
	seq: number;
	event: NormalizedEvent;
}

/** flush 节流窗：append 进内存队列，至多每 200ms 落一次盘。 */
export const JOURNAL_FLUSH_MS = 200;

export const JOURNAL_FILE = "events.jsonl";

/**
 * 结构性事件名单 = `NormalizedEventType` 全集（session-manager.ts:104-128）
 * **减去 `message_update`**（每 token 一事件的 delta 类，落盘即写放大）。
 *
 * ⛔ 新增 NormalizedEventType 成员时必须同步这里 —— events-journal.test.ts
 * 的穷举断言会在名单漂移时红（遗漏终态类型 = probe 重启窗拿不到终态帧 = 对账失效）。
 */
export const JOURNAL_EVENT_TYPES: ReadonlySet<NormalizedEventType> = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
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
]);

/** 该事件类型是否应入 journal。 */
export function isJournalable(type: NormalizedEventType): boolean {
	return JOURNAL_EVENT_TYPES.has(type);
}

export function journalPath(dir: string): string {
	return join(dir, JOURNAL_FILE);
}

/**
 * 常驻句柄 + 节流 flush 的 append 日志。
 * open ⇒ append* ⇒ close；句柄 flags:"a"（append-only，多开安全度依赖 replicas=1）。
 */
export class EventJournal {
	private stream: ReturnType<typeof createWriteStream> | undefined;
	private pending: JournalRecord[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private closing = false;
	private closed = false;

	private constructor(
		private readonly path: string,
		readonly dir: string,
	) {}

	static async open(dir: string): Promise<EventJournal> {
		// 目录可能尚不存在（旧会话目录无任何 journal / 新建会话竞态）——mkdir -p 语义。
		mkdirSync(dir, { recursive: true });
		const j = new EventJournal(join(dir, JOURNAL_FILE), dir);
		const s = createWriteStream(j.path, { flags: "a" });
		// ⛔ 必须挂 error listener：目录被删/磁盘满时 writeStream 会 emit error，
		// 无 listener = uncaughtException = 炸进程（session-resume.test 实测）。
		// journal 是诊断流：吞错 warn，绝不阻断会话主链路。
		s.on("error", (err) => {
			console.warn(`[pi-runtime] events journal stream error: ${err.message}`);
		});
		j.stream = s;
		return j;
	}

	/** journal 所在目录（磁盘 resume rebuild 的读取源）。 */
	get directory(): string {
		return this.dir;
	}

	/** 入队一条记录；不抛错（写失败/已关闭只 warn）。同步返回，落盘异步节流。 */
	append(rec: JournalRecord): void {
		if (this.closed || this.closing) return; // close 后 no-op：TTL 驱逐竞态防线
		this.pending.push(rec);
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, JOURNAL_FLUSH_MS);
		// 节流计时器不保持事件循环：进程退出不被 journal 拖住（诊断流语义）。
		this.flushTimer.unref?.();
	}

	/** 立即落盘当前积压并等待写入完成（close 与测试用）。幂等：无积压即 resolve。 */
	async flush(): Promise<void> {
		if (!this.stream || this.pending.length === 0) return;
		const lines = this.pending
			.map((r) => JSON.stringify(r))
			.join("\n");
		this.pending = [];
		const s = this.stream;
		await new Promise<void>((resolve, reject) => {
			s.write(lines + "\n", (err) => (err ? reject(err) : resolve()));
		}).catch((err) => {
			// 写失败只 warn 不抛（append-only 诊断流，阻断事件广播是更重的错）。
			console.warn(`[pi-runtime] events journal write failed: ${(err as Error).message}`);
		});
	}

	/** flush 并关句柄；幂等。 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closing = true;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		await this.flush();
		const s = this.stream;
		this.stream = undefined;
		this.closed = true;
		this.closing = false;
		if (!s) return;
		await new Promise<void>((resolve) => s.end(() => resolve()));
	}
}

/** 读整个 journal；损坏行跳过（warn 由调用方日志体系承担，此处静默计数）。 */
export async function readJournal(dir: string): Promise<JournalRecord[]> {
	const path = journalPath(dir);
	if (!existsSync(path)) return [];
	const recs: JournalRecord[] = [];
	const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as JournalRecord;
			if (typeof parsed?.seq === "number" && parsed?.event) recs.push(parsed);
		} catch {
			// 损坏行 fail-soft：进程崩溃截断的半行，跳过。
		}
	}
	return recs;
}

/**
 * 跨重启的 nextSeq 恢复：= max(seq)+1；空（旧会话无 journal）⇒ 0。
 * ⭐ 空语义必须对齐 SessionEntry.nextSeq 初始值 0（生产首条事件 seq=0，
 * 实测于 session-journal.test.ts）——返回 1 会让新事件跳过 seq=0，
 * 与「未持久化历史」的会话游标基准不一致。
 */
export function recoverNextSeq(records: JournalRecord[]): number {
	let max = -1;
	for (const r of records) if (r.seq > max) max = r.seq;
	return max + 1;
}
