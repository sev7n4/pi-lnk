# C1 任务清单工具化（todo_write）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `⟦plan⟧` 文本协议升级为 pi-runtime 的 `todo_write` 工具（全量覆写 + details 快照持久化 + diff 派生现有事件 + 跨压缩注入），前端零迁移。

**Architecture:** 单工具全量覆写，服务端 SSOT（`task-state` 纯函数模块）→ diff 随工具 `details` 经 `tool_execution_end` 透传到 Nest → Nest 提取并映射为现有 `task_list`/`task_update` 事件；快照经 transcript 重建后注入 `composeEntryAndObserve` 动态块（跨压缩存活）。

**Tech Stack:** TypeScript / pi-runtime（node:test + tsx）/ Nest（vitest + zod）/ vendored `@earendil-works/pi-agent-core@0.85.1`（harness 原生面，零 patch）。

**Spec:** `docs/superpowers/specs/2026-10-09-task-tool-design.md`（v1.1）+ 总体设计 `docs/superpowers/specs/2026-10-09-task-management-module-design.md`。执行前两份都要读。

## Global Constraints

- 零 vendor patch、零新 Prisma 表、零新 npm 依赖、pi-runtime 不新增 vendor 子路径 import。
- Kill switch env：`PI_RUNTIME_TODO_TOOL`（`off` = 关闭；其余值 = 开启）。**Nest 与 pi-runtime 是两个部署单元，两侧各配同一 env 名**，上线检查单必须核对一致。
- 事件 wire 词汇默认保持既有 `running`/`done`（Task 3 验证后可升三态，见该任务裁决步骤）。
- 事件 id 前缀沿用 `plan-<n>`；n 单调递增不回收（content 匹配保 id 稳定）。
- 分支：在 `spec/todo-task-tool`（已含 3 个 docs commits）上继续实现；**禁 `git add -A`**，每步只 add 显式路径。
- 测试命令：pi-runtime = `pnpm --filter @pi-lnk/pi-runtime test`（node --test + tsx）；Nest = `pnpm --filter @lnkpi/server exec vitest run <file>`。
- ⚠️ 本机 Bash cwd 会话内会静默重置：每条命令用绝对路径或 `git -C /Users/4seven/workspace/pi-lnk`。

## Review Focus（规格隐含但单测不易覆盖的五类输入）

1. **content 重复或含首尾空白的清单项** → 匹配键不得串位、id 不得复用（Task 1 锁）。
2. **超大清单（100+ 项）** → renderTodoBlock 与 summarize 不炸 dynamic 预算，超预算时按既有机制丢弃并计 `onDrop`（Task 4 锁）。
3. **模型漏发历史未完成项**（全量覆写最危险输入）→ 工具侧 warn 日志 + 快照仍按提交执行（Task 2 锁），指标口径见 spec §6.1。
4. **kill switch 双侧漂移**：prompt 教了工具但 pi-runtime 未注册 → 模型收到明确 isError（Task 2 锁，双侧一致性靠上线检查单）。
5. **老会话 ⟦plan⟧ 标记 + 新工具并存** → resume 后首个 todo_write 触发单卡替换、不双卡（Task 3 锁）。

---

### Task 0: 通路验证 spike（前置，半天内）

**Files:**
- Read: `services/pi-runtime/src/session-manager.ts:1069-1160`（attachEvents 归一化）
- Read: `apps/server/src/agent/pi-runtime/pi-events.ts:351-369`（extractCanvasActions——生产已读 details 的先例）
- Modify: `docs/superpowers/specs/2026-10-09-task-tool-design.md`（§3.3 载荷裁决小节回写结论）

**Interfaces:**
- Produces: §3.3 裁决结论一行（透传 / 需补透传），后续 Task 3 依赖此结论。

- [ ] **Step 1: 确认归一化层**

读 `session-manager.ts` 的 attachEvents（约 1069-1160 行），确认 `tool_end` 事件在归一化为 SSE `tool_execution_end` 时 `result.details` 是否原样保留（`extractCanvasActions` 在生产读 `event.data.result.details.actions`，B-5 已上线——预期结论是"已透传"）。

- [ ] **Step 2: 回写 spec**

在 spec §3.3"事件载体裁决"小节追加一行：`2026-10-09 裁决：attachEvents 原样透传 result.details（extractCanvasActions 生产先例），Task 3 直接走透传路径，无需 EVENT_MAP 改动。`（若 Step 1 发现剥离，则改记"需补透传"并把补透传列入 Task 3。）

- [ ] **Step 3: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add docs/superpowers/specs/2026-10-09-task-tool-design.md
git -C /Users/4seven/workspace/pi-lnk commit -m "docs(spec): C1 Task0 通路裁决——tool_execution_end details 透传确认"
```

---

### Task 1: `task-state` 纯函数模块（TDD）

**Files:**
- Create: `services/pi-runtime/src/tools/task-state.ts`
- Test: `services/pi-runtime/src/tools/task-state.test.ts`

**Interfaces:**
- Produces（Task 2/4 依赖，签名逐字）：
  - `type TodoStatus = "pending" | "in_progress" | "completed"`
  - `interface TodoItem { content: string; activeForm?: string; status: TodoStatus }`
  - `interface TodoItemWithId extends TodoItem { id: string }`
  - `interface TodoDiff { list?: TodoItemWithId[]; updates: Array<{ id: string; status: TodoStatus }> }`
  - `reduce(prev: readonly TodoItemWithId[], next: readonly TodoItem[]): TodoDiff`
  - `pickLatestSnapshot(entries: readonly unknown[]): TodoItemWithId[]`
  - `summarize(items: readonly TodoItemWithId[]): string`
  - `renderTodoBlock(items: readonly TodoItemWithId[]): string`

- [ ] **Step 1: 写失败测试**

```ts
// services/pi-runtime/src/tools/task-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, pickLatestSnapshot, summarize, renderTodoBlock, type TodoItemWithId } from "./task-state.js";

test("reduce: 首次提交（prev 空）→ 全量 list，id 从 plan-1 起", () => {
	const diff = reduce([], [
		{ content: "起稿", status: "in_progress" },
		{ content: "配图", status: "pending" },
	]);
	assert.equal(diff.list?.length, 2);
	assert.equal(diff.list?.[0].id, "plan-1");
	assert.equal(diff.list?.[1].id, "plan-2");
	assert.deepEqual(diff.updates, []);
});

test("reduce: content 匹配——同项状态变更只发 updates，id 稳定", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "起稿", status: "in_progress" },
		{ id: "plan-2", content: "配图", status: "pending" },
	];
	const diff = reduce(prev, [
		{ content: "起稿", status: "completed" },
		{ content: "配图", status: "pending" },
	]);
	assert.equal(diff.list, undefined);
	assert.deepEqual(diff.updates, [{ id: "plan-1", status: "completed" }]);
});

test("reduce: 重排顺序不产生任何事件（id 跟 content 走）", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "起稿", status: "in_progress" },
		{ id: "plan-2", content: "配图", status: "pending" },
	];
	const diff = reduce(prev, [
		{ content: "配图", status: "pending" },
		{ content: "起稿", status: "in_progress" },
	]);
	assert.equal(diff.list, undefined);
	assert.deepEqual(diff.updates, []);
});

test("reduce: 新增或删除 → 全量 list（新 id 单调递增不回收）", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "起稿", status: "completed" },
		{ id: "plan-2", content: "配图", status: "pending" },
	];
	const diff = reduce(prev, [
		{ content: "起稿", status: "completed" },
		{ content: "精修", status: "in_progress" },
	]);
	assert.equal(diff.list?.length, 2);
	assert.equal(diff.list?.find((i) => i.content === "起稿")?.id, "plan-1"); // 保号
	assert.equal(diff.list?.find((i) => i.content === "精修")?.id, "plan-3"); // 不回收 plan-2
	assert.deepEqual(diff.updates, []);
});

test("reduce: 重复 content 不得复用同一 prev id（防串位）", () => {
	const prev: TodoItemWithId[] = [{ id: "plan-1", content: "配图", status: "pending" }];
	const diff = reduce(prev, [
		{ content: "配图", status: "pending" },
		{ content: "配图", status: "completed" },
	]);
	const ids = diff.list?.map((i) => i.id) ?? [];
	assert.equal(new Set(ids).size, ids.length); // id 唯一
});

test("reduce: content 首尾空白不与原项匹配（按字面精确匹配）", () => {
	const prev: TodoItemWithId[] = [{ id: "plan-1", content: "起稿", status: "pending" }];
	const diff = reduce(prev, [{ content: " 起稿 ", status: "pending" }]);
	assert.equal(diff.list?.length, 1); // 视为新增
	assert.equal(diff.list?.[0].id, "plan-2");
});

test("reduce: 空数组 = 清空清单", () => {
	const diff = reduce([{ id: "plan-1", content: "起稿", status: "pending" }], []);
	assert.deepEqual(diff.list, []);
});

test("pickLatestSnapshot: 尾部反向扫描遇首个 todo_write 即停", () => {
	const entries = [
		{ type: "tool_result", toolName: "read", details: { x: 1 } },
		{ type: "tool_result", toolName: "todo_write", details: { todo: { snapshot: [{ id: "plan-1", content: "旧", status: "pending" }] } } },
		{ type: "message", role: "assistant" },
		{ type: "tool_result", toolName: "todo_write", details: { todo: { snapshot: [{ id: "plan-1", content: "新", status: "completed" }] } } },
	];
	const snap = pickLatestSnapshot(entries);
	assert.equal(snap[0].content, "新");
});

test("pickLatestSnapshot: 无 todo_write / 畸形 details → 空数组", () => {
	assert.deepEqual(pickLatestSnapshot([{ type: "tool_result", toolName: "read" }]), []);
	assert.deepEqual(pickLatestSnapshot([{ type: "tool_result", toolName: "todo_write", details: "junk" }]), []);
	assert.deepEqual(pickLatestSnapshot([]), []);
});

test("summarize: 紧凑摘要，不回显全量 JSON", () => {
	const s = summarize([
		{ id: "plan-1", content: "起稿", status: "completed" },
		{ id: "plan-2", content: "配图", status: "in_progress", activeForm: "正在配图" },
	]);
	assert.ok(s.includes("共 2 项"));
	assert.ok(s.includes("正在配图"));
	assert.ok(s.includes("已完成 1 项"));
	assert.ok(!s.includes("plan-1"));
});

test("renderTodoBlock: 三态标记渲染", () => {
	const block = renderTodoBlock([
		{ id: "plan-1", content: "起稿", status: "completed" },
		{ id: "plan-2", content: "配图", status: "in_progress" },
		{ id: "plan-3", content: "导出", status: "pending" },
	]);
	assert.ok(block.startsWith("## 当前任务清单"));
	assert.ok(block.includes("[x] 起稿"));
	assert.ok(block.includes("[~] 配图"));
	assert.ok(block.includes("[ ] 导出"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/task-state.test.ts`
Expected: FAIL（`Cannot find module './task-state.js'`）

- [ ] **Step 3: 最小实现**

```ts
// services/pi-runtime/src/tools/task-state.ts
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

/** diff：结构变化（增/删/重排）→ 全量 list；仅状态变化 → updates。二者互斥。 */
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
	// 重排检测：匹配项的相对顺序变化（无增删也可能重排）
	if (!structureChanged && updates.length === 0) {
		// 快路径：无增删无状态变化时才需要查重排
		const prevOrder = prev.filter((p) => usedIds.has(p.id)).map((p) => p.id);
		const outOrder = out.map((i) => i.id);
		for (let i = 0; i < prevOrder.length; i++) {
			if (prevOrder[i] !== outOrder[i]) {
				structureChanged = true;
				break;
			}
		}
	}

	if (structureChanged) return { list: out, updates: [] };
	return { updates };
}

/** 从会话 transcript 条目（任意形态）反向扫描最后一个 todo_write 快照。
 * 防御式字段访问：vendor entry 形态随版本可能变化（tool_result 顶层或包在 message 内）。 */
export function pickLatestSnapshot(entries: readonly unknown[]): TodoItemWithId[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { toolName?: string; details?: unknown; result?: { details?: unknown } } | null;
		if (!e || e.toolName !== "todo_write") continue;
		const raw = (e.details ?? e.result?.details) as { todo?: { snapshot?: unknown } } | undefined;
		const snap = raw?.todo?.snapshot;
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

/** 模型可见返回值：紧凑摘要（spec §3.1——禁回显全量 JSON）。 */
export function summarize(items: readonly TodoItemWithId[]): string {
	if (items.length === 0) return "任务清单已清空";
	const inProgress = items.find((i) => i.status === "in_progress");
	const done = items.filter((i) => i.status === "completed").length;
	const focus = inProgress ? `，进行中：${inProgress.activeForm ?? inProgress.content}` : "";
	return `任务清单已更新：共 ${items.length} 项${focus}；已完成 ${done} 项`;
}

/** 跨压缩动态块渲染（spec §3.4）。 */
export function renderTodoBlock(items: readonly TodoItemWithId[]): string {
	const lines = items.map((i) => {
		const mark = i.status === "completed" ? "[x]" : i.status === "in_progress" ? "[~]" : "[ ]";
		return `- ${mark} ${i.content}`;
	});
	return ["## 当前任务清单（todo_write 维护，跨压缩保留）", ...lines].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/task-state.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add services/pi-runtime/src/tools/task-state.ts services/pi-runtime/src/tools/task-state.test.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(pi-runtime): task-state 纯函数模块——全量 diff（content 匹配键）+ 快照重建"
```

---

### Task 2: `todo_write` 工具 + kill switch + 注册

**Files:**
- Create: `services/pi-runtime/src/tools/todo.ts`
- Test: `services/pi-runtime/src/tools/todo.test.ts`
- Modify: `services/pi-runtime/src/tools/config.ts:34-43,58-72`（注册，含 NEST 缺失分支）

**Interfaces:**
- Consumes: Task 1 全部导出；`LnkpiTool`（`src/tools/types.ts:71`）；`LnkpiToolContext.sessionId`。
- Produces:
  - `buildTodoTools(): LnkpiTool[]`（config.ts 调用）
  - `seedTodoState(key: string, items: TodoItemWithId[]): void`（Task 4 的 session-manager 调用）
  - `getTodoState(key: string): TodoItemWithId[]`（Task 4 的 dynamicBlock 调用）
  - `isTodoToolEnabled(): boolean`（Task 5 的 Nest 规则装配同 env 名对齐）
  - details 载荷形状：`{ todo: { snapshot: TodoItemWithId[], diff: TodoDiff } }`（Task 3 消费）

- [ ] **Step 1: 写失败测试**

```ts
// services/pi-runtime/src/tools/todo.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildTodoTools, seedTodoState, getTodoState, resetTodoStoreForTest } from "./todo.js";
import type { LnkpiToolContext } from "./types.js";

const ctx = { sessionId: "sess-A" } as LnkpiToolContext;

beforeEach(() => resetTodoStoreForTest());

function tool() {
	const [t] = buildTodoTools();
	if (t.name !== "todo_write") throw new Error("todo_write 未注册");
	return t;
}

test("首次调用：返回快照 + diff（全量 list）+ 紧凑摘要 content", async () => {
	const res = await tool().execute("call-1", { todos: [{ content: "起稿", status: "in_progress" }] }, undefined, ctx);
	assert.ok(!res.isError);
	assert.equal((res.details as { todo: { snapshot: unknown[] } }).todo.snapshot.length, 1);
	assert.equal((res.details as { todo: { diff: { list?: unknown[] } } }).todo.diff.list?.length, 1);
	assert.ok(String(res.content[0].text).includes("共 1 项"));
});

test("状态不变更的重复提交 → 空更新 + 幂等", async () => {
	const t = tool();
	await t.execute("c1", { todos: [{ content: "起稿", status: "pending" }] }, undefined, ctx);
	const res = await t.execute("c2", { todos: [{ content: "起稿", status: "pending" }] }, undefined, ctx);
	assert.deepEqual((res.details as { todo: { diff: { updates: unknown[] } } }).todo.diff.updates, []);
	assert.equal((res.details as { todo: { diff: { list?: unknown[] } } }).todo.diff.list, undefined);
});

test("kill switch off → buildTodoTools 返回空数组", () => {
	process.env.PI_RUNTIME_TODO_TOOL = "off";
	try {
		assert.deepEqual(buildTodoTools(), []);
	} finally {
		delete process.env.PI_RUNTIME_TODO_TOOL;
	}
});

test("漏发告警：prev 未完成项从 next 消失 → console.warn（结构化前缀）", async () => {
	const t = tool();
	await t.execute("c1", {
		todos: [
			{ content: "起稿", status: "in_progress" },
			{ content: "配图", status: "pending" },
		],
	}, undefined, ctx);
	const warnings: string[] = [];
	const orig = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
	try {
		await t.execute("c2", { todos: [{ content: "配图", status: "pending" }] }, undefined, ctx);
	} finally {
		console.warn = orig;
	}
	assert.ok(warnings.some((w) => w.includes("[todo_write] dropped-incomplete")));
});

test("seed/get：session-manager 播种后 getTodoState 可读，工具调用覆盖播种值", async () => {
	seedTodoState("sess-B", [{ id: "plan-1", content: "旧任务", status: "pending" }]);
	assert.equal(getTodoState("sess-B")[0].content, "旧任务");
	await tool().execute("c1", { todos: [{ content: "新任务", status: "pending" }] }, undefined, {
		sessionId: "sess-B",
	} as LnkpiToolContext);
	assert.equal(getTodoState("sess-B")[0].content, "新任务");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/todo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现工具**

先看一眼任一现有工具（建议 `src/tools/memory.ts` 或 `arrange-nodes.ts`）的 schema import 路径与 execute 签名（6 参 AgentHarnessTool），对齐后写：

```ts
// services/pi-runtime/src/tools/todo.ts
/** C1 todo_write：任务清单全量覆写工具（spec 2026-10-09-task-tool-design.md §3.1）。
 * 状态存会话内存 store（seed 自 transcript details 快照）；details 随工具结果持久化，
 * fork/branch 天然跟随（官方 examples/extensions/todo.ts 同构模式）。 */
import { Type } from "@sinclair/typebox"; // ← 以现有工具实际 import 路径为准对齐
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
			_signal: unknown,
			_onUpdate: unknown,
			toolContext: LnkpiToolContext,
		): Promise<AgentToolResult<{ todo: { snapshot: TodoItemWithId[]; diff: TodoDiff } }>> {
			const state = stateFor(toolContext.sessionId);
			// 漏发告警（Review Focus #3）：prev 未完成项从 next 消失
			const nextContents = new Set(params.todos.map((t) => t.content));
			const dropped = state.items.filter((i) => i.status !== "completed" && !nextContents.has(i.content));
			if (dropped.length > 0) {
				console.warn(
					`[todo_write] dropped-incomplete session=${toolContext.sessionId} items=${JSON.stringify(dropped.map((d) => d.content))}`,
				);
			}
			const diff = reduce(state.items, params.todos);
			const nextItems = diff.list ?? state.items.map((prev) => {
				const upd = diff.updates.find((u) => u.id === prev.id);
				return upd ? { ...prev, status: upd.status } : prev;
			});
			state.items = nextItems;
			return {
				content: [{ type: "text", text: summarize(nextItems) }],
				details: { todo: { snapshot: nextItems, diff } },
			};
		},
	};
	return [tool];
}
```

注意：execute 签名以现有工具为准（研究记录为 6 参：`toolCallId, params, signal, onUpdate, toolContext, invocation`——若实际为 6 参，补第 6 参 `_invocation`）。若 `LnkpiTool` 要求 `parameters` 字段名不同（如 `inputSchema`），以 `types.ts:71` 的 `AgentHarnessTool` 定义为准对齐。

- [ ] **Step 4: 注册进 config.ts**

在 `config.ts` 顶部 import，并在两处注册（todo 不依赖 Nest client，NEST 缺失的纯文本模式也可用）：

```ts
// import 区新增：
import { buildTodoTools, isTodoToolEnabled } from "./todo.js";

// resolveToolsWithClient 的 !cfg 早退分支（原第 42 行）改为：
return { tools: isTodoToolEnabled() ? buildTodoTools() : [], client: null, registry: deps.registry ?? null };

// 正常分支的 tools 数组（原第 58-72 行）首行追加：
const tools: LnkpiTool[] = [
	...(isTodoToolEnabled() ? buildTodoTools() : []),
	...buildCanvasReadTools(client),
	// …其余不动
];
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/todo.test.ts src/tools/config.test.ts`
Expected: PASS（新增用例 + config 既有回归）

- [ ] **Step 6: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add services/pi-runtime/src/tools/todo.ts services/pi-runtime/src/tools/todo.test.ts services/pi-runtime/src/tools/config.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(pi-runtime): todo_write 工具——全量覆写+details 快照+kill switch+注册"
```

---

### Task 3: Nest 事件转译（diff → task_list/task_update）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（新增 extractor，紧邻 `extractCanvasActions`:351）
- Modify: `apps/server/src/agent/agent.service.ts:1282-1315` 附近（事件循环内接线）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`（追加用例；若该文件不存在则新建）+ `apps/server/src/agent/agent.service` 既有事件测试文件（先 grep `task_list` 定位）

**Interfaces:**
- Consumes: Task 2 的 details 载荷 `{ todo: { snapshot, diff } }`（经 `tool_execution_end` 的 `event.data.result.details`，形态对齐 `extractCanvasActions`:353-358）。
- Produces: `extractTaskEvents(event: PiRuntimeEvent): Array<{ type: "task_list" | "task_update"; data: unknown }>`。

- [ ] **Step 1: 前端状态词汇裁决（先读后选）**

读 `apps/web/src/components/agent/taskProgressReconcile.ts`（及 `executionTraceReducer.ts:501-506` 的 case），确认 status 处理：
- 若 reconcile 对未知 status 安全（非 `done` 一律视为未完成、只按 id 对账）→ 选 **V-A 三态透传**；
- 否则（或无法确认）→ 选 **V-B 既有词汇映射**（`completed→done`，其余→`running`；wire 上不出现 pending/in_progress）。
**默认 V-B**（零前端风险）；选定后在 spec §3.3 映射表追加一行裁决结论。以下 Step 2 代码按 V-B 写，V-A 只需把 `mapStatus` 改为恒等。

- [ ] **Step 2: 写失败测试（extractor 纯函数）**

```ts
// 追加到 pi-events 测试（zod 已是既有依赖，见 CanvasActionSchema 同文件用法）
import { extractTaskEvents } from "./pi-events.js";

const mkEnd = (details: unknown, isError = false) => ({
	type: "tool_execution_end",
	data: { isError, result: { details } },
});

test("extractTaskEvents: 结构变化 → 单条 task_list 全量（title=content，activeForm 附加）", () => {
	const events = extractTaskEvents(
		mkEnd({
			todo: {
				snapshot: [],
				diff: {
					list: [
						{ id: "plan-1", content: "起稿", status: "in_progress", activeForm: "正在起稿" },
						{ id: "plan-2", content: "配图", status: "pending" },
					],
					updates: [],
				},
			},
		}),
	);
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "task_list");
	assert.deepEqual(events[0].data, {
		items: [
			{ id: "plan-1", title: "起稿", status: "running", activeForm: "正在起稿" },
			{ id: "plan-2", title: "配图", status: "running" },
		],
	});
});

test("extractTaskEvents: 仅状态变化 → task_update（completed→done，其余→running）", () => {
	const events = extractTaskEvents(
		mkEnd({ todo: { snapshot: [], diff: { updates: [{ id: "plan-1", status: "completed" }] } } }),
	);
	assert.deepEqual(events, [{ type: "task_update", data: { id: "plan-1", status: "done" } }]);
});

test("extractTaskEvents: 非 tool_execution_end / isError / 无 details.todo → 空", () => {
	assert.deepEqual(extractTaskEvents({ type: "message_update", data: {} }), []);
	assert.deepEqual(extractTaskEvents(mkEnd({ todo: { snapshot: [], diff: { updates: [] } } }, true)), []);
	assert.deepEqual(extractTaskEvents(mkEnd({ other: 1 })), []);
});

test("extractTaskEvents: 空 diff（无变化）→ 空（不打扰前端）", () => {
	assert.deepEqual(extractTaskEvents(mkEnd({ todo: { snapshot: [], diff: { updates: [] } } })), []);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-events.test.ts`
Expected: FAIL（`extractTaskEvents` 未导出）

- [ ] **Step 4: 实现 extractor（pi-events.ts）**

```ts
// pi-events.ts —— extractCanvasActions 之后追加
/** C1：todo_write 的 details.todo.diff → task_list/task_update 事件（spec §3.3）。
 * 复刻 extractCanvasActions 的透传读取路径；词汇映射默认 V-B（completed→done，其余→running）。 */
const TaskDiffSchema = z.object({
	todo: z
		.object({
			diff: z.object({
				list: z
					.array(
						z.object({
							id: z.string(),
							content: z.string(),
							status: z.string(),
							activeForm: z.string().optional(),
						}),
					)
					.optional(),
				updates: z.array(z.object({ id: z.string(), status: z.string() })).default([]),
			}),
		})
		.optional(),
});

export interface TaskWireEvent {
	type: "task_list" | "task_update";
	data: unknown;
}

function mapStatus(s: string): string {
	return s === "completed" ? "done" : "running"; // V-B；V-A：直接返回 s
}

export function extractTaskEvents(event: PiRuntimeEvent): TaskWireEvent[] {
	if (event.type !== "tool_execution_end") return [];
	const d = event.data as { isError?: boolean; result?: { details?: unknown } };
	if (d.isError) return [];
	const parsed = TaskDiffSchema.safeParse(d.result?.details);
	if (!parsed.success || !parsed.data.todo) return [];
	const { list, updates } = parsed.data.todo.diff;
	if (list) {
		return [
			{
				type: "task_list",
				data: {
					items: list.map((i) => ({
						id: i.id,
						title: i.content,
						status: mapStatus(i.status),
						...(i.activeForm ? { activeForm: i.activeForm } : {}),
					})),
				},
			},
		];
	}
	if (updates.length === 0) return [];
	return updates.map((u) => ({ type: "task_update", data: { id: u.id, status: mapStatus(u.status) } }));
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-events.test.ts`
Expected: PASS

- [ ] **Step 6: 接线 agent.service.ts 事件循环**

在 `agent.service.ts` 的 `extractCanvasActions` 接线块（约 1311-1315 行）之后追加：

```ts
// C1：todo_write diff → task_list/task_update（todo 面板数据源；与 ⟦plan⟧ 派生路径并存，
// 老标记只读兼容，见 planMarkers.ts deprecation 注释）
for (const task of extractTaskEvents(event)) {
	executionEvents.push(task);
	yield task as AgentStreamEvent;
}
```

import 区加 `extractTaskEvents`（与既有 `extractCanvasActions` 同源）。同时在既有 `stripped.plan` 派生点（约 1336 行）加一行可观测日志（⟦plan⟧ 归零验收的数据源）：

```ts
if (stripped.plan?.length) {
	this.piLogger.info(`[legacy-plan-marker] session=${sessionKey} items=${stripped.plan.length}`); // C1 验收：部署后应恒 0
	// …原有 task_list 派生逻辑不动
}
```

- [ ] **Step 7: 事件流集成测试**

先 `grep -n "task_list" apps/server/src/agent --include="*.test.ts"` 定位既有事件流测试文件（P1#5 的测试），在同一文件追加：构造一条带 `tool_execution_end`（含 todo details）的事件序列喂入既有流式断言 harness，断言 SSE 里出现 `task_list` 且 `executionEvents` 收集到同条目。若无既有可复用 harness，则以 extractor 单测 + Step 6 接线的 grep 级人工复核为准，并在 PR 描述中注明。

- [ ] **Step 8: 全量 Nest 回归**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm test:server`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts apps/server/src/agent/agent.service.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(server): todo_write diff → task_list/task_update 事件转译（V-B 词汇映射）+ legacy-plan-marker 观测"
```

---

### Task 4: 跨压缩注入（transcript 播种 + dynamicBlock）

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（会话 open/resume/rebuild 收敛处播种；`composeEntryAndObserve` 动态块追加）
- Test: `services/pi-runtime/src/session-manager.todo-resume.test.ts`（新建，仿 `session-manager.toolmetrics-realharness.test.ts` 的真 harness 构造段）

**Interfaces:**
- Consumes: Task 1 `pickLatestSnapshot`/`renderTodoBlock`；Task 2 `seedTodoState`/`getTodoState`；Task 3 载荷路径。
- Produces: resume 后 system prompt 含「当前任务清单」块；压缩后仍存在。

- [ ] **Step 1: 确认 transcript 条目迭代 API**

`grep -n "findEntries\|getBranch\|session.entries" vendor/earendil-works/pi/packages/agent/src/harness -r` 与 `grep -n "entries\|lane" services/pi-runtime/src/session-manager.ts | head -30`，确定 SessionManager 持有的对象上可枚举当前分支条目的方法（研究记录候选：`lane.findEntries()`）。**以 grep 实测为准**；Task 1 的 `pickLatestSnapshot` 是防御式解析，只要把条目序列喂进去即可。

- [ ] **Step 2: 写失败测试（resume 后注入）**

先读 `session-manager.toolmetrics-realharness.test.ts` 的 harness 构造段（faux 模型 + `AgentHarness.create`），照抄构造方式；测试主体：

```ts
// session-manager.todo-resume.test.ts（构造段以 realharness 测试为准，以下为断言主体）
test("todo resume：磁盘 resume 后 dynamicBlock 注入最近快照", async () => {
	// 1) 会话内让 faux 模型调用一次 todo_write（details 含 snapshot [{id:'plan-1',content:'起稿',status:'in_progress'}]）
	// 2) 关闭会话（落盘）→ 重新 open（走 resume/rebuild 路径）
	// 3) 断言 composeSystemPrompt 产物包含 "## 当前任务清单" 且包含 "起稿"
	// 4) 断言包含 "[~] 起稿"（in_progress 标记），证明快照经 pickLatestSnapshot 重建而非空播种
});
```

（Step 1 确认 API 后把 1)-3) 写成可执行代码；若 realharness 测试已有「faux 模型调工具」的现成 helper，直接复用。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/session-manager.todo-resume.test.ts`
Expected: FAIL（system prompt 无任务清单块）

- [ ] **Step 4: 实现**

两处改动（`session-manager.ts`）：

```ts
// (a) 会话 open/resume/rebuild 三态收敛处（约 721-816 行区段，三个 return 前的共同出口）：
//     transcript → 播种
import { seedTodoState } from "./tools/todo.js";
import { pickLatestSnapshot } from "./tools/task-state.js";
// entries = Step 1 确认的分支条目枚举结果
seedTodoState(sessionKey, pickLatestSnapshot(entries));

// (b) composeEntryAndObserve 的动态块装配处（grep "dynamicBlocks" 定位，研究记录约 1034 行附近）：
import { getTodoState } from "./tools/todo.js";
import { renderTodoBlock } from "./tools/task-state.js";
// 在既有动态块 push 序列的尾部：
const todoItems = getTodoState(sessionKey);
if (todoItems.length > 0) dynamicBlocks.push(renderTodoBlock(todoItems));
```

预算：动态块进 `composeSystemPrompt(staticPart, dynamicBlocks, budget)`（`session-manager.ts:460-487`）。查 `applyDynamicBudget`/`classifyBlock` 对块分类的方式（grep `classifyBlock`）：若按块头前缀分类，为 `## 当前任务清单` 注册独立 kind（如 `"todo"`），**优先级与画布摘要同级或更高**（这是跨压缩存活的根目的，不允许先被裁）；若分类是白名单制，把新 kind 加进白名单并补 `applyDynamicBudget` 单测一行（超预算时 todo 块最后被丢 + `onDrop("todo")` 计数）。

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/session-manager.todo-resume.test.ts && pnpm --filter @pi-lnk/pi-runtime test`
Expected: PASS（新增 + 既有全量）

- [ ] **Step 6: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.todo-resume.test.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(pi-runtime): todo 快照 transcript 播种 + 跨压缩 dynamicBlock 注入"
```

---

### Task 5: prompt 规则迁移 + ⟦plan⟧ 停教

**Files:**
- Create: `prompt-registry/rules/task_tool.md`
- Modify: `prompt-registry/MANIFEST.yaml`（新增 entry）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts:106-115`（注册 + 条件组）
- Modify: `apps/server/src/agent/pi-runtime/rule-groups.ts`（todoTools 条件组，仿 genTools）
- Modify: `apps/server/src/agent/agent.service.ts:1051-1059`（删 ⟦plan⟧ 硬编码指令段）
- Modify: `apps/server/src/agent/planMarkers.ts:1-2`（JSDoc deprecation）
- Test: 既有 `prompt-registry.loader.test.ts` / `pi-prompt-assembler.service.test.ts` 追加用例

**Interfaces:**
- Consumes: `PI_RUNTIME_TODO_TOOL` env（Nest 侧读同一名字决定规则是否拼入——两侧各配，上线核对）。
- Produces: 新会话 prompt 含 task_tool 规则（todo 启用时）；不含任何 ⟦plan⟧ 教学。

- [ ] **Step 1: 写规则文件**

```markdown
<!-- prompt-registry/rules/task_tool.md -->
## 任务计划汇报（todo_write）

多步任务（≥3 步）开工前，调用 `todo_write` 提交完整任务清单（全量覆写），此后每完成一项即更新对应状态。
清单会实时展示给用户：执行中项显示 activeForm（进行时文案，如「正在配图」）。
规则：全量提交（漏发历史项等同删除）；至多一项 in_progress；全部完成后提交空数组清空。
```

- [ ] **Step 2: MANIFEST + loader 注册（条件组仿 no_gen_claim）**

`MANIFEST.yaml` 追加 entry（`order: 55`，位于 gen_tool_policy 50 与 write_guard 60 之间；`contentHash` 先随便填占位，跑 Step 3 的 loader 测试，按其报错里的期望值回填——loader 测试对 hash 有强校验）：

```yaml
  - id: task_tool
    version: 1.0.0
    order: 55
    contentHash: PLACEHOLDER-FROM-TEST
```

`prompt-registry.loader.ts:106` 的规则清单数组加 `"task_tool"`；`rule-groups.ts` 仿 `genTools` 组新增 `todoTools` 组（unlessGroup 锚点 `"no-todo-tools"`），语义：`PI_RUNTIME_TODO_TOOL=off` 时 `task_tool` 不注入。装配器（`pi-prompt-assembler.service.ts`）按组求值处同步接线——具体锚点参数以 `no_gen_claim.nogen` 在 `prompt-registry.loader.test.ts:62` 的三元组建模为模板。

- [ ] **Step 3: loader/assembler 测试**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`
按失败信息回填 contentHash；追加两个用例：①todo 启用 → assembled prompt 含「任务计划汇报（todo_write）」；②`PI_RUNTIME_TODO_TOOL=off` → 不含。

- [ ] **Step 4: 删 ⟦plan⟧ 硬编码指令 + planMarkers 标注**

删除 `agent.service.ts:1051-1059` 的「任务计划汇报（多步任务时启用）」整段（⟦plan⟧/⟦task-done⟧ 教学）。`planMarkers.ts` 文件头 JSDoc 追加：

```ts
/** @deprecated C1（2026-10-09）：模型已改教 todo_write 工具，本解析器降级为
 * 只读重放兼容层（老会话 resume/刷新的 executionEvents 重放仍需渲染旧卡片）。
 * 退场条件：session-retention TTL 覆盖全部历史会话后整文件删除。
 * 验收：部署后 `[legacy-plan-marker]` 日志恒 0（见 agent.service.ts）。 */
```

**不动** `stripPlanMarkers` 的解析逻辑本身。

- [ ] **Step 5: 全量回归**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm test:server && pnpm --filter @pi-lnk/pi-runtime test`
Expected: PASS。若既有测试断言了旧 ⟦plan⟧ prompt 段存在，按新事实改断言（prompt 段已删、strip 行为保留）。

- [ ] **Step 6: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add prompt-registry/rules/task_tool.md prompt-registry/MANIFEST.yaml apps/server/src/agent/pi-runtime/prompt-registry.loader.ts apps/server/src/agent/pi-runtime/rule-groups.ts apps/server/src/agent/agent.service.ts apps/server/src/agent/planMarkers.ts apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(prompt): task_tool 规则迁入 prompt-registry（条件组）+ ⟦plan⟧ 停教 + 解析器降级 deprecated"
```

---

### Task 6: 收尾——验收清单 + 文档状态 + PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-task-management-module-design.md`（§3 状态列 C1 → 已实现/待验收）
- Create: `docs/ops/2026-10-09-task-tool-delivery-checklist.md`（验收清单）

- [ ] **Step 1: 验收清单文档**

```markdown
# C1 任务清单工具化 上线验收清单

## 部署前
- [ ] 双侧 env 核对：Nest（lnkpi-api 容器）与 pi-runtime（k3s）`PI_RUNTIME_TODO_TOOL` 同值（部署纪律：平台 env 不落 DB）
- [ ] `pnpm test:server && pnpm --filter @pi-lnk/pi-runtime test` 全绿
- [ ] prompt 预算实测：assembled static prompt 字节数 vs 改前基线（余量告警阈值见 spec §5 表）

## 部署后（生产取证）
- [ ] 真实多步出图任务一次：任务卡片出现、状态随执行推进、完成后清空
- [ ] 老会话 resume：旧 ⟦plan⟧ 卡片仍渲染；续聊触发 todo_write 后单卡替换不双卡
- [ ] `[legacy-plan-marker]` 日志 = 0（对照窗口：部署时间戳之后的日志）
- [ ] `[todo_write] dropped-incomplete` 出现率记录为漏发率基线（spec §6.1）
- [ ] 触发一次长会话 compaction：压缩后任务清单块仍在 system prompt（k3s 侧 debug 日志或临时探针）

## 指标建档（spec §6.1）
- [ ] 采用率 / 跨压缩存活率 / 抖动率 / 多 in_progress 率 四项基线落 docs/ops 本文件追记
```

- [ ] **Step 2: 总体设计状态列更新 + commit**

`task-management-module-design.md` §3 表 C1 行状态改 `已实现（待上线验收）`，资产地图同步。提交：

```bash
git -C /Users/4seven/workspace/pi-lnk add docs/superpowers/specs/2026-10-09-task-management-module-design.md docs/ops/2026-10-09-task-tool-delivery-checklist.md
git -C /Users/4seven/workspace/pi-lnk commit -m "docs(ops): C1 实现收尾——验收清单 + 总体设计状态更新"
```

- [ ] **Step 3: PR**

推送与 PR 走仓库纪律：本机 GitHub 断则用「服务器 API + python3 脚本」路径（建分支 ref→推送→开 PR→盯 CI）；PR 描述附本计划链接与 spec 链接，Review Focus 五条写进 PR 的 reviewer 指引。合并盯 CI → 盯部署 → 按 Step 1 清单生产取证。

---

## Self-Review 记录

- **Spec 覆盖**：§3.1 工具（Task 2）/ §3.2 状态模块（Task 1）/ §3.3 转译+映射表（Task 3）/ §3.4 注入（Task 4）/ §3.5 规则迁移（Task 5）/ §5 错误处理（Task 2 漏发告警+kill switch、Task 4 预算）/ §6 测试（Task 1-5）/ §6.1 指标（Task 6 建档）/ §8 B 期预留（task-state 模块注释+Task 1 不变量）。spec §3.4「零快照不注入」在 Task 4 代码 `if (todoItems.length > 0)` 落地。
- **占位符**：Task 0/Task 4 含「以实测 grep 为准」的裁决步骤——均为显式验证步骤（含两个备选的完整代码/动作），非 TBD。MANIFEST contentHash 用「跑测试回填」这一仓库既有机制，非占位。
- **类型一致性**：`TodoDiff`/`TodoItemWithId`/`{ todo: { snapshot, diff } }` 载荷/`extractTaskEvents` 返回形状在 Task 1→2→3→4 间逐字对齐；id 前缀 `plan-` 全程一致。
- **Review Focus → 测试落位**：#1→Task 1（重复 content/空白）、#2→Task 4（预算分类）、#3→Task 2（漏发 warn）、#4→Task 2（buildTodoTools 空）+Task 5（off 不拼规则）、#5→Task 3 集成+Task 6 验收 case。
