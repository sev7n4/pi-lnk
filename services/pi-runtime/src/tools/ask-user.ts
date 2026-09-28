/**
 * ask_user 工具（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md）：
 * 向用户提问/选项卡。tier=ui_command 非阻塞——execute 立即返回，不等用户；
 * 用户点选回填为下一轮 user message（复用前端 sendMessage，零新建回流）。
 * D1-D5 已拍板按推荐（单次问全 / 空格分隔 / allowOther 默认 true / 带取消 / 不限触发）。
 */
import { Type } from "typebox";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";

export interface AskUserQuestion {
	id: string;
	question: string;
	options: { label: string; value: string }[];
	multiSelect?: boolean;
	allowOther?: boolean;
}

function uiResult(commands: unknown[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: unknown[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, canvasCommands: commands }) }],
		details: { ok: true, canvasCommands: commands },
	};
}

export function createAskUserTools(metrics: Metrics): LnkpiTool[] {
	return [{
		tier: "ui_command" as const,
		name: "ask_user",
		label: "向用户提问",
		description: "Present clickable option chips plus free-text other to the user; the user's choice is sent back as the next user message. Non-blocking: returns immediately after emitting the card; agent should end its turn after calling.",
		parameters: Type.Object({
			questions: Type.Array(Type.Object({
				id: Type.String({ description: "stable question id, e.g. scene" }),
				question: Type.String({ description: "question text shown to user" }),
				options: Type.Array(Type.Object({
					label: Type.String(),
					value: Type.String({ description: "text sent back as user message when chip clicked" }),
				}), { min: 1 }),
				multiSelect: Type.Optional(Type.Boolean()),
				allowOther: Type.Optional(Type.Boolean({ description: "show free-text other input, default true" })),
			}), { min: 1, max: 4 }),
		}),
		execute: async (_id, p: { questions: AskUserQuestion[] }) => {
			metrics.observeToolCall("ask_user", "ok");
			return uiResult([{ type: "ask_user", questions: p.questions }]);
		},
	}];
}
