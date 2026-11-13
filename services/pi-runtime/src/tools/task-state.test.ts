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

test("summarize: 多项 in_progress → 追加软提醒（spec §5，不硬校验）", () => {
	const s = summarize([
		{ id: "plan-1", content: "起稿", status: "in_progress" },
		{ id: "plan-2", content: "配图", status: "in_progress", activeForm: "正在配图" },
	]);
	assert.ok(s.includes("共 2 项"));
	assert.ok(s.includes("正在配图"));
	assert.ok(s.includes("多项进行中"), "应含软提醒");
	// 单项进行中不提醒
	const s1 = summarize([{ id: "plan-1", content: "起稿", status: "in_progress" }]);
	assert.ok(!s1.includes("多项进行中"));
});

test("renderTodoBlock: 三态标记渲染", () => {
	const block = renderTodoBlock([
		{ id: "plan-1", content: "起稿", status: "completed" },
		{ id: "plan-2", content: "配图", status: "in_progress" },
		{ id: "plan-3", content: "导出", status: "pending" },
	]);
	assert.ok(block.startsWith("## 当前任务清单"));
	// A-2' 拍板 3：行格式加 id（- [x] plan-1 content）——模型可见 id 视图
	assert.ok(block.includes("[x] plan-1 起稿"));
	assert.ok(block.includes("[~] plan-2 配图"));
	assert.ok(block.includes("[ ] plan-3 导出"));
});

// ---- P1-2（spec 2026-11-11-propose-plan-visibility-design.md §8）：pickLatestSnapshot 识别 propose_plan ----
test("pickLatestSnapshot: 仅 propose_plan（details.todo.snapshot，P0 形态）⇒ 播种任务卡", () => {
	const snap = pickLatestSnapshot([
		{ type: "message", message: { role: "user" } },
		{
			type: "tool_result",
			toolName: "propose_plan",
			details: {
				ok: true,
				todo: { snapshot: [{ id: "plan-1", content: "写脚本", status: "pending" }] },
				plan: { summary: "三步出片", steps: [{ id: "plan-1", content: "写脚本", status: "pending" }] },
			},
		},
	]);
	assert.equal(snap.length, 1);
	assert.equal(snap[0].id, "plan-1");
	assert.equal(snap[0].content, "写脚本");
	assert.equal(snap[0].status, "pending");
});

test("pickLatestSnapshot: 仅 propose_plan 兜底 details.plan.steps（无 todo 键）⇒ 同样播种", () => {
	const snap = pickLatestSnapshot([
		{
			type: "message",
			message: {
				toolName: "propose_plan",
				details: { ok: true, plan: { summary: "s", steps: [{ id: "plan-2", content: "封面", status: "pending", activeForm: "正在封面" }] } },
			},
		},
	]);
	assert.equal(snap.length, 1);
	assert.equal(snap[0].content, "封面");
	assert.equal(snap[0].activeForm, "正在封面");
});

test("pickLatestSnapshot: todo_write 与 propose_plan 皆有 ⇒ 反向扫描取时间序最新", () => {
	const snap = pickLatestSnapshot([
		{ type: "tool_result", toolName: "propose_plan", details: { todo: { snapshot: [{ id: "plan-1", content: "旧提案", status: "pending" }] } } },
		{ type: "tool_result", toolName: "todo_write", details: { todo: { snapshot: [{ id: "plan-1", content: "旧提案", status: "completed" }] } } },
	]);
	assert.equal(snap[0].status, "completed"); // todo_write 更新在后 ⇒ 最新胜出
	const snap2 = pickLatestSnapshot([
		{ type: "tool_result", toolName: "todo_write", details: { todo: { snapshot: [{ id: "plan-1", content: "旧", status: "completed" }] } } },
		{ type: "tool_result", toolName: "propose_plan", details: { todo: { snapshot: [{ id: "plan-1", content: "旧", status: "pending" }, { id: "plan-2", content: "新步骤", status: "pending" }] } } },
	]);
	assert.equal(snap2.length, 2); // refine 后重新提案 ⇒ 新快照（含新增步骤）胜出
	assert.equal(snap2[1].content, "新步骤");
});

test("pickLatestSnapshot: propose_plan 垃圾 details ⇒ 不崩、继续向前扫", () => {
	const snap = pickLatestSnapshot([
		{ type: "tool_result", toolName: "propose_plan", details: "junk" },
		{ type: "tool_result", toolName: "todo_write", details: { todo: { snapshot: [{ id: "plan-1", content: "有效", status: "pending" }] } } },
	]);
	assert.equal(snap.length, 1);
	assert.equal(snap[0].content, "有效");
});

// ===== A-2' 模型侧 id 契约（spec 2026-11-13-a2-model-side-id-contract-design.md §7）=====

test("A-2' ①: 带 id 重命名——content 变、id 存活、发 list（identity 断裂消解）", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "补全2张核心图表（CAPEX对比图、DeepSeek影响力图）", status: "in_progress" },
	];
	const diff = reduce(prev, [{ id: "plan-1", content: "补全2张核心图表（CAPEX对比图✓、DeepSeek影响力图⏳）", status: "in_progress" }]);
	assert.ok(diff.list, "重命名 = content 集合变化 ⇒ list 事件");
	assert.equal(diff.list![0].id, "plan-1", "identity 存活");
	assert.equal(diff.updates.length, 0, "status 未变 ⇒ 无 updates（互斥三分法）");
});

test("A-2' ③: 部分 id + content 兜底混合——id 通道与兜底通道并存", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "任务甲", status: "pending" },
		{ id: "plan-2", content: "任务乙", status: "pending" },
	];
	const diff = reduce(prev, [
		{ id: "plan-1", content: "任务甲（修订版）", status: "in_progress" }, // id 通道：重命名 + status 变
		{ content: "任务乙", status: "completed" }, // content 兜底：续 plan-2
	]);
	assert.ok(diff.list);
	assert.equal(diff.list![0].id, "plan-1");
	assert.equal(diff.list![0].content, "任务甲（修订版）");
	assert.equal(diff.list![1].id, "plan-2", "未带 id 项按 content 兜底续 id");
	assert.equal(diff.list![1].status, "completed");
});

test("A-2' ④: 带 id 项 content 撞另一 item——id 为准，另一项走新项路径（裁决 2）", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "甲", status: "pending" },
		{ id: "plan-2", content: "乙", status: "pending" },
	];
	// 提交：{id:plan-2, content:甲}（乙的 id + 甲的 content）+ {content:乙}（未带 id）
	const diff = reduce(prev, [
		{ id: "plan-2", content: "甲", status: "pending" }, // id 为准：plan-2 身份锁定、content 重命名为甲
		{ content: "乙", status: "pending" }, // content 兜底：plan-2 已被占用 ⇒ 新项
	]);
	assert.ok(diff.list);
	assert.equal(diff.list![0].id, "plan-2");
	assert.equal(diff.list![0].content, "甲");
	assert.notEqual(diff.list![1].id, "plan-2", "旧乙的 id 被占用，第二项走新项");
	assert.notEqual(diff.list![1].id, "plan-1");
	assert.equal(diff.list![1].content, "乙");
});

test("A-2' ⑤: 同调用重复 id——usedIds 防双用，第二项判新项（非拒绝，裁决 2 原文）", () => {
	const prev: TodoItemWithId[] = [{ id: "plan-1", content: "甲", status: "pending" }];
	const diff = reduce(prev, [
		{ id: "plan-1", content: "甲改", status: "pending" },
		{ id: "plan-1", content: "乙", status: "pending" },
	]);
	assert.ok(diff.list);
	assert.equal(diff.list![0].id, "plan-1");
	assert.equal(diff.list![0].content, "甲改");
	assert.notEqual(diff.list![1].id, "plan-1", "plan-1 双用被防，第二项新 id");
	assert.equal(diff.list![1].content, "乙");
});

test("A-2' ⑥a: renderTodoBlock 渲染 id（拍板 3：模型可见 id 视图）", () => {
	const block = renderTodoBlock([
		{ id: "plan-1", content: "甲", status: "completed" },
		{ id: "plan-2", content: "乙", status: "in_progress" },
	]);
	assert.ok(block.includes("[x] plan-1 甲"), `实际：${block.split("\n")[2]}`);
	assert.ok(block.includes("[~] plan-2 乙"));
});

test("A-2' ⑦: 双项交换重命名（都带 id）——删除检测不触发，仍必须发 list（变异自检补口）", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "甲", status: "pending" },
		{ id: "plan-2", content: "乙", status: "pending" },
	];
	const diff = reduce(prev, [
		{ id: "plan-1", content: "乙", status: "pending" }, // 甲→乙
		{ id: "plan-2", content: "甲", status: "pending" }, // 乙→甲（content 集合不变）
	]);
	assert.ok(diff.list, "content 双向交换 = 结构变化 ⇒ list（updates 会让前端漏刷 content）");
	assert.equal(diff.list![0].id, "plan-1");
	assert.equal(diff.list![0].content, "乙");
	assert.equal(diff.list![1].id, "plan-2");
	assert.equal(diff.list![1].content, "甲");
});
