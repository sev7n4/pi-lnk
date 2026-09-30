/**
 * ask_user 工具（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md；
 * 阻塞分支 2026-09-30-ask-user-blocking，B-1/B-5）：
 * 阻塞开（缺省，registry 注入且 ASK_USER_BLOCKING≠off）→ 先经 onUpdate 全量快照下发
 * 带 callId 的卡片（派生 tool_execution_update，Nest pi-events 提取 canvas_command；
 * callId 是前端 POST /answers 的提交依据），再等待 answer / 超时 / 中止，同 turn 续行；
 * off（开关 off 或纯文本模式无 registry）→ 逐字节 v1 旧行为：立即返回无 callId 卡片，
 * 用户点选回填为下一轮 user message（复用前端 sendMessage，零新建回流）。
 * 铁律（B-4）：registry resolve 不 reject——超时/中止一律以带 status 的正常值交还，
 * 模型看到的是工具结果而非异常；超时携带 answered-so-far（partial 语义）。
 * D1-D5 已拍板按推荐（单次问全 / 空格分隔 / allowOther 默认 true / 带取消 / 不限触发）。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { Metrics } from "../metrics.js";
import { askUserBlocking, askUserTimeoutMs } from "../runtime-config.js";
import type { PendingToolRegistry } from "../pending-registry.js";

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

export function createAskUserTools(
	metrics: Metrics,
	registry?: PendingToolRegistry,
	opts: { timeoutMs?: number } = {},
): LnkpiTool[] {
	return [{
		tier: "ui_command" as const,
		name: "ask_user",
		label: "向用户提问",
		// 阻塞语义（B-1）：等待用户作答同 turn 续行，有界（超时自动降级为自主决策）
		description: "Present clickable option chips plus free-text other to the user and WAIT for the answer within this turn (bounded, auto-degrades on timeout). Multi-question cards: the user answers all questions before submitting.",
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
		execute: async (
			id,
			p: { questions: AskUserQuestion[] },
			onUpdate,
			tc: LnkpiToolContext,
			_invocation,
			_context,
		) => {
			metrics.observeToolCall("ask_user", "ok");
			// B-5 off（或无 registry，如纯文本模式）→ 旧行为逐字节保留：立即返回，无 callId
			if (!registry || !askUserBlocking()) {
				return uiResult([{ type: "ask_user", questions: p.questions }]);
			}
			// 阻塞分支：卡片 payload 带 callId（前端 POST /answers 的依据，Task 6），
			// 经 onUpdate 全量快照下发 → tool_execution_update → Nest 派生 canvas_command
			const timeoutMs = opts.timeoutMs ?? askUserTimeoutMs();
			onUpdate?.(uiResult([{ type: "ask_user", callId: id, questions: p.questions }]));
			// registry 键 = tc.sessionId（画布会话 id）；超时兜底由 registry timer 驱动（resolve 不 reject，B-4）
			const resolution = await registry.waitForUser(tc.sessionId, id, "ask_user", timeoutMs);
			if (resolution.status === "aborted") {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, aborted: true, message: "用户已中止本轮对话。" }) }],
					details: { ok: false, aborted: true },
				};
			}
			if (resolution.status === "timeout") {
				const answered = resolution.answers;
				const skipped = p.questions.filter((q) => !answered[q.id]).map((q) => ({ id: q.id, skipped: true }));
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							ok: true, answered: true, partial: resolution.partial,
							answers: answered, skipped,
							message: "用户未响应，请基于现有信息自主决策继续；用户之后补充回答时会作为新消息到达。",
						}),
					}],
					details: { ok: true, answered: true, partial: resolution.partial },
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ ok: true, answered: true, answers: resolution.answers }) }],
				details: { ok: true, answered: true },
			};
		},
	}];
}
