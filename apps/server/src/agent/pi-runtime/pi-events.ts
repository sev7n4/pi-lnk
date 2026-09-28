/**
 * B8：pi AgentEvent（归一）→ 现有 UI 事件映射（spec §8.5.2）
 *
 * 现有事件名实测自 apps/server/src/agent/agent.service.ts 的消费端
 * （text_delta / text_replace / canvas_action / interrupt / done ...）。
 *
 * ⚠️ 完整 11 → 17 映射表在 spec 写作 Round 5 补完；本文件先落地 P0 shadow
 * 验证所需的最小映射，未映射事件原样透传（type 加 `pi_` 前缀避免歧义）。
 */

import { CanvasActionSchema, NODE_TYPES, type CanvasAction } from "@lnkpi/shared";

/** pi-runtime SSE 归一事件（与 services/pi-runtime/src/session-manager.ts 对齐） */
export interface PiRuntimeEvent<T = unknown> {
	type: PiEventType;
	lane?: string;
	ts: number;
	/** 会话内单调 seq（pi-runtime P0-③ 起在 data 内携带，供诊断与增量重连对照）。 */
	seq?: number;
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
			// name 为老 runtime tool_call 契约字段（前端 SideRail/Panel/FloatingWindow/reducer 均读
			// data.name）——2026-09-25 侧栏实测「调用 undefined」即缺它所致；toolName 保留兼容。
			return { type: "tool_call", data: { toolCallId: d.toolCallId, name: d.toolName, toolName: d.toolName, args: d.args } };
		}
		case "tool_execution_end": {
			const d = event.data as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
			return {
				type: "tool_result",
				data: { toolCallId: d.toolCallId, name: d.toolName, toolName: d.toolName, result: d.result, isError: d.isError },
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

/** ask_user 工具产出的问题定义（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md）。 */
export interface AskUserQuestion {
	id: string;
	question: string;
	options: { label: string; value: string }[];
	multiSelect?: boolean;
	allowOther?: boolean;
}

/** arrange_nodes 工具产出的有向边（spec docs/superpowers/specs/2026-09-28-arrange-nodes-tool-design.md）。 */
export interface ArrangeEdge {
	source: string;
	target: string;
}

/** UI_COMMAND 工具 details 中的画布命令（形态对齐前端 AgentSideRail canvas_command 分支）。 */
export interface PiCanvasCommand {
	type: string;
	nodeId?: string;
	nodeIds?: string[];
	/** ask_user 工具产出；仅 type="ask_user" 时有。extractCanvasCommands filter 不变（只校验 type:string），questions 透传。 */
	questions?: AskUserQuestion[];
	/** arrange_nodes 工具产出；仅 type="arrange_nodes" 时有。extractCanvasCommands filter 不变（只校验 type:string），新字段透传。 */
	mode?: "grid" | "along_edges";
	gap?: number;
	edges?: ArrangeEdge[];
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
 * nodeType 按 NODE_TYPES 白名单收窄（Review Focus #5）。
 * 契约已收敛：CanvasAction 单一来源为 @lnkpi/shared 的 CanvasActionSchema（zod 派生），
 * 不再存在「zod 版 / interface 版」两套类型，故此处无需再 `as CanvasAction` 强转。
 */
const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

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
		if (nodeType !== undefined && !NODE_TYPE_SET.has(nodeType)) continue;
		out.push(parsed.data);
	}
	return out;
}

/** message_update 内嵌的 thinking 子事件（thinking_start/delta/end，实测见文件头注释）。 */
export interface ThinkingPhase {
	phase: "start" | "delta" | "end";
	text?: string;
}

export function extractThinking(event: PiRuntimeEvent): ThinkingPhase | null {
	if (event.type !== "message_update") return null;
	const data = event.data as {
		event?: { type?: string; delta?: string };
		assistantMessageEvent?: { type?: string; delta?: string };
	};
	const ame = data.event ?? data.assistantMessageEvent;
	if (!ame) return null;
	if (ame.type === "thinking_start") return { phase: "start" };
	if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
		return { phase: "delta", text: ame.delta };
	}
	if (ame.type === "thinking_end") return { phase: "end" };
	return null;
}

/**
 * thinking 累积器（可观测性专项 ③）：把 pi 的流式 thinking 子事件折叠为
 * 老 UI 契约的 `thinking` 事件（start→running，end→done+截断摘要）。
 * delta 只累积不透传（v1 不做逐字思考流），摘要取前 limit 字符。
 */
export function createThinkingAccumulator(limit = 200): {
	feed(event: PiRuntimeEvent): UiEvent | null;
} {
	let buffer = "";
	return {
		feed(event: PiRuntimeEvent): UiEvent | null {
			const t = extractThinking(event);
			if (!t) return null;
			if (t.phase === "start") return { type: "thinking", data: { status: "running" } };
			if (t.phase === "delta" && t.text) {
				buffer += t.text;
				return null;
			}
		const summary = buffer.slice(0, limit);
		return { type: "thinking", data: { status: "done", summary: summary || undefined } };
		},
	};
}

export interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
}

function extractUsageDelta(event: PiRuntimeEvent): TurnUsage | null {
	if (event.type !== "message_end") return null;
	const usage = (event.data as { message?: { usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } } })
		.message?.usage;
	if (!usage || typeof usage !== "object") return null;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	// 口径对齐 vendor models.ts:892 calculateCost：inputTokens = input + cacheRead + cacheWrite
	const inputTokens = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
	return { inputTokens, outputTokens: num(usage.output) };
}

/** P1 状态行：message_end.usage 逐条累积，agent_end 前折叠为一次 turn_usage 事件。
 * 仅当本回合出现过至少一条带 usage 的 message_end 才发（seenUsage 门）——区分
 * 「上游没回 usage」（不显示 tokens 段）与「usage 真为 0」（显示 0），杜绝误导。 */
export function createUsageAccumulator(): {
	feed(event: PiRuntimeEvent): UiEvent | null;
} {
	let input = 0;
	let output = 0;
	let seenUsage = false;
	return {
		feed(event: PiRuntimeEvent): UiEvent | null {
			const delta = extractUsageDelta(event);
			if (delta) {
				seenUsage = true;
				input += delta.inputTokens;
				output += delta.outputTokens;
				return null;
			}
			if (event.type === "agent_end") {
				if (!seenUsage) return null;
				return { type: "turn_usage", data: { inputTokens: input, outputTokens: output } };
			}
			return null;
		},
	};
}
