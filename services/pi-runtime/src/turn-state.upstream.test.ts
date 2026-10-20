/**
 * 回合连续性 —— 上游 `entryProjectors` 接入的**集成验证**（2026-10-21）。
 *
 * ## 这个测试要证明什么
 *
 * 方案的核心假设是「上游 pi 的自定义条目机制能承载跨故障的任务状态」：
 * 1. `lane.appendCustomEntry(customType, data)` ⇒ 落盘为 `CustomEntry{type:"custom",customType,data}`；
 * 2. `AgentHarness.create({ entryProjectors })` ⇒ 该条目在**后续每一轮**被投影进模型上下文；
 * 3. 投影出的消息是 **user 角色且无 stopReason** ⇒ **不会**被上游
 *    `isContextMessage()` 过滤掉（那正是中断轮失忆的直接机制）。
 *
 * 纯函数测试（`turn-state.test.ts`）只能证明第 3 步的**形状**对；
 * 本测试用**真实 vendor 实现**（`buildSessionContext`）证明第 1、2 步的链路真的通。
 *
 * ⭐ 为什么必须用 vendor 真码而不是 mock：`isContextMessage` 是上游**内部**函数
 * （未导出），mock 掉它等于把要验证的判据换成了自己写的版本 ⇒ 假绿。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
	buildTurnState,
	renderTurnStateBlock,
	turnStateProjector,
	TURN_STATE_CUSTOM_TYPE,
} from "./turn-state.js";

/**
 * 载入上游**真实**的 `buildSessionContext`。
 *
 * ⚠️ 为什么走 dist 深路径而不是 package exports：
 * - 上游 `package.json` 的 `exports` 白名单**不含** `./harness/session/context`
 *   （只有 `.` / `./node` / `./harness/context` / `./harness/env/nodejs`
 *   / `./harness/runtime/reducer` / `./harness/session` / `./harness/session/testing`）；
 * - 而 `buildSessionContext` 只从 `harness/session/context.ts` 导出，
 *   `harness/session/index.ts` **不 re-export** 它
 *   （vendor/…/packages/agent/src/harness/session/index.ts:1-10）；
 * - ⇒ 只能从 dist 深路径 import。
 *
 * ⛔ 用 `createRequire` 解析包根再拼路径，**不硬编码 pnpm 虚拟store 路径**
 * （`node_modules/.pnpm/…` 会随 lockfile 变，写死必脆）。
 */
async function loadBuildSessionContext(): Promise<
	(
		pathEntries: readonly unknown[],
		options: { entryProjectors: Record<string, (entry: never) => unknown> } | undefined,
		context: unknown,
	) => Promise<Array<{ role: string; content: string; stopReason?: string }>>
> {
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

/** projector 装配（与生产 `session-manager.ts` 的注册完全同形）。 */
const projectors = {
	[TURN_STATE_CUSTOM_TYPE]: (entry: { customType: string; data?: unknown }) =>
		turnStateProjector({
			type: "custom",
			customType: entry.customType,
			data: entry.data,
		}) as never,
};

/** vendor 的 Entry 形状（只取本测试用得到的字段）。 */
interface TestEntry {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; stopReason?: string; content: string };
}

/** 构造一条 custom entry（形状对齐 vendor `CustomEntry`）。 */
function customEntry(seq: number, customType: string, data: unknown): TestEntry {
	return {
		id: `e${seq}`,
		parentId: seq === 1 ? null : `e${seq - 1}`,
		seq,
		timestamp: 1_700_000_000_000 + seq,
		type: "custom",
		customType,
		data,
	};
}

/** 构造一条 message entry。 */
function messageEntry(seq: number, role: string, content: string, stopReason?: string): TestEntry {
	return {
		id: `e${seq}`,
		parentId: seq === 1 ? null : `e${seq - 1}`,
		seq,
		timestamp: 1_700_000_000_000 + seq,
		type: "message",
		message: { role, content, ...(stopReason ? { stopReason } : {}) },
	};
}

describe("上游 entryProjectors 链路（真实 vendor 实现）", () => {
	it("⭐ 自定义条目被投影进模型上下文", async () => {
		const state = buildTurnState({
			userText: "让他们抱在一起",
			interruption: "history_diverged",
			completedSteps: ["get_canvas_summary"],
			pendingSteps: ["run_image_generation"],
			at: 1_700_000_000_000,
		});
		const entries = [customEntry(1, TURN_STATE_CUSTOM_TYPE, state)] as never[];

		const buildSessionContext = await loadBuildSessionContext();
		const messages = await buildSessionContext(entries, { entryProjectors: projectors }, {});

		assert.equal(messages.length, 1, "应投影出 1 条消息");
		const msg = messages[0] as { role: string; content: string; stopReason?: string };
		assert.equal(msg.role, "user");
		assert.ok(msg.content.includes("让他们抱在一起"), msg.content);
		assert.ok(msg.content.includes("run_image_generation"), msg.content);
	});

	it("⭐⭐ 投影出的消息不会被上游 isContextMessage 过滤（关键不变式）", async () => {
		// 上游 isContextMessage 只过滤 **assistant** 且 stopReason ∈ {error,aborted,deferred}。
		// 本测试用**真实** buildSessionContext 验证：中断轮之后，
		// 我们的状态消息仍在上下文里。
		const state = buildTurnState({
			userText: "让他们抱在一起",
			interruption: "upstream_error",
			pendingSteps: ["run_image_generation"],
			at: 1_700_000_000_000,
		});
		const entries = [
			messageEntry(1, "user", "让他们抱在一起"),
			// 中断轮：上游会以 stopReason="error" 收尾 ⇒ 会被 isContextMessage 过滤
			messageEntry(2, "assistant", "我先看一下画布", "error"),
			customEntry(3, TURN_STATE_CUSTOM_TYPE, state),
		] as never[];

		const buildSessionContext = await loadBuildSessionContext();
		const messages = await buildSessionContext(entries, { entryProjectors: projectors }, {});

		// 中断轮的 assistant 消息**被过滤**（这正是失忆机制）
		const roles = messages.map((m) => (m as { role: string }).role);
		assert.equal(roles.filter((r) => r === "assistant").length, 0, "中断轮的 assistant 应被上游过滤");

		// 但我们的状态消息**在**上下文里
		const stateMsg = messages.find((m) =>
			(m as { content: string }).content.includes("上一轮被中断"),
		) as { role: string; content: string; stopReason?: string } | undefined;
		assert.ok(stateMsg, "状态消息必须在上下文里");
		assert.equal(stateMsg!.role, "user");
		assert.equal(stateMsg!.stopReason, undefined, "无 stopReason ⇒ 恒不被过滤");
		assert.ok(stateMsg!.content.includes("让他们抱在一起"), stateMsg!.content);
	});

	it("非本类型条目不投影（不污染上下文）", async () => {
		const entries = [customEntry(1, "someone.else", { foo: 1 })] as never[];
		const buildSessionContext = await loadBuildSessionContext();
		const messages = await buildSessionContext(entries, { entryProjectors: projectors }, {});
		assert.equal(messages.length, 0);
	});

	it("坏数据不投影（宁可没有，不要编造）", async () => {
		const entries = [customEntry(1, TURN_STATE_CUSTOM_TYPE, { garbage: true })] as never[];
		const buildSessionContext = await loadBuildSessionContext();
		const messages = await buildSessionContext(entries, { entryProjectors: projectors }, {});
		assert.equal(messages.length, 0);
	});

	it("状态消息内容与 renderTurnStateBlock 一致（单一渲染实现）", async () => {
		const state = buildTurnState({
			userText: "继续做那个绘本",
			interruption: "tool_interrupted",
			completedSteps: ["propose_generation"],
			pendingSteps: ["run_image_generation"],
			at: 1_700_000_000_000,
		});
		const entries = [customEntry(1, TURN_STATE_CUSTOM_TYPE, state)] as never[];
		const buildSessionContext = await loadBuildSessionContext();
		const messages = await buildSessionContext(entries, { entryProjectors: projectors }, {});
		assert.equal((messages[0] as { content: string }).content, renderTurnStateBlock(state));
	});
});
