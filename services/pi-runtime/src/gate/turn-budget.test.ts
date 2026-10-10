/**
 * C2 turnBudget 状态机单测（spec §3.1-3.3 + §5 Review Focus 1/4）。
 * 计数铁律：只计 runId 与当前 run 一致的 turn_start（vendor turn_start.runId =
 * drive.operationId，generation.ts:163 —— compaction 独立 operation 自动排除）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createTurnBudgetState,
	turnBudgetOnTurnStart,
	turnBudgetRunEnd,
	turnBudgetRunStart,
} from "./turn-budget.js";

test("异 runId（compaction/navigation）不计入", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	for (let i = 0; i < 10; i++) {
		assert.equal(turnBudgetOnTurnStart(s, "op-compaction", 3), "ignore");
	}
	assert.equal(s.count, 0, "压缩轮再多也不得推进计数");
});

test("无窗口（未 run_start / 已 run_end）不计入", () => {
	const s = createTurnBudgetState();
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "ignore");
	turnBudgetRunStart(s, "op-1");
	turnBudgetRunEnd(s);
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "ignore");
});

test("budget=3：首轮 warn（阈值预算-10 的字面语义）、第 4 轮 exceed", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "warn");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "exceed");
	assert.equal(s.count, 4);
});

test("budget=15：warn 恰好在第 5 轮（=budget-10）触发且仅一次", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	const actions = Array.from({ length: 16 }, () => turnBudgetOnTurnStart(s, "op-1", 15));
	assert.equal(actions.filter((a) => a === "warn").length, 1);
	assert.equal(actions[4], "warn", "第 5 轮 = budget-10");
	assert.equal(actions[15], "exceed", "第 16 轮 > budget");
});

test("settled 闸：exceed 后重复 turn_start 返回 count（结算期漂移无害，Review Focus 4）", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	for (let i = 0; i < 5; i++) turnBudgetOnTurnStart(s, "op-1", 3);
	assert.equal(s.settled, true);
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count", "不得重复 exceed");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count");
});

test("run 重启复位：warned/settled/count 全清（下一 run 从 0 起）", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	for (let i = 0; i < 5; i++) turnBudgetOnTurnStart(s, "op-1", 3);
	turnBudgetRunEnd(s);
	turnBudgetRunStart(s, "op-2");
	assert.equal(s.count, 0);
	assert.equal(s.warned, false);
	assert.equal(s.settled, false);
	assert.equal(turnBudgetOnTurnStart(s, "op-2", 3), "warn", "新 run 的 warn 独立判定");
});

test("防御：budget<=0 一律 ignore（配置层已保证正数，此处兜底）", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 0), "ignore");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", -3), "ignore");
});
