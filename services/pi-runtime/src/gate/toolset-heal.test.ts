/**
 * B-1 修复（#906 重启泄漏）— 治愈差分面测试。
 * 纯函数：computeConverged / pickActivatedBySearch（transcript 累计并集）。
 * wiring：healToolsetOnResume 读-比-写 + setToolsetNarrow 归零 + fail-open。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentHarness } from "@earendil-works/pi-agent-core";
import { computeConverged, pickActivatedBySearch } from "./toolset-overlay.js";
import { healToolsetOnResume } from "./plan-gate-wiring.js";
import { getToolsetNarrow, resetPlanState } from "./plan-gate.js";
import type { LnkpiToolContext } from "../tools/types.js";

const BASE = ["todo_write", "fake_write_node", "list_generation_tasks"];

function fakeHarness(active: string[]) {
	const writes: string[][] = [];
	const lane = {
		async getActiveTools() {
			return [...active];
		},
		async setActiveTools(names: string[]) {
			writes.push([...names]);
			active.length = 0;
			active.push(...names);
		},
	};
	const harness = { lane: async () => lane } as unknown as AgentHarness<LnkpiToolContext>;
	return { harness, writes };
}

test("computeConverged：base∪activated 去重、base 序在前、activated 按首现序", () => {
	assert.deepEqual(computeConverged(["a", "b"], ["b", "c", "a"]), ["a", "b", "c"]);
	assert.deepEqual(computeConverged([], ["x"]), ["x"]);
	assert.deepEqual(computeConverged(["a"], []), ["a"]);
});

test("pickActivatedBySearch：多命中累计并集 + message 包裹层 + 垃圾过滤", () => {
	const entries = [
		{ toolName: "tool_search", details: { loaded: ["m1", "m2"] } },
		{ message: { toolName: "tool_search", result: { details: { loaded: ["m2", "m3"] } } } },
		{ toolName: "tool_search", details: { loaded: ["", 42, null, "m1"] } },
		{ toolName: "todo_write", details: { loaded: ["NOT_ACTIVATED"] } },
		{ toolName: "tool_search", details: { loaded: "not-array" } },
		null,
	];
	assert.deepEqual(pickActivatedBySearch(entries), ["m1", "m2", "m3"]);
	assert.deepEqual(pickActivatedBySearch([]), []);
});

test("healToolsetOnResume：盘上收缩残留 ⇒ 写 desired=base∪activated + 记账归零 + restore 计数", async () => {
	const key = "heal-narrow";
	resetPlanState(key);
	const active = [...BASE];
	const { harness, writes } = fakeHarness(active); // 盘上残留收缩态（fake_write_node 被收走）
	const counts: Record<string, number> = {};
	const metrics = { observeToolsetGateNarrow: (k: string) => (counts[k] = (counts[k] ?? 0) + 1) };
	await healToolsetOnResume(harness, BACKGROUND_CONTEXT, key, BASE, ["m1"], metrics as never);
	assert.deepEqual(writes, [["todo_write", "fake_write_node", "list_generation_tasks", "m1"]]);
	assert.deepEqual([...active].sort(), [...computeConverged(BASE, ["m1"])].sort());
	assert.equal(getToolsetNarrow(key).narrowed, false, "记账归零（防旧 removed 覆空语义）");
	assert.equal(counts.restore, 1);
	resetPlanState(key);
});

test("healToolsetOnResume：零偏差 ⇒ 零写盘（cache 零扰动）+ 记账仍归零", async () => {
	const key = "heal-idle";
	resetPlanState(key);
	const active = [...BASE];
	const { harness, writes } = fakeHarness(active);
	await healToolsetOnResume(harness, BACKGROUND_CONTEXT, key, BASE, [], undefined);
	assert.deepEqual(writes, [], "零偏差零写");
	assert.equal(getToolsetNarrow(key).narrowed, false);
	resetPlanState(key);
});

test("healToolsetOnResume：lane 异常 fail-open 不抛", async () => {
	const key = "heal-throw";
	resetPlanState(key);
	const harness = {
		lane: async () => {
			throw new Error("boom");
		},
	} as unknown as AgentHarness<LnkpiToolContext>;
	await assert.doesNotReject(healToolsetOnResume(harness, BACKGROUND_CONTEXT, key, BASE, []));
	resetPlanState(key);
});
