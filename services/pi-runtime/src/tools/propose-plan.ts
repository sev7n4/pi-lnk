/**
 * C3 propose_plan：整场方案阻塞确认工具（spec docs/superpowers/specs/2026-10-10-plan-gate-design.md §3.2）。
 * 一次调用完成「写清单 + 等确认」（不做两步组合——组合会让 gate 状态识别脆弱）：
 * ① steps 经 overwriteTodos 落 C1 管道（前端任务卡零改动展示）；
 * ② 确认卡走 ask_user canvas_command 通道（type:"ask_user" + callId，前端零改动），
 *    三选项 execute/refine/keep + allowOther 自由输入（自由输入 = refine 意见）；
 * ③ 返回后按 decision 置 plan-gate 状态：execute 唯一解锁，其余 fail-closed 保持拦写。
 * 超时/中止沿袭 ask_user 铁律（B-4）：registry resolve 不 reject，交还带 decision 的正常值。
 * tier=ui_command（ask_user 同族）；纯文本模式无 registry → 不注册（确认通道不存在）。
 */
import { Type } from "typebox";
import type { AgentToolResult, AgentHarnessToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { PendingToolRegistry } from "../pending-registry.js";
import type { Metrics } from "../metrics.js";
import { askUserTimeoutMs } from "../runtime-config.js";
import { overwriteTodos } from "./todo.js";
import { markPlanDecision, type PlanDecision } from "../gate/plan-gate.js";

function parsePlanAnswer(values: string[]): { decision: PlanDecision; feedback?: string } {
	if (values.includes("execute")) return { decision: "execute" };
	if (values.includes("refine")) {
		return { decision: "refine", feedback: values.filter((v) => v !== "refine").join("；") || undefined };
	}
	if (values.includes("keep")) return { decision: "keep" };
	// 自由输入（allowOther）：全文视作调整意见；空答案（前端异常）也走 refine——fail-closed 不执行
	if (values.length > 0) return { decision: "refine", feedback: values.join("；") };
	return { decision: "refine" };
}

export function createProposePlanTool(registry: PendingToolRegistry, metrics: Metrics): LnkpiTool {
	return {
		tier: "ui_command" as const,
		name: "propose_plan",
		label: "提议方案",
		summary: "提交整场执行方案并阻塞等待用户确认",
		description:
			"把多步执行方案提交给用户确认：步骤清单以任务卡展示，并弹出确认卡（开始执行/调整计划/仅保留方案），本回合内阻塞等待（有界，超时自动降级）。" +
			"何时必用：用户要求「先出方案/先规划/先别动手」，或任务需要多步写画布且做法需要用户拍板时。" +
			"禁止把方案写成正文让用户手打回复；确认（confirmed=true）返回前禁止写画布节点或调用任何生成类工具。" +
			"confirmed=true 后立即开始执行第 1 步，并用 todo_write 逐项更新状态。",
		parameters: Type.Object({
			summary: Type.String({ description: "方案一句话概括（确认卡片题面，如「三步生成小红书配图并排版」）" }),
			steps: Type.Array(
				Type.Object({
					content: Type.String({ description: "步骤内容（祈使句，字面精确匹配用于状态追踪）" }),
					activeForm: Type.Optional(Type.String({ description: "进行时文案（执行中卡片主文案，如「正在配图」）" })),
				}),
				{ description: "方案步骤（确认后逐项执行并更新任务状态）", min: 1, max: 20 },
			),
		}),
		execute: async (
			id: string,
			p: { summary: string; steps: { content: string; activeForm?: string }[] },
			onUpdate: AgentHarnessToolUpdateCallback<{ ok: boolean; canvasCommands: unknown[] }> | undefined,
			tc: LnkpiToolContext,
		): Promise<AgentToolResult<{ ok: boolean; plan: Record<string, unknown> }>> => {
			metrics.observePlanProposed();
			// ① 步骤落 C1 管道：全 pending（方案尚未被确认执行）
			const { snapshot } = overwriteTodos(
				tc.sessionId,
				p.steps.map((s) => ({
					content: s.content,
					...(s.activeForm ? { activeForm: s.activeForm } : {}),
					status: "pending" as const,
				})),
			);
			// ② 确认卡（ask_user 通道同构）
			const question = {
				id: "plan_confirm",
				question: p.summary,
				options: [
					{ label: "开始执行", value: "execute" },
					{ label: "调整计划", value: "refine" },
					{ label: "仅保留方案", value: "keep" },
				],
				allowOther: true,
			};
			const canvasCommands = [{ type: "ask_user", callId: id, questions: [question] }];
			const build = (plan: Record<string, unknown>, text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { ok: true, plan: { summary: p.summary, steps: snapshot, ...plan }, canvasCommands },
			});
			onUpdate?.({
				content: [{ type: "text", text: JSON.stringify({ ok: true, canvasCommands }) }],
				details: { ok: true, canvasCommands },
			});
			const resolution = await registry.waitForUser(tc.sessionId, id, "propose_plan", askUserTimeoutMs(), {
				questionTitle: p.summary,
			});
			if (resolution.status === "aborted") {
				markPlanDecision(tc.sessionId, "aborted");
				metrics.observePlanDecision("aborted");
				return build(
					{ decision: "aborted", confirmed: false },
					JSON.stringify({ ok: true, confirmed: false, decision: "aborted", message: "用户已中止本轮对话；方案保留在任务清单，不要开始执行。" }),
				);
			}
			if (resolution.status === "timeout") {
				markPlanDecision(tc.sessionId, "timeout");
				metrics.observePlanDecision("timeout");
				return build(
					{ decision: "timeout", confirmed: false },
					JSON.stringify({ ok: true, confirmed: false, decision: "timeout", message: "用户未响应（超时）；方案保留在任务清单，不要开始执行；用户回复后可再次 propose_plan 征求确认。" }),
				);
			}
			const values = resolution.answers["plan_confirm"] ?? [];
			const { decision, feedback } = parsePlanAnswer(values);
			markPlanDecision(tc.sessionId, decision);
			metrics.observePlanDecision(decision);
			if (decision === "execute") {
				return build(
					{ decision, confirmed: true },
					JSON.stringify({ ok: true, confirmed: true, decision: "execute", message: "用户已确认方案：立即开始执行第 1 步，并用 todo_write 逐项更新状态。" }),
				);
			}
			return build(
				{ decision, confirmed: false, ...(feedback ? { feedback } : {}) },
				JSON.stringify({
					ok: true,
					confirmed: false,
					decision,
					...(feedback ? { feedback } : {}),
					message:
						decision === "refine"
							? "用户要求调整方案（见 feedback）；修改步骤后再次 propose_plan 征求确认。"
							: "用户选择仅保留方案（不执行）；写操作保持拦截，除非用户之后再次确认。",
				}),
			);
		},
	};
}
