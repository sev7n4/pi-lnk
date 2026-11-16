/** C1 任务清单状态模块（spec 2026-10-09-task-tool-design.md §3.2）。
 * 纯函数、与工具实现分离——本模块即 B 期（增量多工具）的扩展缝：
 * B 期在此加 applyIncremental(snapshot, op)（fold 进全量后走同一管道），
 * todo_write 保留不删。全量快照 = SSOT（B→A 不可逆红线，勿加旁路）。 */

import type { TodoAcceptance } from "./acceptance.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

/** C-2a：验收声明挂在任务项上（spec 2026-11-14-c2a-acceptance-generation-oracle-design.md §4.1）。
 * 类型定义单点在 acceptance.ts；本模块只引用，避免 schema 与运行态两处漂移。 */
export interface TodoItem {
	content: string;
	activeForm?: string;
	status: TodoStatus;
	acceptance?: TodoAcceptance;
}

export interface TodoItemWithId extends TodoItem {
	id: string;
}

/** A-2' 模型侧输入形态（spec 2026-11-13-a2-model-side-id-contract-design.md §3.1）：
 * id 可选——带 id 且存在于当前快照 ⇒ 身份锁定（content 变 = 重命名，identity 存活）；
 * 未带 id 走 content 兜底（裁决 4，现行不变）。输出侧 TodoItemWithId 形态零变化。 */
export type TodoItemInput = TodoItem & { id?: string };

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

export function reduce(prev: readonly TodoItemWithId[], next: readonly TodoItemInput[]): TodoDiff {
	// 计数器：历史最大 n + 1（不回收，防删除后新项复用旧 id 造成前端对账错乱）
	let counter = prev.reduce((m, it) => Math.max(m, idNumber(it.id)), 0) + 1;
	const prevByContent = new Map<string, TodoItemWithId>();
	for (const it of prev) if (!prevByContent.has(it.content)) prevByContent.set(it.content, it);
	// A-2'：id 优先索引（裁决 2：id 优先于 content）
	const prevById = new Map<string, TodoItemWithId>();
	for (const it of prev) prevById.set(it.id, it);

	const out: TodoItemWithId[] = [];
	const usedIds = new Set<string>();
	const updates: Array<{ id: string; status: TodoStatus }> = [];
	let structureChanged = false;

	for (const item of next) {
		// C-2a：acceptance 是「调用级验收声明」，不进入快照 SSOT——所有分支显式列字段，
		// 不用 {...item} 展开，避免「id 通道丢字段 / content 兜底带字段」的分支不一致，
		// 也避免收尾阶段因 acceptance 变化触发全量 list 造成前端卡片抖动（spec §3.2）。
		const fields = {
			content: item.content,
			status: item.status,
			...(item.activeForm !== undefined ? { activeForm: item.activeForm } : {}),
		};
		if (item.id !== undefined) {
			// A-2' id 通道：带 id 且存在 ⇒ 身份锁定（幻觉 id 已在 todo_write execute 层硬拒；
			// 此处 else 分支为防御兜底：不存在的 id 按新项处理，不抛错）
			const matched = prevById.get(item.id);
			if (matched && !usedIds.has(matched.id)) {
				usedIds.add(matched.id);
				out.push({ ...fields, id: matched.id });
				if (matched.content !== item.content) structureChanged = true; // 重命名 = content 集合变化 ⇒ list
				if (matched.status !== item.status) updates.push({ id: matched.id, status: item.status });
				continue;
			}
			structureChanged = true;
			out.push({ ...fields, id: `plan-${counter++}` });
			continue;
		}
		const matched = prevByContent.get(item.content);
		if (matched && !usedIds.has(matched.id)) {
			usedIds.add(matched.id);
			out.push({ ...fields, id: matched.id });
			if (matched.status !== item.status) updates.push({ id: matched.id, status: item.status });
		} else {
			structureChanged = true;
			out.push({ ...fields, id: `plan-${counter++}` });
		}
	}

	// 删除检测：身份判定——prev 项存活当且仅当被某 next 项认领（id 通道或 content 兜底
	// 均写入 usedIds）。旧启发式按 content 集合判定，重复 content 场景「按 id 删其一」
	// 会被静默吞掉（review Important #1：无 list、无 updates，store 保留全部项）；
	// 身份判定在非重复场景与旧启发式逐场景等价（重命名/纯删/混合）。
	if (prev.some((p) => !usedIds.has(p.id))) structureChanged = true;

	if (structureChanged) return { list: out, updates: [] };
	return { updates };
}

/** B-2 一等账本条目形态（plan 2026-11-16-b2-task-contract-custom-entry-plan.md §3-D1）。
 * `v !== 1` 的条目忽略（向前兼容：未来版本字段变更时旧 reader 不误读）。 */
export interface TaskEntryPayload {
	v: 1;
	kind: "todo" | "plan";
	snapshot?: TodoItemWithId[];
	decision?: string;
	diff?: unknown;
}

const TASK_ENTRY_CUSTOM_TYPE = "lnkpi.task";

/** 从单条 entry 提取 B-2 一等任务条目（customType 命中 + v===1）。不命中返回 undefined。 */
export function readTaskEntry(e: unknown): TaskEntryPayload | undefined {
	const o = e as { type?: unknown; customType?: unknown; data?: unknown } | null;
	if (o?.type !== "custom" || o.customType !== TASK_ENTRY_CUSTOM_TYPE) return undefined;
	const d = o.data as TaskEntryPayload | undefined;
	if (!d || typeof d !== "object" || d.v !== 1) return undefined;
	if (d.kind !== "todo" && d.kind !== "plan") return undefined;
	return d;
}

/** 规范化快照条目（与 fallback 分支同规则：content/id 必填，status 收敛三态）。 */
function normalizeSnapshotItems(snap: readonly unknown[]): TodoItemWithId[] {
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

/** 从会话 transcript 条目（任意形态）反向扫描最后一个任务清单快照。
 * B-2 起两源并存、**最新条目胜出**（plan §3-D3）：
 * ① 首选源：`custom` entry（customType "lnkpi.task"，v===1）——一等写入，形态自持；
 * ② fallback：toolResult details 副作用反扫（防御式三层兼容，观察期后退役——退场判据
 *    见 plan §5：custom 连续 7 天覆盖全部终态）。
 * P1-2 背景（spec 2026-11-11-propose-plan-visibility-design.md §8）：propose_plan 经
 * overwriteTodos 落清单但不写 todo_write transcript 条目——fallback 识别
 * details.todo.snapshot（P0 形态）兜底 details.plan.steps。两源不一致时触发
 * `opts.onMismatch`（观测层打点不告警，人工裁决，plan §5）。 */
export function pickLatestSnapshot(
	entries: readonly unknown[],
	opts?: { onMismatch?: () => void },
): TodoItemWithId[] {
	let customHit: TodoItemWithId[] | undefined;
	let fallbackHit: TodoItemWithId[] | undefined;
	let customHitIndex = -1;
	let fallbackHitIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e) continue;
		// ① 一等源（custom entry）
		const task = readTaskEntry(e);
		if (task && Array.isArray(task.snapshot)) {
			if (!customHit) {
				customHit = normalizeSnapshotItems(task.snapshot);
				customHitIndex = i;
			}
			continue;
		}
		if (customHit && fallbackHit) break; // 两源最新都已命中，再扫无增益
		// ② fallback：toolResult details 副作用（原有三层防御式形态，原样保留）
		const o = e as {
			toolName?: string;
			details?: unknown;
			result?: { details?: unknown };
			message?: { toolName?: string; details?: unknown; result?: { details?: unknown } };
		} | null;
		if (!o) continue;
		let raw: unknown;
		if (o.toolName === "todo_write" || o.toolName === "propose_plan") {
			raw = o.details ?? o.result?.details;
		} else if (o.message?.toolName === "todo_write" || o.message?.toolName === "propose_plan") {
			raw = o.message.details ?? o.message.result?.details;
		} else {
			continue;
		}
		const p = raw as { todo?: { snapshot?: unknown }; plan?: { steps?: unknown } } | undefined;
		const snap =
			(Array.isArray(p?.todo?.snapshot) ? p?.todo?.snapshot : undefined) ??
			(Array.isArray(p?.plan?.steps) ? p?.plan?.steps : undefined);
		if (!Array.isArray(snap)) continue;
		if (!fallbackHit) {
			fallbackHit = normalizeSnapshotItems(snap);
			fallbackHitIndex = i;
		}
	}
	if (customHit && fallbackHit && JSON.stringify(customHit) !== JSON.stringify(fallbackHit)) {
		opts?.onMismatch?.();
	}
	// 「最新胜出」：索引更大 = 时间序更晚（反扫不改判定方向）。
	const customLater = customHitIndex >= fallbackHitIndex;
	return customHit && fallbackHit
		? (customLater ? customHit : fallbackHit)
		: (customHit ?? fallbackHit ?? []);
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

/** 跨压缩动态块渲染（spec §3.4；A-2' 拍板 3：行格式加 id——模型可见 id 视图的唯一来源，
 * 每轮 LLM 请求经 assembleDynamicBlocks 重新求值注入）。 */
export function renderTodoBlock(items: readonly TodoItemWithId[]): string {
	const lines = items.map((i) => {
		const mark = i.status === "completed" ? "[x]" : i.status === "in_progress" ? "[~]" : "[ ]";
		return `- ${mark} ${i.id} ${i.content}`;
	});
	return ["## 当前任务清单（todo_write 维护，跨压缩保留）", ...lines].join("\n");
}
