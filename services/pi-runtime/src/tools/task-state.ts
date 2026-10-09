/** C1 任务清单状态模块（spec 2026-10-09-task-tool-design.md §3.2）。
 * 纯函数、与工具实现分离——本模块即 B 期（增量多工具）的扩展缝：
 * B 期在此加 applyIncremental(snapshot, op)（fold 进全量后走同一管道），
 * todo_write 保留不删。全量快照 = SSOT（B→A 不可逆红线，勿加旁路）。 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	activeForm?: string;
	status: TodoStatus;
}

export interface TodoItemWithId extends TodoItem {
	id: string;
}

/** diff：结构变化（增/删）→ 全量 list；仅状态变化 → updates。二者互斥。
 * 纯重排（内容集合不变、仅顺序变）**不产生任何事件**（spec §3.2：防前端卡片抖动），
 * 内存态保持既有顺序——渲染顺序与模型提交顺序的漂移是可接受的表象代价。 */
export interface TodoDiff {
	list?: TodoItemWithId[];
	updates: Array<{ id: string; status: TodoStatus }>;
}

function idNumber(id: string): number {
	const n = Number(id.slice("plan-".length));
	return Number.isFinite(n) ? n : 0;
}

export function reduce(prev: readonly TodoItemWithId[], next: readonly TodoItem[]): TodoDiff {
	// 计数器：历史最大 n + 1（不回收，防删除后新项复用旧 id 造成前端对账错乱）
	let counter = prev.reduce((m, it) => Math.max(m, idNumber(it.id)), 0) + 1;
	const prevByContent = new Map<string, TodoItemWithId>();
	for (const it of prev) if (!prevByContent.has(it.content)) prevByContent.set(it.content, it);

	const out: TodoItemWithId[] = [];
	const usedIds = new Set<string>();
	const updates: Array<{ id: string; status: TodoStatus }> = [];
	let structureChanged = false;

	for (const item of next) {
		const matched = prevByContent.get(item.content);
		if (matched && !usedIds.has(matched.id)) {
			usedIds.add(matched.id);
			out.push({ ...item, id: matched.id });
			if (matched.status !== item.status) updates.push({ id: matched.id, status: item.status });
		} else {
			structureChanged = true;
			out.push({ ...item, id: `plan-${counter++}` });
		}
	}

	// 删除检测：prev 中有 content 不在 next
	const nextContents = new Set(next.map((i) => i.content));
	if (prev.some((p) => !nextContents.has(p.content))) structureChanged = true;

	if (structureChanged) return { list: out, updates: [] };
	return { updates };
}

/** 从会话 transcript 条目（任意形态）反向扫描最后一个 todo_write 快照。
 * 防御式字段访问：vendor entry 形态随版本可能变化——2026-10-09 生产 probe 实测形态为
 * `{type:"message", message:{role:"toolResult", toolName, details}}`（message 包裹层），
 * 同时保留官方 todo.ts 同构的顶层 `{toolName, details}` 与 `{result:{details}}` 兼容。 */
export function pickLatestSnapshot(entries: readonly unknown[]): TodoItemWithId[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as {
			toolName?: string;
			details?: unknown;
			result?: { details?: unknown };
			message?: { toolName?: string; details?: unknown; result?: { details?: unknown } };
		} | null;
		if (!e) continue;
		let raw: unknown;
		if (e.toolName === "todo_write") {
			raw = e.details ?? e.result?.details;
		} else if (e.message?.toolName === "todo_write") {
			raw = e.message.details ?? e.message.result?.details;
		} else {
			continue;
		}
		const snap = (raw as { todo?: { snapshot?: unknown } } | undefined)?.todo?.snapshot;
		if (!Array.isArray(snap)) continue;
		const items: TodoItemWithId[] = [];
		for (const it of snap) {
			const o = it as { id?: unknown; content?: unknown; status?: unknown; activeForm?: unknown };
			if (typeof o?.content !== "string" || typeof o?.id !== "string") continue;
			const status = o.status === "completed" || o.status === "in_progress" ? o.status : "pending";
			items.push({
				id: o.id,
				content: o.content,
				status,
				...(typeof o.activeForm === "string" ? { activeForm: o.activeForm } : {}),
			});
		}
		return items;
	}
	return [];
}

/** 模型可见返回值：紧凑摘要（spec §3.1——禁回显全量 JSON）。
 * spec §5：不硬校验不矫正，多项 in_progress 时工具结果文本一次性软提醒（模型自纠回路）。 */
export function summarize(items: readonly TodoItemWithId[]): string {
	if (items.length === 0) return "任务清单已清空";
	const inProgressItems = items.filter((i) => i.status === "in_progress");
	const done = items.filter((i) => i.status === "completed").length;
	const focus = inProgressItems.length
		? `，进行中：${inProgressItems.map((i) => i.activeForm ?? i.content).join("、")}`
		: "";
	const multi = inProgressItems.length > 1 ? "；注意：存在多项进行中，建议只保留一项" : "";
	return `任务清单已更新：共 ${items.length} 项${focus}；已完成 ${done} 项${multi}`;
}

/** 跨压缩动态块渲染（spec §3.4）。 */
export function renderTodoBlock(items: readonly TodoItemWithId[]): string {
	const lines = items.map((i) => {
		const mark = i.status === "completed" ? "[x]" : i.status === "in_progress" ? "[~]" : "[ ]";
		return `- ${mark} ${i.content}`;
	});
	return ["## 当前任务清单（todo_write 维护，跨压缩保留）", ...lines].join("\n");
}
