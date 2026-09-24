/**
 * B8：pi AgentEvent（归一）→ 现有 UI 事件映射（spec §8.5.2）
 *
 * 现有事件名实测自 apps/server/src/agent/agent.service.ts 的消费端
 * （text_delta / text_replace / canvas_action / journey_update / interrupt / done ...）。
 *
 * ⚠️ 完整 11 → 17 映射表在 spec 写作 Round 5 补完；本文件先落地 P0 shadow
 * 验证所需的最小映射，未映射事件原样透传（type 加 `pi_` 前缀避免歧义）。
 */

import { CanvasActionSchema, type CanvasAction } from "@lnkpi/shared";

/** pi-runtime SSE 归一事件（与 services/pi-runtime/src/session-manager.ts 对齐） */
export interface PiRuntimeEvent<T = unknown> {
	type: PiEventType;
	lane?: string;
	ts: number;
	data: T;
}

export type PiEventType =
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "message_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "error";

/** 现有 UI 事件（消费端实测子集；其余事件类型保持 passthrough） */
export interface UiEvent<T = unknown> {
	type: string;
	data: T;
}

/**
 * 从 message_update 事件提取文本增量。
 *
 * 实测校准（2026-09-23 e2e，agnes-2.5-pro）：
 *  - harness message_update 的 AssistantMessageEvent 挂在字段 `event`
 *    （spec §8.5.1 的 assistantMessageEvent 是底层 Agent.subscribe() 字段名）
 *  - 事件类型枚举：thinking_start / thinking_delta / text_start / text_delta /
 *    thinking_end / text_end —— 文本增量是 type: "text_delta" + delta 字段
 */
export function extractTextDelta(event: PiRuntimeEvent): string | null {
	if (event.type !== "message_update") return null;
	const data = event.data as {
		event?: { type?: string; delta?: string };
		assistantMessageEvent?: { type?: string; delta?: string };
	};
	const ame = data.event ?? data.assistantMessageEvent;
	if (ame?.type === "text_delta" && typeof ame.delta === "string") {
		return ame.delta;
	}
	// 非文本 delta（thinking 等）不产出 text_delta
	return null;
}

/**
 * 最小映射：
 *   message_update(文本 delta) → text_delta      （流式渲染主通道）
 *   tool_execution_start       → tool_call       （工具开始）
 *   tool_execution_end         → tool_result     （工具结束，含 isError）
 *   agent_end                  → done            （回合结束，status 透传）
 *   其余                        → pi_ 前缀透传     （Round 5 补全映射）
 */
export function mapPiEventToUiEvent(event: PiRuntimeEvent): UiEvent | null {
	const delta = extractTextDelta(event);
	if (delta !== null) {
		return { type: "text_delta", data: { text: delta } };
	}

	switch (event.type) {
		case "tool_execution_start": {
			const d = event.data as { toolCallId: string; toolName: string; args: unknown };
			return { type: "tool_call", data: { toolCallId: d.toolCallId, toolName: d.toolName, args: d.args } };
		}
		case "tool_execution_end": {
			const d = event.data as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
			return {
				type: "tool_result",
				data: { toolCallId: d.toolCallId, toolName: d.toolName, result: d.result, isError: d.isError },
			};
		}
		case "agent_end": {
			const d = event.data as { status?: string; error?: unknown };
			return {
				type: "done",
				data: { status: d.status ?? "completed", error: d.error ?? null, __pi: true },
			};
		}
		case "message_update":
			// message_update 但取不到文本 delta（thinking/工具参数流）：Round 5 决定 UI 事件
			return null;
		default:
			return { type: `pi_${event.type}`, data: event.data, };
	}
}

/** UI_COMMAND 工具 details 中的画布命令（形态对齐前端 AgentSideRail canvas_command 分支）。 */
export interface PiCanvasCommand {
	type: string;
	nodeId?: string;
	nodeIds?: string[];
}

/**
 * UI_COMMAND 批次：从 tool_execution_end 的 result.details.canvasCommands
 * 提取 UI 命令（派生 canvas_command 事件，同名同形态于老链路 runs.py:1220）。
 * ⚠️ 事件名是 canvas_command 不是 canvas_action——后者走 CanvasActionSchema，
 * 只认 add_node 等 6 种画布数据动作，focus/undo 会被前端静默丢弃。
 * 仅本地 UI_COMMAND 工具的 details 含 canvasCommands 键；Nest 转发工具的
 * details 是 {ok,data} 形态，天然不命中，无需按工具名白名单。
 */
export function extractCanvasCommands(event: PiRuntimeEvent): PiCanvasCommand[] {
	if (event.type !== "tool_execution_end") return [];
	const d = event.data as {
		isError?: boolean;
		result?: { details?: { canvasCommands?: unknown } };
	};
	if (d.isError) return [];
	const cmds = d.result?.details?.canvasCommands;
	if (!Array.isArray(cmds)) return [];
	return cmds.filter(
		(c): c is PiCanvasCommand =>
			!!c && typeof c === "object" && typeof (c as { type?: unknown }).type === "string",
	);
}

/**
 * B-5：从 tool_execution_end 的 result.details.actions 提取画布数据动作
 * （派生 canvas_action 事件，语义对齐老链路 NestEventProxy 转发工具返回的 actions）。
 * safeParse 逐条校验：脏数据跳过（Review Focus #5），isError 结果不派生。
 * 注意：@lnkpi/shared 有两套 CanvasAction——agentContract zod 版（nodeType: string）
 * 与 index.ts interface 版（nodeType: NodeType）。此处用 zod 版做结构校验，再用
 * NodeType 白名单收窄到 interface 版（消费方 agent.service.ts 走 interface 版）。
 */
const NODE_TYPES: ReadonlySet<string> = new Set([
	"prompt",
	"image",
	"video",
	"text",
	"group",
	"shot",
	"sceneComposer",
]);

export function extractCanvasActions(event: PiRuntimeEvent): CanvasAction[] {
	if (event.type !== "tool_execution_end") return [];
	const d = event.data as {
		isError?: boolean;
		result?: { details?: { actions?: unknown } };
	};
	if (d.isError) return [];
	const actions = d.result?.details?.actions;
	if (!Array.isArray(actions)) return [];
	const out: CanvasAction[] = [];
	for (const a of actions) {
		const parsed = CanvasActionSchema.safeParse(a);
		if (!parsed.success) continue;
		const nodeType = parsed.data.payload.nodeType;
		if (nodeType !== undefined && !NODE_TYPES.has(nodeType)) continue;
		out.push(parsed.data as CanvasAction);
	}
	return out;
}
