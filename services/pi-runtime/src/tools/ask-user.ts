/**
 * ask_user 工具（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md；
 * 阻塞分支 2026-09-30-ask-user-blocking，B-1/B-5）：
 * 阻塞开（缺省，registry 注入且 ASK_USER_BLOCKING≠off）→ 先经 onUpdate 全量快照下发
 * 带 callId 的卡片（派生 tool_execution_update，Nest pi-events 提取 canvas_command；
 * callId 是前端 POST /answers 的提交依据），再等待 answer / 超时 / 中止，同 turn 续行；
 * off（开关 off 或纯文本模式无 registry）→ 逐字节 v1 旧行为：立即返回无 callId 卡片，
 * 用户点选回填为下一轮 user message（复用前端 sendMessage，零新建回流）。
 * 铁律（B-4）：registry resolve 不 reject——超时/中止一律以带 status 的正常值交还，
 * 模型看到的是工具结果而非异常；**超时一律交还空 answers + 全题 skipped**（无「带回半个答案」
 * 这一语义，2026-10-02 删除 `recordPartial` API 后不再有部分作答的暂存通道）。
 * D1-D5 已拍板按推荐（单次问全 / 空格分隔 / allowOther 默认 true / 带取消 / 不限触发）。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import { askUserBlocking, askUserTimeoutMs } from "../runtime-config.js";
import type { PendingToolRegistry } from "../pending-registry.js";

export interface AskUserQuestion {
	id: string;
	question: string;
	options: { label: string; value: string }[];
	multiSelect?: boolean;
	allowOther?: boolean;
}

/** T2 契约上限：与 schema `max` 同源，单一事实源（spec §5.3 / §9）。 */
export const ASK_USER_MAX_QUESTIONS = 4

/**
 * T2 契约强制（fail-closed，对齐 SP-D）：在工具入口校验 questions 的字段合法性与题目数上限，
 * 非法输入以带精确指引的 tool_result 交还（非抛异常），引导模型修正后重试，
 * 杜绝畸形/越界数据穿透到 UI 造成崩溃（生产实证：模型发 5 题 → 多题卡溢出卡死）。
 * 纯函数，单测锁定（spec §8）。
 */
export function validateAskQuestions(
	questions: unknown,
	max = ASK_USER_MAX_QUESTIONS,
): { ok: true } | { ok: false; reason: string } {
	if (!Array.isArray(questions) || questions.length === 0) {
		return { ok: false, reason: "questions 必须是非空数组" };
	}
	if (questions.length > max) {
		return { ok: false, reason: `questions 超过上限 ${max}（收到 ${questions.length}），请合并或缩减为 ≤${max} 题后重试` };
	}
	for (const q of questions) {
		if (!q || typeof q !== "object") return { ok: false, reason: "存在非法题目对象" };
		const qq = q as Record<string, unknown>;
		if (typeof qq.id !== "string" || !qq.id.trim()) return { ok: false, reason: "每题必须有非空 id" };
		if (typeof qq.question !== "string" || !qq.question.trim()) return { ok: false, reason: `题目 ${qq.id} 必须有非空 question` };
		if (!Array.isArray(qq.options) || qq.options.length < 1) return { ok: false, reason: `题目 ${qq.id} 至少要有 1 个选项` };
		for (const o of qq.options) {
			if (!o || typeof o !== "object") return { ok: false, reason: `题目 ${qq.id} 存在非法选项` };
			const oo = o as Record<string, unknown>;
			if (typeof oo.label !== "string" || !oo.label.trim()) return { ok: false, reason: `题目 ${qq.id} 选项 label 不能为空` };
			if (typeof oo.value !== "string" || !oo.value.trim()) return { ok: false, reason: `题目 ${qq.id} 选项 value 不能为空` };
		}
	}
	return { ok: true };
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
	registry?: PendingToolRegistry,
	opts: { timeoutMs?: number } = {},
): LnkpiTool[] {
	return [{
		tier: "ui_command" as const,
		name: "ask_user",
		label: "向用户提问",
		// 阻塞语义（B-1）：等待用户作答同 turn 续行，有界（超时自动降级为自主决策）
		// ⚠️ 2026-10-03：description 必须带「何时用」与「不得怎样」，否则弱模型把「问用户」
		// 当成写正文（生产实证：agnes-2.5-flash 全程 0 次调用，改用纯文本列选项）。
		description: "向用户展示可点击选项卡（含「其他」自由输入）并在本回合内等待作答（有界，超时自动降级）。何时必用：继续干活前必须确认的关键信息缺失、或需要用户在有限候选里择一。禁止把候选写成普通正文让用户手打回复。多题卡片：用户答完全部题目才提交。有推荐时把推荐选项放首位并在 label 标注「（推荐）」，description 说明推荐理由。不得问可合理默认的细节（尺寸/张数/分辨率按场景默认并在回复中声明）。",
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
			}), { min: 1, max: ASK_USER_MAX_QUESTIONS }),
		}),
		execute: async (
			id,
			p: { questions: AskUserQuestion[] },
			onUpdate,
			tc: LnkpiToolContext,
			_invocation,
			_context,
		) => {
			// T2 契约强制：入口校验 questions（字段合法 + ≤上限）。非法以带指引的 tool_result 交还，
			// 阻塞/非阻塞两分支共用，fail-closed（模型按指引修正重试，UI 永不收到越界数据）。
			const validation = validateAskQuestions(p.questions);
			if (!validation.ok) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, invalidArgs: true, message: validation.reason }) }],
					details: { ok: false, invalidArgs: true },
				};
			}
			// 2026-10-04：不再自计 tool_calls_total（移交事件层，避免与 harness 的
			// tool_start/tool_end 双计）。阻塞结算指标仍走 index.ts 的 registry hook。
			// B-5 off（或无 registry，如纯文本模式）→ 旧行为逐字节保留：立即返回，无 callId
			if (!registry || !askUserBlocking()) {
				return uiResult([{ type: "ask_user", questions: p.questions }]);
			}
			// 阻塞分支：卡片 payload 带 callId（前端 POST /answers 的依据，Task 6），
			// 经 onUpdate 全量快照下发 → tool_execution_update → Nest 派生 canvas_command
			const timeoutMs = opts.timeoutMs ?? askUserTimeoutMs();
			onUpdate?.(uiResult([{ type: "ask_user", callId: id, questions: p.questions }]));
			// registry 键 = tc.sessionId（画布会话 id）；超时兜底由 registry timer 驱动（resolve 不 reject，B-4）
			// meta 随 waiting_user 事件下发：题面让前端状态行能显示「等待你作答：…」，而不是一句
			// 无信息量的「等待你确认」（propose_generation 同样走 meta 带 nodeId，两类卡能力对齐）
			const resolution = await registry.waitForUser(tc.sessionId, id, "ask_user", timeoutMs, {
				questionTitle: p.questions.map((q) => q.question).join(" / "),
			});
			if (resolution.status === "aborted") {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, aborted: true, message: "用户已中止本轮对话。" }) }],
					details: { ok: false, aborted: true },
				};
			}
			if (resolution.status === "timeout") {
				// 超时即**全部未答**：没有 partial 通道，逐题标 skipped 让模型明确「这轮什么都没拿到」，
				// 而不是拿着半个答案去推进（旧实现承诺带回 answered-so-far，但那条通道从未接通）
				const skipped = p.questions.map((q) => ({ id: q.id, skipped: true }));
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							ok: true, answered: true, answers: {}, skipped,
							message: "用户未作答（超时），所有题目都按跳过处理；请基于现有信息自主决策继续，不要假设任何一题的答案。用户之后补充回答时会作为新消息到达。",
						}),
					}],
					details: { ok: true, answered: true, skippedCount: skipped.length },
				};
			}
			// 结算指标统一在 index.ts 的 registry hook（onSettled）里记，避免工具层重复计数
			return {
				content: [{ type: "text", text: JSON.stringify({ ok: true, answered: true, answers: resolution.answers }) }],
				details: { ok: true, answered: true },
			};
		},
	}];
}
