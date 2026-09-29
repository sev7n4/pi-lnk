/**
 * 磁盘会话保留策略（spec §4 磁盘上限判据、§5.2 D2）。
 *
 * 纪律：TTL 永不删磁盘；删磁盘只由本模块的 LRU 触发，且**跳过 active 集合**
 * （内存中活跃的会话目录不得被删，否则正在进行的 run 会丢工作目录）。
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface RetentionEntry {
	key: string;
	bytes: number;
	mtimeMs: number;
}

export interface RetentionLimits {
	maxBytes: number;
	maxCount: number;
}

/** 按 mtime 升序淘汰，直到 count 与 bytes 双双回到限内；active 永不入选。 */
export function pickLruVictims(
	entries: RetentionEntry[],
	limits: RetentionLimits,
	active: ReadonlySet<string>,
): RetentionEntry[] {
	const candidates = entries.filter((x) => !active.has(x.key)).sort((a, b) => a.mtimeMs - b.mtimeMs);
	let count = entries.length;
	let bytes = entries.reduce((sum, x) => sum + x.bytes, 0);
	const victims: RetentionEntry[] = [];
	for (const candidate of candidates) {
		if (count <= limits.maxCount && bytes <= limits.maxBytes) break;
		victims.push(candidate);
		count -= 1;
		bytes -= candidate.bytes;
	}
	return victims;
}

/** 扫描 dataRoot 下的会话目录（一层子目录），累计字节与最近活跃时间。根不存在返回空。 */
export async function collectSessionDirs(dataRoot: string): Promise<RetentionEntry[]> {
	let names: string[];
	try {
		const dirents = await readdir(dataRoot, { withFileTypes: true });
		names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
	const entries: RetentionEntry[] = [];
	for (const name of names) {
		const dir = join(dataRoot, name);
		try {
			const st = await stat(dir);
			entries.push({
				key: name,
				bytes: await directoryBytes(dir),
				// 复核 Minor #7：LRU 判据必须是「最近使用」而非「创建时刻」。追加历史发生在
				// <key>/sessions/ 内层文件，顶层目录 mtime 只反映目录条目变化（≈创建时刻）——
				// 只看它会把用了几个月的活跃对话排进最旧队列，LRU 退化成 FIFO。
				mtimeMs: await lastActivityMs(dir, st.mtimeMs),
			});
		} catch {
			// 扫描竞态（目录刚被删）：跳过，不影响其余条目
		}
	}
	return entries;
}

/** 内层会话文件的最大 mtime；内层不可读时回退顶层目录 mtime。 */
async function lastActivityMs(dir: string, fallbackMs: number): Promise<number> {
	const sessionsDir = join(dir, "sessions");
	let names: string[];
	try {
		names = (await readdir(sessionsDir, { withFileTypes: true })).map((d) => d.name);
	} catch {
		return fallbackMs;
	}
	let newest = fallbackMs;
	for (const name of names) {
		const st = await stat(join(sessionsDir, name)).catch(() => null);
		if (st && st.mtimeMs > newest) newest = st.mtimeMs;
	}
	return newest;
}

async function directoryBytes(dir: string): Promise<number> {
	let total = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		const dirents = await readdir(current, { withFileTypes: true }).catch(() => []);
		for (const dirent of dirents) {
			const path = join(current, dirent.name);
			if (dirent.isDirectory()) {
				stack.push(path);
				continue;
			}
			const st = await stat(path).catch(() => null);
			if (st) total += st.size;
		}
	}
	return total;
}

/** 执行一次保留扫描；返回被删除的会话 key 列表。 */
export async function enforceRetention(
	dataRoot: string,
	limits: RetentionLimits,
	active: ReadonlySet<string>,
): Promise<string[]> {
	const entries = await collectSessionDirs(dataRoot);
	const victims = pickLruVictims(entries, limits, active);
	for (const victim of victims) {
		await rm(join(dataRoot, victim.key), { recursive: true, force: true }).catch(() => {});
	}
	return victims.map((v) => v.key);
}
