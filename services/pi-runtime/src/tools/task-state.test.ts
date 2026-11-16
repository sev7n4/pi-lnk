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

test("A-2' ⑧: 重复 content 按 id 删其一——身份判定删除检测（review Important #1）", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "X", status: "pending" },
		{ id: "plan-2", content: "X", status: "pending" },
	];
	// 全量覆写意图：只保留 plan-1，删除 plan-2
	const diff = reduce(prev, [{ id: "plan-1", content: "X", status: "pending" }]);
	assert.ok(diff.list, "按 id 删其一 = 结构变化 ⇒ list（旧 content 启发式静默吞掉）");
	assert.equal(diff.list!.length, 1);
	assert.equal(diff.list![0].id, "plan-1");
});

test("A-2' ⑧b: content 兜底也能认领重复项其一（删除检测对兜底通道同样生效）", () => {
	const prev: TodoItemWithId[] = [
		{ id: "plan-1", content: "X", status: "pending" },
		{ id: "plan-2", content: "X", status: "pending" },
	];
	// 不带 id 提交 1 项 ⇒ 兜底认领 plan-1（首个），plan-2 被删 ⇒ list
	const diff = reduce(prev, [{ content: "X", status: "in_progress" }]);
	assert.ok(diff.list, "兜底通道认领 plan-1 后 plan-2 未被认领 ⇒ list");
	assert.equal(diff.list![0].id, "plan-1");
	assert.equal(diff.list![0].status, "in_progress");
});

// ═══ B-2 一等账本读取（plan 2026-11-16-b2-task-contract-custom-entry-plan.md §3-D3）═══

import { readTaskEntry } from "./task-state.js";

const item = (id: string, content: string, status = "pending") => ({ id, content, status });

const customEntry = (data: unknown, _id = "e1") => ({ type: "custom", customType: "lnkpi.task", data });

const fallbackEntry = (toolName: string, snapshot: unknown, wrapped = false) =>
	wrapped
		? { type: "message", message: { role: "toolResult", toolName, details: { todo: { snapshot } } } }
		: { toolName, details: { todo: { snapshot } } };

test("B-2 readTaskEntry: customType/v/kind 三重门——不匹配一律 undefined", () => {
	assert.equal(readTaskEntry({ toolName: "todo_write", details: {} }), undefined, "type 非 custom");
	assert.equal(
		readTaskEntry({ type: "custom", customType: "other.task", data: { v: 1, kind: "todo" } }),
		undefined,
		"customType 不匹配",
	);
	assert.equal(
		readTaskEntry({ type: "custom", customType: "lnkpi.task", data: { v: 2, kind: "todo" } }),
		undefined,
		"v≠1 忽略（向前兼容）",
	);
	assert.equal(
		readTaskEntry({ type: "custom", customType: "lnkpi.task", data: { v: 1, kind: "bogus" } }),
		undefined,
		"kind 非法",
	);
	const ok = readTaskEntry(customEntry({ v: 1, kind: "todo", snapshot: [item("a", "x")] }));
	assert.ok(ok, "合法条目命中");
	assert.equal(ok!.kind, "todo");
});

test("B-2 pickLatestSnapshot: 一等源命中——custom entry 反扫胜出", () => {
	const entries = [
		fallbackEntry("todo_write", [item("old", "旧")]),
		customEntry({ v: 1, kind: "todo", snapshot: [item("n1", "新1"), item("n2", "新2")] }),
	];
	assert.deepEqual(pickLatestSnapshot(entries), [
		{ id: "n1", content: "新1", status: "pending" },
		{ id: "n2", content: "新2", status: "pending" },
	]);
});

test("B-2 pickLatestSnapshot: fallback 兼容——无 custom entry 时三层防御形态原样工作", () => {
	// 顶层形态
	assert.deepEqual(pickLatestSnapshot([fallbackEntry("todo_write", [item("a", "A")])]), [
		{ id: "a", content: "A", status: "pending" },
	]);
	// message 包裹层（2026-10-09 生产 probe 形态）
	assert.deepEqual(pickLatestSnapshot([fallbackEntry("todo_write", [item("a", "A")], true)]), [
		{ id: "a", content: "A", status: "pending" },
	]);
	// propose_plan P0 兜底（details.plan.steps）
	const planEntry = { toolName: "propose_plan", details: { plan: { steps: [item("p", "P")] } } };
	assert.deepEqual(pickLatestSnapshot([planEntry]), [{ id: "p", content: "P", status: "pending" }]);
	// status 收敛：非法值归 pending
	assert.equal(pickLatestSnapshot([fallbackEntry("todo_write", [{ id: "x", content: "X", status: "bogus" }])])[0].status, "pending");
});

test("B-2 pickLatestSnapshot: 最新胜出——fallback 在 custom 之后 ⇒ fallback 赢", () => {
	const entries = [
		customEntry({ v: 1, kind: "todo", snapshot: [item("c", "custom侧")] }),
		fallbackEntry("todo_write", [item("f", "fallback侧")]),
	];
	assert.deepEqual(pickLatestSnapshot(entries), [{ id: "f", content: "fallback侧", status: "pending" }]);
});

test("B-2 pickLatestSnapshot: 双轨一致不打 mismatch，不一致打点（观测层人工裁决）", () => {
	const same = [
		customEntry({ v: 1, kind: "todo", snapshot: [item("a", "同")] }),
		fallbackEntry("todo_write", [item("a", "同")]),
	];
	let calls = 0;
	pickLatestSnapshot(same, { onMismatch: () => calls++ });
	assert.equal(calls, 0, "一致不打点");

	const diff = [
		customEntry({ v: 1, kind: "todo", snapshot: [item("a", "甲")] }),
		fallbackEntry("todo_write", [item("a", "乙")]),
	];
	pickLatestSnapshot(diff, { onMismatch: () => calls++ });
	assert.equal(calls, 1, "不一致打点一次");
});

test("B-2 compaction 存活（验收锚 1）：compaction entry 前后的 custom 条目反扫一致", () => {
	// compaction 后视图会丢 cut 前 entry，但 ledger（findEntries）全保留——
	// 重建读 ledger：compaction entry（无 snapshot 字段）天然 skip，cut 前 custom 仍命中。
	const ledger = [
		customEntry({ v: 1, kind: "todo", snapshot: [item("pre", "压缩前")] }),
		{ type: "compaction", summary: "...", retainedTail: [] },
		customEntry({ v: 1, kind: "todo", snapshot: [item("post", "压缩后")] }),
	];
	assert.deepEqual(pickLatestSnapshot(ledger), [{ id: "post", content: "压缩后", status: "pending" }]);
	// 压缩后无新写入：cut 前（压缩前）最新条目仍可重建
	const ledger2 = [
		customEntry({ v: 1, kind: "todo", snapshot: [item("pre", "压缩前")] }),
		{ type: "compaction", summary: "...", retainedTail: [] },
	];
	assert.deepEqual(pickLatestSnapshot(ledger2), [{ id: "pre", content: "压缩前", status: "pending" }]);
});

test("B-2 kind=plan 无 snapshot 的 entry 不抢 snapshot 源（P1-2 兜底语义不变）", () => {
	const entries = [
		{ toolName: "todo_write", details: { todo: { snapshot: [item("t", "真清单")] } } },
		customEntry({ v: 1, kind: "plan", decision: "keep" }), // 无 snapshot
	];
	assert.deepEqual(pickLatestSnapshot(entries), [{ id: "t", content: "真清单", status: "pending" }]);
});
