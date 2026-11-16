/**
 * B-1 toolset-overlay 纯函数测试（plan 2026-11-16-b1-gate-toolset-narrow-plan.md §2-D3/D4）。
 * 行为级（wiring 直调 fake lane）在 plan-gate-wiring.test.ts；这里钉差分语义边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNarrow, computeRestore } from "./toolset-overlay.js";

const TIERS = new Map<string, string | undefined>([
	["w1", "write_light"],
	["w2", "destructive"],
	["g", "gen"],
	["gb", "graph_batch"],
	["r", "read"],
	["u", "ui_command"],
	["s", "skill"],
	["x", undefined], // 注册表外 / tier 未知
]);

test("computeNarrow：只移除 gated tier 写工具；豁免名单与未知 tier 放行", () => {
	const out = computeNarrow(["w1", "w2", "g", "gb", "todo_write", "spawn_subagent", "r", "u", "s", "x"], TIERS);
	assert.deepEqual(out.sort(), ["g", "gb", "w1", "w2"]);
});

test("computeNarrow：豁免名单（todo_write/spawn_subagent）即使 tier gated 也不移除", () => {
	const tiers = new Map([
		["todo_write", "write_light"],
		["spawn_subagent", "write_light"],
	]);
	assert.deepEqual(computeNarrow(["todo_write", "spawn_subagent"], tiers), []);
});

test("computeRestore：合并加回去重，保留现集（tool_search 激活不被覆盖）", () => {
	assert.deepEqual(
		computeRestore(["r", "undo"], ["w1", "w2"]),
		["r", "undo", "w1", "w2"],
	);
	assert.deepEqual(
		computeRestore(["r", "w1"], ["w1"]), // 已在现集的 removed 不重复
		["r", "w1"],
	);
});
