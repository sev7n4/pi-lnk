import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTrustBoundary, countTrustBoundaryActions, GOAL_RESTATEMENT_MAX_CHARS } from "./trust-boundary.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function user(content: string | Record<string, unknown>[], ts = 1): AgentMessage {
	return {
		role: "user",
		content,
		timestamp: ts,
	} as unknown as AgentMessage;
}

function toolResult(text: string, toolName = "read_document"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
		toolName,
		content: [{ type: "text", text }],
	} as unknown as AgentMessage;
}

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as unknown as AgentMessage;
}

function textOf(msg: AgentMessage): string {
	const raw = (msg as { content: unknown }).content;
	if (typeof raw === "string") return raw;
	const parts = raw as { type: string; text?: string }[];
	return parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

describe("applyTrustBoundary（审计 #8：信任边界 + 目标复述）", () => {
	it("空历史 → undefined（零开销直通）", () => {
		assert.equal(applyTrustBoundary([]), undefined);
	});

	it("无 user 消息 → undefined", () => {
		assert.equal(applyTrustBoundary([assistant("hi")]), undefined);
	});

	it("注入目标复述：插在最后一条 user 消息之前，role=user", () => {
		const input = [user("帮我画一张小狗"), assistant("好的"), user("改成小猫")];
		const out = applyTrustBoundary(input);
		assert.ok(Array.isArray(out));
		const idx = out!.findIndex((m) => (m as { role: string }).role === "user" && textOf(m).includes("目标复述"));
		const lastUserIdx = out!.reduce(
			(acc, m, i) => ((m as { role: string }).role === "user" && i > acc ? i : acc),
			-1,
		);
		assert.ok(idx > 0, "复述消息存在且不在首位");
		assert.ok(idx < lastUserIdx, "复述在最后一条 user 消息之前");
		assert.ok(textOf(out![idx]).includes("改成小猫"), "复述包含本轮用户指令原文");
		assert.ok(textOf(out![idx]).includes("非新指令"), "复述自带非指令声明");
	});

	it("user content 为数组形式时也能抽取文本", () => {
		const input = [user([{ type: "text", text: "数组形式目标" }])];
		const out = applyTrustBoundary(input);
		assert.ok(out);
		assert.ok(textOf(out![0]).includes("数组形式目标"));
	});

	it("只标注最后一条 user 之后的 toolResult，历史 toolResult 不动", () => {
		const input = [user("第一轮指令", 1), toolResult("旧工具输出"), user("第二轮指令", 2), toolResult("新工具输出")];
		const out = applyTrustBoundary(input)!;
		const annotated: string[] = [];
		for (const m of out) {
			if ((m as { role: string }).role === "toolResult" && textOf(m).includes("非用户指令")) {
				annotated.push(textOf(m));
			}
		}
		assert.equal(annotated.length, 1, "仅本轮 toolResult 被标注");
		assert.ok(annotated[0].includes("新工具输出"), "原文保留");
		// 旧 toolResult 原样
		const oldMsg = out.find((m) => (m as { role: string }).role === "toolResult" && textOf(m).includes("旧工具输出"));
		assert.ok(oldMsg);
		assert.equal(textOf(oldMsg!).includes("非用户指令"), false, "历史 toolResult 不标注");
	});

	it("toolResult 的 image content 保留、原文不被改写", () => {
		const withImage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "gen",
			content: [
				{ type: "image", data: "base64data", mimeType: "image/png" },
				{ type: "text", text: "生成结果" },
			],
		} as unknown as AgentMessage;
		const out = applyTrustBoundary([user("画图", 1), withImage])!;
		const tr = out.find((m) => (m as { role: string }).role === "toolResult") as {
			content: { type: string }[];
		};
		assert.equal(tr.content.filter((c) => c.type === "image").length, 1);
		assert.ok(tr.content[0].type === "text", "标注头在首位");
	});

	it("目标超长 → 截断到上限", () => {
		const long = "长".repeat(GOAL_RESTATEMENT_MAX_CHARS + 100);
		const out = applyTrustBoundary([user(long)])!;
		const rest = out.find((m) => textOf(m).includes("目标复述"))!;
		const t = textOf(rest);
		const goalPart = t.slice(t.indexOf("：", t.indexOf("目标复述")) + 1);
		assert.ok(goalPart.trim().length <= GOAL_RESTATEMENT_MAX_CHARS, `实际 ${goalPart.trim().length}`);
	});

	it("最新 user 是 steer 插话（多段 user）也按最后一条复述", () => {
		const input = [user("做 A", 1), assistant("ok"), user("先做 B", 2)];
		const out = applyTrustBoundary(input)!;
		const rest = out.find((m) => textOf(m).includes("目标复述"))!;
		assert.ok(textOf(rest).includes("先做 B"));
		assert.equal(textOf(rest).includes("做 A"), false);
	});

	it("纯函数：不修改输入数组", () => {
		const input = [user("画图", 1), toolResult("输出")];
		const snapshot = JSON.stringify(input);
		applyTrustBoundary(input);
		assert.equal(JSON.stringify(input), snapshot);
	});

	it("user 文本为空（纯图片附件）→ 不注入复述但 toolResult 仍标注", () => {
		const input = [user([{ type: "image", data: "x", mimeType: "image/png" }], 1), toolResult("输出")];
		const out = applyTrustBoundary(input)!;
		assert.equal(out.some((m) => textOf(m).includes("目标复述")), false);
		assert.equal(out.filter((m) => textOf(m).includes("非用户指令")).length, 1);
	});

	it("countTrustBoundaryActions 与实际注入行为一致", () => {
		const mixed = [user("第一轮", 1), toolResult("旧"), user("第二轮指令", 2), toolResult("新1"), toolResult("新2")];
		const stats = countTrustBoundaryActions(mixed);
		assert.deepEqual(stats, { goalReinjected: true, annotatedToolResults: 2 });
		const out = applyTrustBoundary(mixed)!;
		assert.equal(out.filter((m) => textOf(m).includes("非用户指令")).length, stats.annotatedToolResults);
		assert.equal(out.some((m) => textOf(m).includes("目标复述")), stats.goalReinjected);
		// 无 user 历史
		assert.deepEqual(countTrustBoundaryActions([assistant("hi")]), {
			goalReinjected: false,
			annotatedToolResults: 0,
		});
	});
});
