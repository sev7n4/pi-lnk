/**
 * 回合连续性 —— **端到端**验证（2026-10-21）。
 *
 * ## 这个测试证明什么
 *
 * 完整链路：
 * ```
 * Nest 检测到中断
 *   → POST /sessions/:id/turn-state
 *   → pi-runtime: lane.appendCustomEntry("lnkpi.turn_state", state)
 *   → transcript 里出现 CustomEntry
 *   → 下一轮 buildSessionContext → entryProjectors 投影
 *   → 模型上下文里出现「上一轮被中断…」说明
 * ```
 *
 * 这是**唯一**能证明「用户说『继续』时 agent 能接上」的测试形态：
 * 前面的测试分别锁住各段，这里锁住**接缝**。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
	buildTurnState,
	turnStateProjector,
	TURN_STATE_CUSTOM_TYPE,
} from "./turn-state.js";

/** 载入上游真实 `buildSessionContext`（理由见 turn-state.upstream.test.ts）。 */
async function loadBuildSessionContext() {
	const require = createRequire(import.meta.url);
	const pkgJsonPath = require.resolve("@earendil-works/pi-agent-core/package.json");
	const distPath = join(dirname(pkgJsonPath), "dist", "harness", "session", "context.js");
	const mod = (await import(pathToFileURL(distPath).href)) as {
		buildSessionContext: (
			pathEntries: readonly unknown[],
			options: unknown,
			context: unknown,
		) => Promise<Array<{ role: string; content: string; stopReason?: string }>>;
	};
	return mod.buildSessionContext;
}

/**
 * 模拟上游 transcript 的 entry 链（形状对齐 vendor `Entry`）。
 * ⭐ custom 条目的 `parentId` 指向上一条 ⇒ 它在**分支路径上** ⇒ 会被扫描到。
 */
function makeEntry(
	seq: number,
	extra: { type: "message"; message: { role: string; content: string; stopReason?: string } } | {
		type: "custom";
		customType: string;
		data: unknown;
	},
): Record<string, unknown> {
	return {
		id: `e${seq}`,
		parentId: seq === 1 ? null : `e${seq - 1}`,
		seq,
		timestamp: 1_700_000_000_000 + seq,
		...extra,
	};
}

describe("端到端：中断 → 记录 → 下一轮模型能看到（2026-10-21 生产事故形态复现）", () => {
	it("⭐⭐ 中断轮的 user 消息在 pi 侧缺失时，状态条目仍让模型接上", async () => {
		const buildSessionContext = await loadBuildSessionContext();

		// ── 事故形态的 transcript ──
		// 1) 用户说「让他们抱在一起」→ 这轮在 pi 侧**整轮不存在**（双写分叉）
		// 2) 上游以 error 收尾的 assistant 消息（会被 isContextMessage 过滤）
		// 3) 我们的 turn_state 自定义条目（Nest 在中断当下写入）
		// 4) 用户说「继续」
		const state = buildTurnState({
			userText: "让他们抱在一起",
			assistantPartial: "我先看一下画布，确认两个角色的节点",
			interruption: "history_diverged",
			completedSteps: ["get_canvas_summary"],
			pendingSteps: ["run_image_generation"],
			at: 1_700_000_000_000,
		});

		const entries = [
			makeEntry(1, { type: "message", message: { role: "user", content: "给他们生成一个小男孩" } }),
			makeEntry(2, {
				type: "message",
				message: { role: "assistant", content: "小男孩已生成完成！", stopReason: "stop" },
			}),
			// 中断轮：assistant 以 error 收尾 ⇒ 上游会把它排除出上下文
			makeEntry(3, {
				type: "message",
				message: { role: "assistant", content: "我先看一下画布", stopReason: "error" },
			}),
			// ⭐ 我们的状态条目
			makeEntry(4, { type: "custom", customType: TURN_STATE_CUSTOM_TYPE, data: state }),
			makeEntry(5, { type: "message", message: { role: "user", content: "继续" } }),
		];

		const messages = await buildSessionContext(
			entries,
			{
				entryProjectors: {
					[TURN_STATE_CUSTOM_TYPE]: (entry) =>
						turnStateProjector({
							type: "custom",
							customType: entry.customType,
							data: entry.data,
						}) as never,
				},
			},
			{} as never,
		);

		// ── 断言 1：状态说明在上下文里，且在「继续」之前 ──
		const stateIdx = messages.findIndex((m) => m.content.includes("上一轮被中断"));
		const continueIdx = messages.findIndex((m) => m.content === "继续");
		assert.ok(stateIdx >= 0, "状态说明必须在模型上下文里");
		assert.ok(continueIdx >= 0, "「继续」必须在上下文里");
		assert.ok(stateIdx < continueIdx, "状态说明必须在「继续」之前（模型先看到它再看到指令）");

		// ── 断言 2：模型能读到「用户当时要什么」——这正是事故中丢掉的东西 ──
		const stateMsg = messages[stateIdx];
		assert.ok(stateMsg.content.includes("让他们抱在一起"), stateMsg.content);
		assert.ok(stateMsg.content.includes("run_image_generation"), stateMsg.content);
		assert.ok(stateMsg.content.includes("get_canvas_summary"), stateMsg.content);

		// ── 断言 3：状态说明不会被上游过滤（user 角色 + 无 stopReason）──
		assert.equal(stateMsg.role, "user");
		assert.equal(stateMsg.stopReason, undefined);

		// ── 断言 4：中断轮的 assistant 消息确实被过滤（证明我们的机制是必要的）──
		const filtered = messages.filter((m) => m.content === "我先看一下画布");
		assert.equal(filtered.length, 0, "中断轮的 assistant 消息应被上游过滤（若无过滤则本机制不必要）");
	});

	it("⭐ 状态说明明确禁止「靠读画布反推意图」（事故形态的正面防线）", async () => {
		const buildSessionContext = await loadBuildSessionContext();
		const state = buildTurnState({
			userText: "让他们抱在一起",
			interruption: "upstream_error",
			pendingSteps: ["run_image_generation"],
			at: 1_700_000_000_000,
		});
		const entries = [
			makeEntry(1, { type: "custom", customType: TURN_STATE_CUSTOM_TYPE, data: state }),
			makeEntry(2, { type: "message", message: { role: "user", content: "继续" } }),
		];
		const messages = await buildSessionContext(
			entries,
			{
				entryProjectors: {
					[TURN_STATE_CUSTOM_TYPE]: (entry) =>
						turnStateProjector({
							type: "custom",
							customType: entry.customType,
							data: entry.data,
						}) as never,
				},
			},
			{} as never,
		);
		const guidance = messages[0].content;
		assert.ok(guidance.includes("不要重新推断"), guidance);
		assert.ok(!guidance.includes("感知画布"), guidance);
	});
});
