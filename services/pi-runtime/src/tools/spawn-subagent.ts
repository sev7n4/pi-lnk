/**
 * C4 spawn_subagent 工具（spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.1/§3.5）。
 *
 * 模型自主派发只读 Explore 子代理：同步阻塞到子 run 结束，报告作为工具结果回流主对话
 * （跨压缩存活同 C1 机制、前端零迁移、协议零新增）。子代理进度卡片 = 本工具调用自身的
 * tool_start/tool_end 生命周期（既有事件管道，前端零改动）。
 *
 * fail-soft 铁律：execute 永不 throw——coordinator 契约（promise 永不 reject）+
 * 本层二次兜底，主 run 不因子代理任何形态的失败而中断。
 *
 * tier=write_light：进 plan-gate 拦截面（plan 未确认不能派发重操作，与 C3 拦写同语义）。
 */
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { LnkpiTool } from "./types.js";
import type { SubagentCoordinator } from "../gate/subagent.js";
import type { Metrics } from "../metrics.js";

function textResult(data: unknown): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: JSON.stringify(data) }],
		details: data as Record<string, unknown>,
	} as AgentToolResult<Record<string, unknown>>;
}

/** 刀B（spec 2026-11-14-subagent-contract-d2-nonblock-design.md §4.4）：缺省报告骨架——
 *  模型不给 reportFormat 时子代理 prompt 自动含「结论先行 + 来源清单 + 未核实标注」契约，
 *  治「报告形态全凭子代理自由发挥」（G6 后半）。不改子代理 system prompt（basePrompt 转发链零触碰）。 */
export const DEFAULT_REPORT_FORMAT =
	"结论先行（先给核心判断，再分节展开论据）；末尾必须附「来源」清单（每条含来源名与链接/出处），无法核实的说法标注「未核实」。";

/** 刀B（§4.1）：task 结构化组装——task + 可选 background + 期望报告形态（缺省骨架）。
 *  组装在工具层完成，runSubagent 不感知；空/纯空白 background 跳过。 */
export function composeSubagentPrompt(task: string, background?: string, reportFormat?: string): string {
	const parts = [task.trim()];
	if (background?.trim()) parts.push(`【背景】${background.trim()}`);
	// ⚠️ 空串不算「提供了」——必须 || 兜底，`??` 对 "" 不生效（测试钉住）
	parts.push(`【期望报告形态】${(reportFormat ?? "").trim() || DEFAULT_REPORT_FORMAT}`);
	return parts.join("\n");
}

export function createSpawnSubagentTool(coordinator: SubagentCoordinator, metrics: Metrics): LnkpiTool {
	return {
		tier: "write_light" as const,
		name: "spawn_subagent",
		label: "派发子代理",
		summary: "派发一个只读调研子代理并阻塞等待其报告",
		description:
			"把一项只读调研派给子代理：它带完整上下文独立工作（查画布/读文档/联网），返回报告后阻塞本回合。" +
			"优先用：任务含「调研/研究/探索/多源核对/联网查资料」，且探索过程不值得占主窗口。" +
			"并行多路调研可用 mode:'background' 派发后先做别的，结束前用 collect_subagent_result 收取。" +
			"禁用：要改画布/生成内容时别派，自己做。",
		parameters: Type.Object({
			task: Type.String({ description: "要查什么（核心问题清单，越具体越好）" }),
			background: Type.Optional(Type.String({ description: "背景补充（已读过什么/已试过什么/相关约束），可选" })),
			reportFormat: Type.Optional(Type.String({ description: "期望的报告结构与重点，可选；缺省用内置骨架（结论先行+来源清单）" })),
			mode: Type.Optional(Type.Union([Type.Literal("block"), Type.Literal("background")], {
				description: "block（默认）：阻塞等报告；background：立即返回 callId 后台跑，稍后用 collect_subagent_result 查询。并行多路对比调研才用 background",
			})),
		}),
	// 6 参姿势（vendor AgentHarnessTool 真实签名）：chordCtx 携带本 run 的 abortSignal——
	// 评审 I2：用户「停止」主 run 时联动取消子 run（signal 经 coordinator → runSubagent.run.cancel）。
	execute: async (
		_id,
		p: { task?: string; background?: string; reportFormat?: string; mode?: "block" | "background" },
		_u,
		tc: { piSessionKey?: string },
		_invocation: unknown,
		chordCtx: { abortSignal?: AbortSignal } | undefined,
	) => {
		const rawTask = (p?.task ?? "").trim();
		const piSessionKey = tc?.piSessionKey;
		if (!rawTask) return textResult({ ok: false, error: "spawn_subagent_requires_task" });
		if (!piSessionKey) return textResult({ ok: false, error: "spawn_subagent_requires_pi_session_key" });
		// 刀B：结构化组装（task + 背景 + 期望报告形态）——runSubagent 收到的是组装后的完整 prompt
		const task = composeSubagentPrompt(rawTask, p?.background, p?.reportFormat);
		// 刀A（spec 2026-11-14 §6.3）：block（默认）/background 双模式——background 立即返回 callId
		const mode: "block" | "background" = p?.mode === "background" ? "background" : "block";
		const attempt = coordinator.tryRun(piSessionKey, task, { signal: chordCtx?.abortSignal, mode });
		if (!attempt.ok) {
			metrics.observeSubagentRejected(attempt.reason);
			return textResult({
				ok: false,
				error:
					attempt.reason === "concurrency_full"
						? "subagent_concurrency_full"
						: "subagent_not_available",
				hint: "子代理暂不可用，请自行联网/读文档完成调研，不要卡死或静默放弃。",
			});
		}
		metrics.observeSubagentSpawned();
		if (mode === "background") {
			return textResult({
				ok: true,
				callId: attempt.callId,
				status: "running",
				hint: "调研已后台派发。可先做其他事（读画布/整理已有信息），回合结束前必须用 collect_subagent_result 查询结果。",
			});
		}
		const outcome = await attempt.promise;
		// C4 outcome 埋点（2026-11-11 D1）：补齐正常 4 态的结算样本，让
		// ∑outcome 与 spawned 的差值在**单进程生命周期内**可判「派出去的那个回来没」。
		//
		// ⚠️ 诚实边界，不得据此宣称事故已闭环：本次生产事故是 pi-runtime pod 在
		// tool_call 发出 0.4s 后被滚动更新替换 —— 进程连同父子 run 与这条内存 promise
		// 一起蒸发，本行**永远执行不到**；且 counter 是进程内内存，pod 重启即归零。
		// 中断归因由 Nest 侧落库的 AgentEvent 账本（turn_interrupted）承担；
		// 真正的跨进程闭环要等 D2 子任务单据，不是这行埋点。
		metrics.observeSubagentOutcome(outcome.status);
		// 截断唯一属主 = applyReportTruncation（runSubagent 内），此处只透传
		const report = outcome.report;
			if (outcome.status === "completed") {
				return textResult({ ok: true, callId: attempt.callId, report, usage: { turns: outcome.turns, durationMs: outcome.durationMs, status: outcome.status }, truncated: outcome.truncated === true ? true : undefined });
			}
			return textResult({
				ok: false,
				error: `subagent_${outcome.status}`,
				callId: attempt.callId,
				report,
				usage: { turns: outcome.turns, durationMs: outcome.durationMs, status: outcome.status },
				truncated: outcome.truncated === true ? true : undefined,
			});
		},
	};
}

/** 刀A（spec 2026-11-14 §6.3）：collect_subagent_result——按 callId 查后台子任务状态/报告。
 *  tier=read（天然不在 plan-gate 拦截面）；与 spawn 同条件注册（coordinator 存在即可）；
 *  不进子代理白名单（子代理不可 collect，嵌套/越权双封）。 */
export function createCollectSubagentTool(coordinator: SubagentCoordinator, metrics: Metrics): LnkpiTool {
	return {
		tier: "read" as const,
		name: "collect_subagent_result",
		label: "收取子代理结果",
		summary: "按 callId 查询后台子代理调研的状态与报告",
		description:
			"查询 spawn_subagent(mode:'background') 派发的子任务。status=running 表示仍在跑，稍后再查；" +
			"终态返回 report（completed/failed/timeout/budget_exceeded）；" +
			"interrupted/unknown 表示记录不存在或已随进程重启丢失，请重新派发调研。",
		parameters: Type.Object({
			callId: Type.String({ description: "spawn_subagent 返回的 callId" }),
		}),
		execute: async (
			_id,
			p: { callId?: string },
		) => {
			const callId = (p?.callId ?? "").trim();
			if (!callId) return textResult({ ok: false, error: "collect_requires_call_id" });
			const r = coordinator.collect(callId);
			metrics.observeSubagentCollected(r.status);
			if (r.status === "running") {
				return textResult({ ok: true, callId, status: "running", hint: "子任务仍在运行，先做其他事，稍后再查。" });
			}
			if (r.status === "unknown" || r.status === "interrupted") {
				return textResult({
					ok: false,
					error: `subagent_${r.status}`,
					hint: "子任务记录不存在或已随进程重启丢失（账本有 spawned 无终态）。结果不可恢复，请重新派发调研。",
				});
			}
			return textResult({
				ok: true,
				callId,
				status: r.status,
				report: r.report,
				usage: { turns: r.turns, durationMs: r.durationMs, status: r.status },
				truncated: r.truncated === true ? true : undefined,
			});
		},
	};
}
