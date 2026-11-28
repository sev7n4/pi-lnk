import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sanitizeMalformedToolCalls } from "./tool-call-sanitizer.js";

function assistant(content: unknown[]): AgentMessage {
	return { role: "assistant", content, timestamp: 1 } as unknown as AgentMessage;
}

function toolCall(id: string, name: string, args: unknown = {}): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: args };
}

function toolResult(toolCallId: string, toolName = "read_document"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
	} as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function contentOf(msg: AgentMessage): unknown[] {
	return (msg as unknown as { content: unknown[] }).content;
}

function idsOf(msg: AgentMessage): string[] {
	return contentOf(msg)
		.filter((b) => (b as { type?: string }).type === "toolCall")
		.map((b) => String((b as { id?: unknown }).id));
}

describe("sanitizeMalformedToolCalls（畸形 toolCall 进 LLM 前清洗）", () => {
	it("空 id 的 toolCall 被剔除，整条仅有该调用的 assistant 消息随之移除", () => {
		const bad = assistant([toolCall("", "", {})]);
		const out = sanitizeMalformedToolCalls([user("继续"), bad]);
		assert.ok(out);
		assert.equal(out.messages.length, 1);
		assert.equal((out.messages[0] as { role: string }).role, "user");
		assert.equal(out.removedCalls, 1);
		assert.equal(out.removedResults, 0);
	});

	it("空 name 的 toolCall 被剔除，但同条消息里的 text 块保留", () => {
		const bad = assistant([{ type: "text", text: "我在画" }, toolCall("c1", "")]);
		const out = sanitizeMalformedToolCalls([bad])!;
		assert.equal(out.messages.length, 1);
		assert.deepEqual(idsOf(out.messages[0]), []);
		assert.deepEqual(contentOf(out.messages[0]), [{ type: "text", text: "我在画" }]);
		assert.equal(out.removedCalls, 1);
	});

	it("全空白 id / name 同样被剔除", () => {
		const bad = assistant([toolCall("   ", "  "), { type: "text", text: "x" }]);
		const out = sanitizeMalformedToolCalls([bad])!;
		assert.deepEqual(idsOf(out.messages[0]), []);
		assert.equal(out.removedCalls, 1);
	});

	it("toolResult 的 toolCallId 为空 → 整条剔除", () => {
		const out = sanitizeMalformedToolCalls([user("x"), toolResult("")])!;
		assert.equal(out.messages.length, 1);
		assert.equal(out.removedResults, 1);
	});

	it("被剔除调用的同 id toolResult 一并剔除（空 name + 合法 id）", () => {
		const out = sanitizeMalformedToolCalls([
			user("x"),
			assistant([toolCall("c2", "")]),
			toolResult("c2", ""),
		])!;
		assert.equal(out.messages.length, 1);
		assert.equal(out.removedCalls, 1);
		assert.equal(out.removedResults, 1);
	});

	it("零命中返回 undefined：正常工具调用的引用逐字节不变", () => {
		const a = assistant([toolCall("c3", "read_document")]);
		const r = toolResult("c3");
		const input = [user("x"), a, r];
		assert.equal(sanitizeMalformedToolCalls(input), undefined);
		assert.equal(sanitizeMalformedToolCalls([]), undefined);
	});

	it("不修改输入对象或数组（历史 transcript 保持完整可审计）", () => {
		const bad = assistant([{ type: "text", text: "t" }, toolCall("", "")]);
		const r = toolResult("");
		const good = assistant([toolCall("ok", "read_document")]);
		const input = [bad, r, good];
		const snapshot = JSON.stringify(input);
		const out = sanitizeMalformedToolCalls(input)!;
		assert.equal(JSON.stringify(input), snapshot);
		assert.notEqual(out.messages, input);
		assert.notEqual(out.messages[0], bad); // 有变更的消息产出新对象
		assert.equal(out.messages[1], good); // 无变更的消息复用原对象
		assert.equal(out.messages.length, 2);
	});

	it("compaction 后同一份畸形历史再次请求仍可被清洗（纯函数幂等）", () => {
		const input = [user("x"), assistant([toolCall("c4", "")]), toolResult("c4", "")];
		const first = sanitizeMalformedToolCalls(input)!;
		const second = sanitizeMalformedToolCalls(first.messages);
		assert.equal(second, undefined);
		assert.deepEqual(first.messages, [user("x")]);
	});

	it("非字符串 id/name/null content 不抛错，按畸形处理", () => {
		const bad = assistant([{ type: "toolCall", id: 42, name: null }] as unknown[]);
		const out = sanitizeMalformedToolCalls([bad, toolResult(undefined as unknown as string)])!;
		assert.equal(out.messages.length, 0);
		assert.equal(out.removedCalls, 1);
		assert.equal(out.removedResults, 1);
	});
});

describe("上游 transformMessages 边界验收（cmx05m9d2 畸形 transcript 形态）", () => {
	it("清洗后上游转换结果不再含空 tool_call_id；未清洗时会漏出", async () => {
		const { transformMessages } = await import("@earendil-works/pi-ai/api/transform-messages");
		const model = { provider: "agnes", api: "openai-completions", id: "agnes-2.5-flash", input: ["text"] } as never;
		// 复刻生产事件账本形态：assistant 仅有一条空 id/name 调用 + 对应空 id toolResult。
		const badHistory = [
			{ role: "user", content: "继续推进", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "", name: "", arguments: {} }],
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: 'Tool "" is unavailable' }] },
		] as unknown as AgentMessage[];

		const withoutFix = transformMessages(badHistory as never, model, undefined as never) as unknown as Array<{
			role: string;
			toolCallId?: string;
		}>;
		assert.ok(
			withoutFix.some((m) => m.role === "toolResult" && m.toolCallId === ""),
			"上游自身不校验空 id：未清洗时必须复现漏出",
		);

		const cleaned = sanitizeMalformedToolCalls(badHistory)!.messages;
		const withFix = transformMessages(cleaned as never, model, undefined as never) as unknown as Array<{
			role: string;
			toolCallId?: string;
		}>;
		assert.equal(withFix.some((m) => m.role === "toolResult" && !m.toolCallId), false);
		assert.deepEqual(withFix.map((m) => m.role), ["user"]);
	});
});
