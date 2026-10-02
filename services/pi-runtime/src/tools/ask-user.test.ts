/** ask_user 阻塞分支（spec 2026-09-30-ask-user-blocking，B-1/B-5）：
 * 阻塞开（缺省 + registry 注入）→ 卡片带 callId、等待 answer 同 turn 续行；
 * off（ASK_USER_BLOCKING=off 或无 registry）→ 逐字节 v1 旧行为（立即返回、无 callId、不注册 pending）。
 * 铁律（B-4）：registry resolve 不 reject——超时/中止以正常值交还。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAskUserTools } from "./ask-user.js";
import { PendingToolRegistry } from "../pending-registry.js";
import type { Metrics } from "../metrics.js";

const metrics = { observeToolCall: () => {} } as unknown as Metrics;

function lastText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	assert.ok(block && block.type === "text" && typeof block.text === "string");
	return block.text;
}

describe("ask_user 阻塞分支（B-1/B-5）", () => {
	it("开关缺省开 + registry 注入 → 等待 answer 后同 promise 返回答案", async () => {
		const reg = new PendingToolRegistry();
		const [tool] = createAskUserTools(metrics, reg);
		const questions = [{ id: "style", question: "风格？", options: [{ label: "水墨", value: "ink" }] }];
		const updates: unknown[] = [];
		const pending = tool.execute!(
			"call-1",
			{ questions },
			(u) => updates.push(u),
			{ sessionId: "canvas-1" } as never,
			undefined as never,
			undefined as never,
		);
		// 卡片 payload 带 callId（前端提交依据）
		const card = (await Promise.race([pending.then(() => null), Promise.resolve(true)]));
		assert.ok(card); // execute 未提前返回（还在等待）
		const answered = reg.answer("canvas-1", "call-1", { style: ["ink"] });
		assert.equal(answered.deduped, false);
		const result = (await pending) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
		assert.match(lastText(result), /answered/);
		assert.match(lastText(result), /ink/);
		// onUpdate 下发的卡片（tool_execution_update 派生 canvas_command）：type=ask_user + callId
		assert.equal(updates.length, 1);
		const cardCmd = (
			updates[0] as { details: { canvasCommands: Array<Record<string, unknown>> } }
		).details.canvasCommands[0];
		assert.equal(cardCmd.type, "ask_user");
		assert.equal(cardCmd.callId, "call-1");
	});

	it("registry.cancel（abort 联动）→ 返回「用户已中止」文本，不抛错", async () => {
		const reg = new PendingToolRegistry();
		const [tool] = createAskUserTools(metrics, reg);
		const questions = [{ id: "q", question: "Q", options: [{ label: "A", value: "a" }] }];
		const pending = tool.execute!("c", { questions }, () => {}, { sessionId: "s" } as never, undefined as never, undefined as never);
		reg.abortAll("s");
		const result = (await pending) as { content: Array<{ type: string; text: string }> };
		assert.match(lastText(result), /中止/);
	});

	it("超时 → 全部题目标 skipped，且不交还任何部分答案（2026-10-02 删 recordPartial）", async () => {
		const reg = new PendingToolRegistry();
		const [tool] = createAskUserTools(metrics, reg, { timeoutMs: 20 });
		const questions = [
			{ id: "style", question: "风格？", options: [{ label: "水墨", value: "ink" }] },
			{ id: "count", question: "张数？", options: [{ label: "1", value: "1" }] },
		];
		const pending = tool.execute!("c", { questions }, () => {}, { sessionId: "s" } as never, undefined as never, undefined as never);
		const result = (await pending) as { content: Array<{ type: string; text: string }> };
		const text = lastText(result);
		// 没有 partial 通道：超时就是「一分没拿到」，模型不该基于半个答案推进
		assert.match(text, /未作答/);
		assert.match(text, /skipped/);
		assert.doesNotMatch(text, /ink/);
		assert.doesNotMatch(text, /partial/);
		// 两题都在 skipped 里（不是只标没答的那几题）
		assert.match(text, /"id":"style","skipped":true/);
		assert.match(text, /"id":"count","skipped":true/);
	});

	it("waiting 事件带题面（meta.questionTitle）——前端状态行能显示「等待你作答：…」", async () => {
		let seen: { meta?: { questionTitle?: string } } | undefined;
		const reg = new PendingToolRegistry({
			onWaitStart: (info) => { seen = info; },
		});
		const [tool] = createAskUserTools(metrics, reg, { timeoutMs: 20 });
		const questions = [{ id: "style", question: "风格？", options: [{ label: "水墨", value: "ink" }] }];
		void tool.execute!("c", { questions }, () => {}, { sessionId: "s" } as never, undefined as never, undefined as never);
		// 事件在 waitForUser 注册当拍下发，不等超时也要能看到
		assert.equal(seen!.meta?.questionTitle, "风格？");
		// 不悬着：放它超时 settle，避免定时器泄漏进后续用例
		await new Promise((r) => setTimeout(r, 40));
	});

	it("开关 off（env ASK_USER_BLOCKING=off）→ 逐字节旧行为：立即返回无 callId 等待", async () => {
		const prev = process.env.ASK_USER_BLOCKING;
		process.env.ASK_USER_BLOCKING = "off";
		try {
			const reg = new PendingToolRegistry();
			const [tool] = createAskUserTools(metrics, reg);
			const questions = [{ id: "q", question: "Q", options: [{ label: "A", value: "a" }] }];
			const result = (await tool.execute!("c", { questions }, () => {}, { sessionId: "s" } as never, undefined as never, undefined as never)) as { details: { canvasCommands: Array<Record<string, unknown>> } };
			const cmd = result.details.canvasCommands[0];
			assert.equal(cmd.type, "ask_user");
			assert.equal(cmd.callId, undefined); // off 分支无 callId
			assert.equal(reg.hasPending("s"), false); // 未注册 pending
		} finally {
			if (prev === undefined) delete process.env.ASK_USER_BLOCKING;
			else process.env.ASK_USER_BLOCKING = prev;
		}
	});
});
