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

test("pickLatestSnapshot: vendor 真实形态（message 包裹 toolResult）→ 可读", () => {
	// 2026-10-09 生产 probe 实测：lane.findEntries 返回 {type:"message", message:{role:"toolResult", toolName, details}}
	const entries = [
		{ type: "message", message: { role: "user", content: [] } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo_write",
				details: { todo: { snapshot: [{ id: "plan-1", content: "起稿", status: "in_progress" }] } },
			},
		},
	];
	const snap = pickLatestSnapshot(entries);
	assert.equal(snap[0]?.content, "起稿");
	assert.equal(snap[0]?.status, "in_progress");
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
