/**
 * 回合连续性 —— `SessionManager.recordTurnState` 集成测试（2026-10-21）。
 *
 * 验证三件事：
 * 1. `create()` 时**真的**把 `entryProjectors` 注册给上游 harness（接线没漏）；
 * 2. `recordTurnState()` 走上游 `lane.appendCustomEntry` 落盘（不是自造管道）；
 * 3. 落盘失败 / 会话不存在时**fail-soft**（不抛错、不阻断对话）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toSessionKey } from "./session-manager.js";
import { TURN_STATE_CUSTOM_TYPE, type TurnState } from "./turn-state.js";
import type { RuntimeConfig } from "./runtime-config.js";

function testConfig(): RuntimeConfig {
	return {
		dataRoot: "/tmp/turn-continuity-test",
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	} as RuntimeConfig;
}

interface Captured {
	cfg?: Record<string, unknown>;
	appendCalls: Array<{ customType: string; data: unknown }>;
	appendThrows?: boolean;
}

/** 造一个能记录 `appendCustomEntry` 调用的 fake harness。 */
function makeHarnessFactory(captured: Captured) {
	return async (cfg: unknown) => {
		captured.cfg = cfg as Record<string, unknown>;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({
					prompt: async () => ({ ok: true }),
					appendCustomEntry: async (customType: string, data: unknown) => {
						if (captured.appendThrows) throw new Error("disk full");
						captured.appendCalls.push({ customType, data });
						return "entry-1";
					},
					close: async () => {},
				}),
				close: async () => {},
			},
		} as never;
	};
}

const SAMPLE: TurnState = {
	userText: "让他们抱在一起",
	assistantPartial: "我先看一下画布",
	interruption: "history_diverged",
	completedSteps: ["get_canvas_summary"],
	pendingSteps: ["run_image_generation"],
	at: 1_700_000_000_000,
};

describe("SessionManager.recordTurnState（回合连续性落盘）", () => {
	it("⭐ create() 把 entryProjectors 注册给上游 harness", async () => {
		const captured: Captured = { appendCalls: [] };
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			makeHarnessFactory(captured),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });

		const projectors = captured.cfg?.entryProjectors as
			| Record<string, (entry: never) => unknown>
			| undefined;
		assert.ok(projectors, "entryProjectors 必须被注册");
		assert.ok(TURN_STATE_CUSTOM_TYPE in projectors, "必须注册 turn_state 的 projector");
	});

	it("⭐ projector 对真实 custom entry 投影出 user 消息", async () => {
		const captured: Captured = { appendCalls: [] };
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			makeHarnessFactory(captured),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });

		const projectors = captured.cfg?.entryProjectors as Record<
			string,
			(entry: never) => unknown
		>;
		const out = projectors[TURN_STATE_CUSTOM_TYPE]({
			type: "custom",
			customType: TURN_STATE_CUSTOM_TYPE,
			data: SAMPLE,
		} as never) as Array<{ role: string; content: string }> | undefined;

		assert.ok(out, "应投影出消息");
		assert.equal(out!.length, 1);
		assert.equal(out![0].role, "user");
		assert.ok(out![0].content.includes("让他们抱在一起"));
	});

	it("recordTurnState 走上游 appendCustomEntry 落盘", async () => {
		const captured: Captured = { appendCalls: [] };
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			makeHarnessFactory(captured),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });

		const result = await sm.recordTurnState("s1", SAMPLE);
		assert.equal(result.recorded, true);
		assert.equal(captured.appendCalls.length, 1);
		assert.equal(captured.appendCalls[0].customType, TURN_STATE_CUSTOM_TYPE);

		// 落盘载荷必须包含恢复所需的全部事实
		const data = captured.appendCalls[0].data as Record<string, unknown>;
		assert.equal(data.userText, "让他们抱在一起");
		assert.equal(data.assistantPartial, "我先看一下画布");
		assert.equal(data.interruption, "history_diverged");
		assert.deepEqual(data.completedSteps, ["get_canvas_summary"]);
		assert.deepEqual(data.pendingSteps, ["run_image_generation"]);
		assert.equal(data.at, 1_700_000_000_000);
	});

	it("⛔ 会话不存在 ⇒ recorded=false（不抛错）", async () => {
		const captured: Captured = { appendCalls: [] };
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			makeHarnessFactory(captured),
			undefined,
			undefined,
			testConfig(),
		);
		const result = await sm.recordTurnState("never-created", SAMPLE);
		assert.equal(result.recorded, false);
	});

	it("⛔ 落盘抛错 ⇒ recorded=false 且不抛出（fail-soft）", async () => {
		const captured: Captured = { appendCalls: [], appendThrows: true };
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			makeHarnessFactory(captured),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });

		const result = await sm.recordTurnState("s1", SAMPLE);
		assert.equal(result.recorded, false);
	});

	it("会话键归一（threadKey → toSessionKey）", async () => {
		const captured: Captured = { appendCalls: [] };
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			makeHarnessFactory(captured),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("canvas:thread", { userId: "u1", systemPrompt: "SYS" });
		const result = await sm.recordTurnState("canvas:thread", SAMPLE);
		assert.equal(result.recorded, true);
		// 归一后的键：非法字符（`:`）被替换 + 8 位哈希后缀
		const key = toSessionKey("canvas:thread");
		assert.ok(key.startsWith("canvas_thread"), key);
		assert.ok(/-\w{8}$/.test(key), key);
	});
});
