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
import { SUBAGENT_REPORT_MAX_CHARS } from "../gate/subagent.js";
import type { Metrics } from "../metrics.js";

function textResult(data: unknown): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: JSON.stringify(data) }],
		details: data as Record<string, unknown>,
	} as AgentToolResult<Record<string, unknown>>;
}

export function createSpawnSubagentTool(coordinator: SubagentCoordinator, metrics: Metrics): LnkpiTool {
	return {
		tier: "write_light" as const,
		name: "spawn_subagent",
		label: "派发子代理",
		summary: "派发一个只读调研子代理并阻塞等待其报告",
		description:
			"把一项只读调研任务交给子代理执行：它带着本对话的完整上下文独立工作（可查画布/读文档/联网搜索），" +
			"结束后把最终报告作为本工具结果返回。本回合阻塞等待（有界：并发/轮次/时长三重硬边界）。" +
			"何时必用：需要大范围查资料/核对多文件/联网调研，且探索过程不值得占用主对话窗口时。" +
			"子代理只能读不能写——需要改画布/生成内容时不要派发，自己做。",
		parameters: Type.Object({
			task: Type.String({ description: "任务描述（写清背景、要查什么、期望的报告形态）" }),
		}),
		execute: async (_id, p: { task?: string }, _u, tc: { piSessionKey?: string }) => {
			const task = (p?.task ?? "").trim();
			const piSessionKey = tc?.piSessionKey;
			if (!task) return textResult({ ok: false, error: "spawn_subagent_requires_task" });
			if (!piSessionKey) return textResult({ ok: false, error: "spawn_subagent_requires_pi_session_key" });
			const attempt = coordinator.tryRun(piSessionKey, task);
			if (!attempt.ok) {
				metrics.observeSubagentRejected(attempt.reason);
				return textResult({
					ok: false,
					error:
						attempt.reason === "concurrency_full"
							? "subagent_concurrency_full"
							: "subagent_not_available",
				});
			}
			metrics.observeSubagentSpawned();
			const outcome = await attempt.promise;
			const report =
				outcome.report.length > SUBAGENT_REPORT_MAX_CHARS
					? `${outcome.report.slice(0, SUBAGENT_REPORT_MAX_CHARS)}…[截断]`
					: outcome.report;
			if (outcome.status === "completed") {
				return textResult({ ok: true, report, usage: { turns: outcome.turns, durationMs: outcome.durationMs, status: outcome.status } });
			}
			return textResult({
				ok: false,
				error: `subagent_${outcome.status}`,
				report,
				usage: { turns: outcome.turns, durationMs: outcome.durationMs, status: outcome.status },
			});
		},
	};
}
