import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldRuntimeEvents, type RuntimeEvent } from "./transcript.js";

/**
 * 流式事件 → 归一化 transcript 的折叠测试。
 *
 * ⭐ 本模块最容易出的错是**重复文本**（把全量重发当增量 append），
 * 那会让基于文本的断言永远失败 —— 一个「看起来在跑、实际判据全错」的评测基线，
 * 比没有 eval 更危险（它会让人根据错误的基线改提示词）。
 */
describe("foldRuntimeEvents（流式事件折叠）", () => {
	it("空事件流 → 空 transcript 且未完成", () => {
		const t = foldRuntimeEvents([]);
		assert.equal(t.assistantText, "");
		assert.deepEqual(t.toolNames, []);
		assert.equal(t.completed, false);
	});

	it("message_update 增量拼接", () => {
		const t = foldRuntimeEvents([
			{ type: "message_update", data: { text: "画一张" } },
			{ type: "message_update", data: { text: "夜景" } },
		]);
		assert.equal(t.assistantText, "画一张夜景");
	});

	it("⭐ message_end 全量重发 ⇒ 替换而非追加（否则同一段话出现两遍）", () => {
		const t = foldRuntimeEvents([
			{ type: "message_update", data: { text: "画一张夜景" } },
			// vendor 的 message_end 常带全量文本
			{ type: "message_end", data: { text: "画一张夜景" } },
		]);
		assert.equal(t.assistantText, "画一张夜景");
		assert.equal(
			t.assistantText.split("画一张夜景").length - 1,
			1,
			"「画一张夜景」必须只出现一次",
		);
	});

	it("全量重发且内容增长（旧文本是新文本前缀）⇒ 替换", () => {
		const t = foldRuntimeEvents([
			{ type: "message_end", data: { text: "画一张" } },
			{ type: "message_end", data: { text: "画一张夜景，已建好节点。" } },
		]);
		assert.equal(t.assistantText, "画一张夜景，已建好节点。");
	});

	it("block 数组形态的 content 也被抽出", () => {
		const t = foldRuntimeEvents([
			{
				type: "message_end",
				data: { content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }] },
			},
		]);
		assert.equal(t.assistantText, "你好世界");
	});

	it("tool_execution_start 按顺序记工具名", () => {
		const t = foldRuntimeEvents([
			{ type: "tool_execution_start", data: { toolName: "upsert_media_node" } },
			{ type: "tool_execution_start", data: { toolName: "propose_generation" } },
		]);
		assert.deepEqual(t.toolNames, ["upsert_media_node", "propose_generation"]);
	});

	it("⭐ 同一 callId 重放 ⇒ 去重（断线重连会重发）", () => {
		const t = foldRuntimeEvents([
			{ type: "tool_execution_start", data: { toolName: "upsert_media_node", toolCallId: "c1" } },
			// 重连重放：同 callId
			{ type: "tool_execution_start", data: { toolName: "upsert_media_node", toolCallId: "c1" } },
		]);
		assert.deepEqual(t.toolNames, ["upsert_media_node"], "同 callId 应去重为一次");
	});

	it("⭐ 同名不同 callId ⇒ 保留两次（真实的一轮里可以调多次）", () => {
		const t = foldRuntimeEvents([
			{ type: "tool_execution_start", data: { toolName: "set_node_text", toolCallId: "c1" } },
			{ type: "tool_execution_start", data: { toolName: "set_node_text", toolCallId: "c2" } },
		]);
		assert.deepEqual(t.toolNames, ["set_node_text", "set_node_text"]);
	});

	it("记录工具入参（供断言「调了但参数对不对」）", () => {
		const t = foldRuntimeEvents([
			{
				type: "tool_execution_start",
				data: { toolName: "propose_generation", toolCallId: "c1", input: { nodeId: "n1" } },
			},
		]);
		assert.equal(t.toolCalls[0]?.name, "propose_generation");
		assert.deepEqual(t.toolCalls[0]?.input, { nodeId: "n1" });
	});

	it("agent_end(completed) + 无 error ⇒ completed", () => {
		const t = foldRuntimeEvents([
			{ type: "message_end", data: { text: "好了" } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.equal(t.completed, true);
	});

	it("⭐ 有 error 事件 ⇒ completed=false（哪怕 agent_end 说 completed）", () => {
		const t = foldRuntimeEvents([
			{ type: "error", data: { message: "upstream 503" } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.equal(t.completed, false);
		assert.deepEqual(t.errors, ["upstream 503"]);
	});

	it("agent_end 非 completed（aborted/deferred）⇒ completed=false", () => {
		for (const status of ["aborted", "deferred", "failed"]) {
			const t = foldRuntimeEvents([{ type: "agent_end", data: { status } }]);
			assert.equal(t.completed, false, `${status} 不应算完成`);
		}
	});

	it("usage 事件被采集（供 token 成本对比）", () => {
		const t = foldRuntimeEvents([
			{ type: "usage", data: { usage: { input: 100, output: 50, total: 150 } } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.deepEqual(t.usage, { input: 100, output: 50, total: 150 });
	});

	it("未知事件类型被忽略（向前兼容，不因新事件崩掉）", () => {
		const t = foldRuntimeEvents([
			{ type: "brand_new_event_from_vendor", data: { whatever: true } },
			{ type: "message_end", data: { text: "ok" } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.equal(t.assistantText, "ok");
		assert.equal(t.completed, true);
	});
});
