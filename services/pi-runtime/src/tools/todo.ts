/** C1 todo_write：任务清单全量覆写工具（spec 2026-10-09-task-tool-design.md §3.1）。
 * 状态存会话内存 store（seed 自 transcript details 快照）；details 随工具结果持久化，
 * fork/branch 天然跟随（官方 examples/extensions/todo.ts 同构模式）。
 * ⚠️ sessionId 语义注意：todo 状态作用域取 LnkpiToolContext.sessionId——它不是 pi 会话键
 * （见 types.ts 注释），但同一会话内取值恒定，作为内存 store 键足够；transcript 重建
 * （Task 4 播种）在 pi 会话键维度进行，二者经 seedTodoState 键对齐（见 session-manager
 * 接线处的取键约定）。 */
import { Type } from "typebox";
import type { AgentToolResult, AgentHarnessToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import { reduce, summarize, type TodoDiff, type TodoItemInput, type TodoItemWithId } from "./task-state.js";

export function isTodoToolEnabled(): boolean {
	return process.env.PI_RUNTIME_TODO_TOOL !== "off";
}

interface TodoSessionState {
	items: TodoItemWithId[];
	counter: number;
}

const store = new Map<string, TodoSessionState>();
const STORE_CAP = 1000; // 会话级 LRU 上限防泄漏；会话正常路径由 seed/覆盖驱动

function stateFor(key: string): TodoSessionState {
	let s = store.get(key);
	if (!s) {
		s = { items: [], counter: 1 };
		store.set(key, s);
		if (store.size > STORE_CAP) {
			const first = store.keys().next().value;
			if (first !== undefined && first !== key) store.delete(first);
		}
	}
	return s;
}

/** session-manager 在会话 open/resume/rebuild 后播种（transcript 重建）。 */
export function seedTodoState(key: string, items: TodoItemWithId[]): void {
	const counter = items.reduce((m, it) => Math.max(m, Number(it.id.slice("plan-".length)) || 0), 0) + 1;
	store.set(key, { items: [...items], counter });
}

export function getTodoState(key: string): TodoItemWithId[] {
	return store.get(key)?.items ?? [];
}

/** 测试隔离用。 */
export function resetTodoStoreForTest(): void {
	store.clear();
}

const todoSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			id: Type.Optional(
				Type.String({ description: "任务项 id（当前清单已存在的 plan-N）。变更已有任务时带上对应 id：身份保留，content 可改写（重命名）。新增任务省略 id。" }),
			),
			content: Type.String({ description: "任务项内容（祈使句）" }),
			activeForm: Type.Optional(Type.String({ description: "进行时文案，执行中卡片主文案（如「正在配图」）" })),
			status: Type.Union(
				[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
				{ description: "任务状态" },
			),
		}),
		{ description: "完整任务清单（全量覆写：每次必须包含全部任务，漏发即删；至多一个 in_progress；全部完成时提交空数组清空）" },
	),
});

/** 全量覆写唯一入口（C3：propose_plan 复用同一条写管道，spec §3.2「不做两步组合」）。 */
export function overwriteTodos(sessionId: string, todos: TodoItemInput[]): { snapshot: TodoItemWithId[]; diff: TodoDiff } {
	const state = stateFor(sessionId);
	// 漏发告警（Review Focus #3）：prev 未完成项从 next 消失——A-2' 后按 id 或 content 双通道
	// 对账：id 存活（重命名）或 content 逐字匹配任一成立即不算 dropped（重命名不误报）。
	const nextIds = new Set(todos.filter((t) => t.id !== undefined).map((t) => t.id as string));
	const nextContents = new Set(todos.map((t) => t.content));
	const dropped = state.items.filter(
		(i) => i.status !== "completed" && !nextIds.has(i.id) && !nextContents.has(i.content),
	);
	if (dropped.length > 0) {
		console.warn(
			`[todo_write] dropped-incomplete session=${sessionId} items=${JSON.stringify(dropped.map((d) => d.content))}`,
		);
	}
	const diff = reduce(state.items, todos);
	const nextItems = diff.list ?? state.items.map((prev) => {
		const upd = diff.updates.find((u) => u.id === prev.id);
		return upd ? { ...prev, status: upd.status } : prev;
	});
	state.items = nextItems;
	return { snapshot: nextItems, diff };
}

/** A-2' 拍板 1：幻觉/已删除 id ⇒ 工具级硬拒绝（非软容错）。校验键与 overwriteTodos
 * 同源（storeScopeKey ?? sessionId，C4 取键约定）；拒绝零副作用、无快照事件；
 * 回执附完整合法 id 清单（防误伤设计）+ 单次自纠回路。 */
function rejectUnknownIds(params: { todos: TodoItemInput[] }, key: string): string | null {
	const legal = getTodoState(key);
	const legalIds = new Set(legal.map((i) => i.id));
	const offending = params.todos.filter((t) => t.id !== undefined && !legalIds.has(t.id));
	if (offending.length === 0) return null;
	const listing = legal.length
		? legal.map((i) => `- ${i.id} ${i.content}（${i.status}）`).join("\n")
		: "（当前清单为空）";
	return `调用被拒绝：id 不存在于当前任务清单（${offending.map((o) => o.id).join("、")}）。当前合法 id：\n${listing}\n请带正确 id 重发（变更已有任务），或对新增任务省略 id。`;
}

export function buildTodoTools(): LnkpiTool[] {
	if (!isTodoToolEnabled()) return [];
	const tool: LnkpiTool = {
		name: "todo_write",
		label: "任务清单",
		tier: "write_light",
		summary: "维护多步任务清单（全量覆写）",
		description:
			"维护当前会话的任务清单，用于多步任务（≥3 步）执行透明化。约定：1) 全量覆写——每次调用必须包含全部任务项，漏发历史项等同删除；2) 任意时刻至多一项 in_progress；3) 全部完成时提交空数组清空清单；4) 变更已有任务时带上其 id（content 可改写=重命名），新增任务省略 id。",
		parameters: todoSchema,
		executionMode: "sequential",
		replay: "safe",
		async execute(
			_toolCallId: string,
			params: { todos: TodoItemInput[] },
			_onUpdate: AgentHarnessToolUpdateCallback<{ todo: { snapshot: TodoItemWithId[]; diff: TodoDiff } }>,
			toolContext: LnkpiToolContext,
			_invocation: unknown,
			_context: unknown,
		): Promise<AgentToolResult<{ todo: { snapshot: TodoItemWithId[]; diff: TodoDiff } }>> {
			// C4（评审 C1）：store 键走 storeScopeKey（子会话=自身键）——直接用 sessionId 时
			// 子 run 的 todo_write 会覆写主会话（同画布 id）的 C1 清单，fork 隔离被击穿。
			const key = toolContext.storeScopeKey ?? toolContext.sessionId;
			// A-2' 拍板 1：幻觉 id 硬拒绝（先于任何写入）
			const rejection = rejectUnknownIds(params, key);
			if (rejection !== null) {
				return { content: [{ type: "text", text: rejection }], isError: true };
			}
			const { snapshot, diff } = overwriteTodos(key, params.todos);
			return {
				content: [{ type: "text", text: summarize(snapshot) }],
				details: { todo: { snapshot, diff } },
			};
		},
	};
	return [tool];
}
