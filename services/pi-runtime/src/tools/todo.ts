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
import { reduce, summarize, type TodoDiff, type TodoItem, type TodoItemWithId } from "./task-state.js";

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
			content: Type.String({ description: "任务项内容（祈使句，字面精确匹配用于状态追踪）" }),
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
export function overwriteTodos(sessionId: string, todos: TodoItem[]): { snapshot: TodoItemWithId[]; diff: TodoDiff } {
	const state = stateFor(sessionId);
	// 漏发告警（Review Focus #3）：prev 未完成项从 next 消失
	const nextContents = new Set(todos.map((t) => t.content));
	const dropped = state.items.filter((i) => i.status !== "completed" && !nextContents.has(i.content));
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

export function buildTodoTools(): LnkpiTool[] {
	if (!isTodoToolEnabled()) return [];
	const tool: LnkpiTool = {
		name: "todo_write",
		label: "任务清单",
		tier: "write_light",
		summary: "维护多步任务清单（全量覆写）",
		description:
			"维护当前会话的任务清单，用于多步任务（≥3 步）执行透明化。约定：1) 全量覆写——每次调用必须包含全部任务项，漏发历史项等同删除；2) 任意时刻至多一项 in_progress；3) 全部完成时提交空数组清空清单；4) 内容一经提交请勿改写（字面匹配用于追踪状态）。",
		parameters: todoSchema,
		executionMode: "sequential",
		replay: "safe",
		async execute(
			_toolCallId: string,
			params: { todos: TodoItem[] },
			_onUpdate: AgentHarnessToolUpdateCallback<{ todo: { snapshot: TodoItemWithId[]; diff: TodoDiff } }>,
			toolContext: LnkpiToolContext,
			_invocation: unknown,
			_context: unknown,
		): Promise<AgentToolResult<{ todo: { snapshot: TodoItemWithId[]; diff: TodoDiff } }>> {
			const { snapshot, diff } = overwriteTodos(toolContext.sessionId, params.todos);
			return {
				content: [{ type: "text", text: summarize(snapshot) }],
				details: { todo: { snapshot, diff } },
			};
		},
	};
	return [tool];
}
