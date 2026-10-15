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
import { z } from "zod";

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
	| "error"
	/** 阻塞式确认工具（ask_user / propose_generation）等待生命周期（2026-10-01）。 */
	| "waiting_user"
	/** 「正在做什么」（决策 8）：工具起手即发，人话由客户端目录翻译，runtime 只给工具名。 */
	| "activity"
	/** 上下文压缩起止（审计 #6）：vendor compaction_start/end 归一，payload 由 Nest 归一为 phase。 */
	| "compaction"
	/** P2：vendor「调度恢复中」标记（retry_scheduled{recovery:true}）透传——前端据此显示
	 *  「会话恢复中」而非「上游响应超时」。 */
	| "recovery";

/** 现有 UI 事件（消费端实测子集；其余事件类型保持 passthrough） */
export interface UiEvent<T = unknown> {
	type: string;
	data: T;
	/**
	 * P0（agent-turn-timeline-design §5 P0-3）：把 pi-runtime 的会话内单调 `seq`
	 * 透传下来，供 P1 按 seq 做稳定插入（P0 仍按 SSE 到达序渲染，不消费本字段）。
	 * 可选：未携带时上游不保证序，且 `toEqual` 会忽略 undefined，不影响既有测试。
	 * ⚠️ `ts` 暂不在此透传——`PiRuntimeEvent.ts` 为必填，既有 mapPiEventToUiEvent
	 * 测试用 `toEqual({type,data})` 精确比对，带 ts 会破坏；P1 前端真正按序插入时再补并同步改测试。
	 */
	seq?: number;
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
 * 上游帧契约（2026-10-14 深读 vendor）：message_update 内嵌的 `text_end` 子事件
 * 携带 `contentIndex` + **整块 `content`**（vendor packages/ai/src/types.ts:550：
 * `{ type:"text_end"; contentIndex; content: string; partial }`），是 AssistantMessage.content
 * 有序块模型里「一段正文块」的**权威边界**——不是启发式，是上游 replayable 帧协议的原生语义。
 *
 * 返回整块文本（仅用于边界判定/校验，正文数据源仍是 text_delta 流——plan 剥离在 delta 侧做）。
 */
export function extractTextEnd(event: PiRuntimeEvent): string | null {
	if (event.type !== "message_update") return null;
	const data = event.data as {
		event?: { type?: string; content?: string };
		assistantMessageEvent?: { type?: string; content?: string };
	};
	const ame = data.event ?? data.assistantMessageEvent;
	if (ame?.type === "text_end" && typeof ame.content === "string") {
		return ame.content;
	}
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
	// P0（agent-turn-timeline-design §5 P0-3）：统一把服务端 seq 透传到 UiEvent，
	// 供 P1 按 seq 稳定插入。seq 可选，未携带时为 undefined（toEqual 忽略，零回归）。
	const ui = (type: string, data: unknown): UiEvent => ({ type, data, seq: event.seq });

	const delta = extractTextDelta(event);
	if (delta !== null) {
		return ui("text_delta", { text: delta });
	}

	switch (event.type) {
		case "tool_execution_start": {
			const d = event.data as { toolCallId: string; toolName: string; args: unknown };
			// name 为老 runtime tool_call 契约字段（前端 SideRail/Panel/FloatingWindow/reducer 均读
			// data.name）——2026-09-25 侧栏实测「调用 undefined」即缺它所致；toolName 保留兼容。
			return ui("tool_call", { toolCallId: d.toolCallId, name: d.toolName, toolName: d.toolName, args: d.args });
		}
		case "tool_execution_end": {
			const d = event.data as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
			return ui("tool_result", {
				toolCallId: d.toolCallId,
				name: d.toolName,
				toolName: d.toolName,
				result: d.result,
				isError: d.isError,
			});
		}
		case "agent_end": {
			const d = event.data as { status?: string; error?: unknown };
			return ui("done", { status: d.status ?? "completed", error: d.error ?? null, __pi: true });
		}
		case "message_update":
			// message_update 但取不到文本 delta（thinking/工具参数流）：Round 5 决定 UI 事件
			return null;
		case "error": {
			// P0 错误链路修复：error 原先落 default → pi_error 透传 → 前端静默丢弃，
			// 运行中报错用户只见「空回复兜底」。映射为前端已有完整分支的 error 事件。
			const d = event.data as {
				message?: string;
				error_type?: string;
				retry_hint?: string;
				tool_name?: string;
			};
			return ui("error", {
				message: d.message,
				error_type: d.error_type,
				retry_hint: d.retry_hint,
				tool_name: d.tool_name,
			});
		}
		case "waiting_user": {
			// 阻塞等待可见化（2026-10-01）：透传给前端做状态行/确认提示。
			// 不走 default 的 `pi_` 前缀——前端按 type 分支消费，加前缀会被静默丢弃。
			const d = event.data as {
				status?: string;
				toolName?: string;
				callId?: string;
				timeoutMs?: number;
				nodeId?: string;
				reason?: string;
			};
			return ui("waiting_user", {
				status: d.status === "resolved" ? "resolved" : "waiting",
				toolName: d.toolName,
				callId: d.callId,
				timeoutMs: d.timeoutMs,
				nodeId: d.nodeId,
				reason: d.reason,
			});
		}
		case "activity": {
			// 「正在做什么」（决策 8）：同样不走 default 的 `pi_` 前缀——加了前缀前端按 type
			// 分支消费时会静默丢弃，状态行就退回「处理中」，等于这三层白接了。
			// 载荷原样透传：toolName 给客户端查中文目录，done 给进度措辞。
			const d = event.data as {
				toolName?: string;
				done?: number;
				total?: number;
			};
			return ui("activity", {
				toolName: d.toolName,
				done: d.done,
				// total 在 vendor harness 侧无源（turn_start 不带计划步数）→ runtime 不产生，
				// 这里也不伪造；前端据此只说「第 N 步」，不渲染假分母。
				total: d.total,
			});
		}
		case 'compaction': {
			// 审计 #6 压缩可见性：vendor compaction_start{reason} / compaction_end{status,...}
			// 共用 SSE 类型 `compaction`；以 status 有无区分 phase，供前端状态行起止收口。
			const d = (event.data ?? {}) as { status?: string; reason?: string };
			const phase = d.status ? 'end' : 'start';
			return ui('pi_compaction', { phase, status: d.status, reason: d.reason });
		}
		case "recovery": {
			// P2：调度恢复中（vendor retry_scheduled{recovery:true} 标记）。不走 default 的
			// `pi_` 前缀——前端按 type 分支消费，加前缀会被静默丢弃，状态行就退回
			// 「上游响应超时」，等于这条白接了（同 activity/waiting_user 的既有裁决）。
			return ui("recovery", {});
		}
		default:
			return ui(`pi_${event.type}`, event.data);
	}
}

/**
 * pi 运行失败分类（item 2：失败透传）。
 *
 * pi 的失败以两种形态到达 Nest：
 *  - 顶层 `error` 事件（data 含 message / stopReason）
 *  - `agent_end` 且 status==='error'（data.error / data.errorMessage / data.stopReason）
 *
 * 402 余额不足在会话 transcript 中记为
 * `stopReason:"error"`, `errorMessage:"402: {\"message\":\"Insufficient Balance …\"}"`，
 * 走 `agent_end` 分支。这里对多种字段形态做防御性提取，并按文案归类出
 * `kind`，供前端决定提示文案（余额不足 → dock 充值提醒卡片）。
 */
export type PiRunErrorKind =
	| 'insufficient_balance'
	| 'rate_limit'
	| 'auth'
	| 'context_overflow'
	| 'unknown'

export interface PiRunErrorInfo {
	kind: PiRunErrorKind
	message: string
	retry_hint?: string
}

function readErrorText(d: Record<string, unknown>): string {
	const candidates: unknown[] = [
		d.errorMessage,
		d.message,
		(d.error as Record<string, unknown> | undefined)?.message,
		typeof d.error === 'string' ? d.error : undefined,
		d.stopReason,
	]
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim()) return c.trim()
	}
	return ''
}

export function classifyPiRunError(event: PiRuntimeEvent): PiRunErrorInfo | null {
	if (event.type !== 'error' && event.type !== 'agent_end') return null
	const d = (event.data ?? {}) as Record<string, unknown>
	const status = typeof d.status === 'string' ? d.status : ''
	const errText = readErrorText(d)
	const isErrTurn =
		event.type === 'error' ||
		status === 'error' ||
		errText !== '' ||
		d.error != null
	if (!isErrTurn) return null

	const text = (errText || status || 'unknown error').toString()
	const lower = text.toLowerCase()

	let kind: PiRunErrorKind = 'unknown'
	if (lower.includes('insufficient') || lower.includes('402') || lower.includes('balance')) {
		kind = 'insufficient_balance'
	} else if (lower.includes('429') || lower.includes('rate') || lower.includes('too many requests')) {
		kind = 'rate_limit'
	} else if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key') || lower.includes('invalid key')) {
		kind = 'auth'
	} else if (
		lower.includes('context length') ||
		(lower.includes('token') && lower.includes('exceed')) ||
		lower.includes('maximum context')
	) {
		kind = 'context_overflow'
	}

	let retry_hint: string | undefined
	if (kind === 'insufficient_balance') {
		retry_hint = '请到设置页为当前模型渠道充值，或切换其他有余额的渠道后重试。'
	} else if (kind === 'rate_limit') {
		retry_hint = '模型渠道限流，请稍后重试或切换渠道。'
	} else if (kind === 'context_overflow') {
		retry_hint = '本轮上下文超出模型窗口，请开启新对话或精简素材后重试。'
	}

	return { kind, message: text.slice(0, 400), retry_hint }
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
	/** ask_user 工具产出；仅 type="ask_user" 时有。阻塞模式下 = toolCallId，前端 POST /answers 的提交依据（B-6）。 */
	callId?: string;
	nodeId?: string;
	nodeIds?: string[];
	/** ask_user 工具产出；仅 type="ask_user" 时有。extractCanvasCommands filter 不变（只校验 type:string），questions 透传。 */
	questions?: AskUserQuestion[];
	/** arrange_nodes 工具产出；仅 type="arrange_nodes" 时有。extractCanvasCommands filter 不变（只校验 type:string），新字段透传。 */
	mode?: "grid" | "along_edges";
	gap?: number;
	edges?: ArrangeEdge[];
	/** render_canvas_view 工具产出；仅 type="svg_card" 时有。extractCanvasCommands filter 不变（只校验 type:string），新字段透传。 */
	svg?: string;
	title?: string;
	annotations?: Array<{ nodeId: string; text: string; severity: "info" | "warn" }>;
	/**
	 * D4 §4.5 呈现分工：本轮该呈现哪一种（双写的两条 command 带同一个值）。
	 *
	 * ⚠️ **这里只是声明，`extractCanvasCommands` 不需要改**：它的 filter 只校验
	 * `type` 是字符串，其余字段原样透传（见上方 `ask_user`/`arrange_nodes` 字段的同款注释）。
	 * 声明它是为了让「字段真的能到前端」有编译期落点，而不是靠运行时碰巧。
	 *
	 * 🔴 反面教材：PR #321 把判据写进了 `result.content[0].text`—— 那是给模型读的文本，
	 * 本文件**一条命令都不提取**，前端与落库都拿不到，测试却全绿。
	 */
	preferredKind?: "svg_card" | "node_graph";
}

/**
 * UI_COMMAND 批次：从 tool_execution_end 的 result.details.canvasCommands 或
 * tool_execution_update 的 partialResult.details.canvasCommands 提取 UI 命令
 * （派生 canvas_command 事件，同名同形态于老链路 runs.py:1220）。
 * ⚠️ 事件名是 canvas_command 不是 canvas_action——后者走 CanvasActionSchema，
 * 只认 add_node 等 6 种画布数据动作，focus/undo 会被前端静默丢弃。
 * 仅本地 UI_COMMAND 工具的 details 含 canvasCommands 键；Nest 转发工具的
 * details 是 {ok,data} 形态，天然不命中，无需按工具名白名单。
 * B-6：阻塞 ask_user 卡片经 onUpdate 全量快照下发（tool_execution_update），
 * end 事件里只有答案文本（无卡片）→ 必须从 update 提取，否则阻塞卡全程不可见；
 * 快照缺 callId 时回落事件上的 toolCallId（前端 POST /answers 的提交依据）。
 */
export function extractCanvasCommands(event: PiRuntimeEvent): PiCanvasCommand[] {
	if (event.type === "tool_execution_update") {
		const d = event.data as {
			toolCallId?: string;
			partialResult?: { details?: { canvasCommands?: unknown } };
		};
		const cmds = d.partialResult?.details?.canvasCommands;
		if (!Array.isArray(cmds)) return [];
		return cmds
			.filter(
				(c): c is PiCanvasCommand =>
					!!c && typeof c === "object" && typeof (c as { type?: unknown }).type === "string",
			)
			.map((c) =>
				c.type === "ask_user" && !c.callId && d.toolCallId ? { ...c, callId: d.toolCallId } : c,
			);
	}
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

/**
 * C1：todo_write 的 details.todo.diff → task_list/task_update 事件（spec 2026-10-09-task-tool-design.md §3.3）。
 * 复刻 extractCanvasActions 的透传读取路径（tool_execution_end → result.details，生产先例）。
 * 词汇映射默认 V-B（completed→done，其余→running）：web applyTaskEvent 对未知 status 原样赋值，
 * TERMINAL_STATUSES 不识别 completed，三态透传会破坏卡片完成判定（Task 3 Step 1 实测裁决）。
 * task_list items 的 status/activeForm 字段为自有协议扩展，现版前端忽略（items 状态硬编码 pending），
 * 前端消费属后续 UI 迭代（payload 先行，向后兼容）。
 */
const TaskDiffSchema = z.object({
	todo: z
		.object({
			snapshot: z
				.array(
					z.object({
						id: z.string(),
						content: z.string(),
						status: z.string(),
						activeForm: z.string().optional(),
					}),
				)
				.optional(),
			diff: z.object({
				list: z
					.array(
						z.object({
							id: z.string(),
							content: z.string(),
							status: z.string(),
							activeForm: z.string().optional(),
						}),
					)
					.optional(),
				updates: z.array(z.object({ id: z.string(), status: z.string() })).default([]),
			}),
		})
		.optional(),
});

export interface TaskWireEvent {
	type: "task_list" | "task_update";
	data: unknown;
}

function mapStatus(s: string): string {
	// V-B′（2026-10-09 前端消费迭代）：completed→done / in_progress→running / 其余→pending——
	// 前端 agentTaskProgress.applyTaskEvent 已消费 payload status（V-B 时代的 task_list 硬编码
	// pending 已移除），三态可区分使卡片能渲染"未开始 vs 进行中"。
	// V-A 切换点：直接返回 s（须前端 TERMINAL_STATUSES 同步认识 completed，否则坏完成判定）。
	return s === "completed" ? "done" : s === "in_progress" ? "running" : "pending";
}

export function extractTaskEvents(event: PiRuntimeEvent): TaskWireEvent[] {
	if (event.type !== "tool_execution_end") return [];
	const d = event.data as { isError?: boolean; result?: { details?: unknown } };
	if (d.isError) return [];
	const parsed = TaskDiffSchema.safeParse(d.result?.details);
	if (!parsed.success || !parsed.data.todo) return [];
	const { snapshot } = parsed.data.todo;
	const { list, updates } = parsed.data.todo.diff;
	if (list) {
		return [
			{
				type: "task_list",
				data: {
					items: list.map((i) => ({
						id: i.id,
						title: i.content,
						status: mapStatus(i.status),
						...(i.activeForm ? { activeForm: i.activeForm } : {}),
					})),
				},
			},
		];
	}
	if (updates.length === 0) return [];
	// updates 路径：从同载荷 snapshot 反查命中项，附 title/activeForm（spec §3.3 呈现链对增量更新成立）；
	// 未命中（防御，snapshot 缺失或 id 漂移）退化为 {id,status}。
	const byId = new Map((snapshot ?? []).map((s) => [s.id, s]));
	return updates.map((u) => {
		const hit = byId.get(u.id);
		return {
			type: "task_update" as const,
			data: {
				id: u.id,
				status: mapStatus(u.status),
				...(hit ? { title: hit.content } : {}),
				...(hit?.activeForm ? { activeForm: hit.activeForm } : {}),
			},
		};
	});
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
 * 老 UI 契约的 `thinking` 事件（start→running，end→done+全文）。
 *
 * 2026-10-14 Q1（对齐 WorkBuddy「推理中流式显性展示、结束后收起」）：delta 阶段按
 * `streamIntervalMs` 节流透传**累积快照**（status=running + summary + transient:true）——
 * 前端 running 块实时长出思考文本；transient 事件只走 SSE、不落库（防 executionEvents
 * 膨胀，重放也不需要中间快照）。done 仍发整段全文（权威收口，前端防追加重见 turnTimeline）。
 */
export function createThinkingAccumulator(
	limit = 2000,
	streamIntervalMs = 400,
): {
	feed(event: PiRuntimeEvent): UiEvent | null;
} {
	let buffer = "";
	let lastStreamTs = 0;
	return {
		feed(event: PiRuntimeEvent): UiEvent | null {
			const t = extractThinking(event);
			if (!t) return null;
			if (t.phase === "start") return { type: "thinking", data: { status: "running" }, seq: event.seq };
			if (t.phase === "delta" && t.text) {
				buffer += t.text;
				const ts = typeof event.ts === "number" && event.ts > 0 ? event.ts : Date.now();
				if (ts - lastStreamTs >= streamIntervalMs) {
					lastStreamTs = ts;
					return {
						type: "thinking",
						data: { status: "running", summary: buffer.slice(0, limit), transient: true },
						seq: event.seq,
					};
				}
				return null;
			}
		const summary = buffer.slice(0, limit);
		// 2026-10-14（生产实证）：end 后必须清空 buffer —— 否则下一段 thinking 的 done
		// 会带上此前**所有**段的全文（截图复盘：4 段 summary len 220/758/822/963 且 head
		// 完全相同），前端时间线每段都渲染从头开始的转写 ⇒ 大面积重复。
		buffer = "";
		return { type: "thinking", data: { status: "done", summary: summary || undefined }, seq: event.seq };
		},
	};
}

/**
 * 正文分段落库器（2026-10-14）：把流式 text_delta 按「段」折叠为落库 `text` 事件。
 *
 * 根因背景：text_delta 此前**从不进 executionEvents**，正文只存为整条 message.content ——
 * 历史重放时前端只能把整段正文 unshift 到时间线**最前面**，而产出正文的思考/工具行
 * 按事件序排在后面 ⇒ 时序倒挂（生产实证：「用户选择了…」跑到 ask_user 行上面；
 * 收尾叙述跑到产出它的思考上面）。
 *
 * 段的定义 = 两次非文本事件之间的 delta 连续流。调用方在**任何非文本 trace 事件落库前**
 * 调 `flush()`（含 message_end / 回合收尾），保证 text 事件 seq 恒小于紧随其后的边界事件。
 */
export function createTextSegmentPersister(push: (type: string, data: unknown) => void): {
	add(delta: string): void;
	flush(): void;
} {
	let buffer = "";
	return {
		add(delta: string) {
			if (delta) buffer += delta;
		},
		flush() {
			if (!buffer) return;
			const text = buffer;
			buffer = "";
			push("text", { text });
		},
	};
}

export interface TurnUsage {
	/** 纯 input（P2 T5 语义收窄：不再折叠 cacheRead/cacheWrite）。 */
	inputTokens: number;
	/** P2 T5（token 精确计费）：cache 三列分开保留，旧事件无 cache 字段 → 缺省 0。 */
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	/** 本回合 cost 总额（USD，vendor calculateCost 产物四字段求和）。> 0 才携带——
	 *  费率未配置时上游给 0，不带字段以与「未配费率」区分（审计 P0-③）。 */
	cost?: number;
}

function extractUsageDelta(event: PiRuntimeEvent): TurnUsage | null {
	if (event.type !== "message_end") return null;
	const usage = (event.data as {
		message?: {
			usage?: {
				input?: unknown;
				output?: unknown;
				cacheRead?: unknown;
				cacheWrite?: unknown;
				cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
			};
		};
	}).message?.usage;
	if (!usage || typeof usage !== "object") return null;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	// P2 T5（token 精确计费）：vendor 原始 tokens 四列直取（vendor types.ts usage），
	// 不再折叠 cacheRead/cacheWrite 进 input——双比率结算（Task 6）需要分项真值。
	const inputTokens = num(usage.input);
	const c = usage.cost;
	const cost =
		c && typeof c === "object"
			? num(c.input) + num(c.output) + num(c.cacheRead) + num(c.cacheWrite)
			: undefined;
	return {
		inputTokens,
		cacheReadTokens: num(usage.cacheRead),
		cacheWriteTokens: num(usage.cacheWrite),
		outputTokens: num(usage.output),
		...(cost !== undefined ? { cost } : {}),
	};
}

/** P1 状态行：message_end.usage 逐条累积，agent_end 前折叠为一次 turn_usage 事件。
 * 仅当本回合出现过至少一条带 usage 的 message_end 才发（seenUsage 门）——区分
 * 「上游没回 usage」（不显示 tokens 段）与「usage 真为 0」（显示 0），杜绝误导。
 * cost 仅在累计 > 0 时附带（未配费率 = 0 = 不带字段，向后兼容）。
 *
 * Q2（2026-10-14 积分预估展示，spec §6.7 数据链路第 1 步）：可选 `estimateCredits`
 * 回调（服务端按 MarginPolicy + usage.cost 折算，纯展示预估）——
 *  - 每条 message_end 折叠出 delta 后**即时 emit 一次 `usage_delta`**（transient，
 *    只走 SSE 供状态行「预估 -N积分」，不落库）；
 *  - `turn_usage` 增量携带 `estimatedCredits`（落库，回合摘要积分化用）。
 */
export function createUsageAccumulator(estimateCredits?: (totals: TurnUsage) => number | null): {
	feed(event: PiRuntimeEvent): UiEvent | null;
} {
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let output = 0;
	let cost: number | undefined;
	let seenUsage = false;
	const creditsOf = (): number | null => {
		if (!estimateCredits) return null;
		const totals: TurnUsage = {
			inputTokens: input,
			cacheReadTokens: cacheRead,
			cacheWriteTokens: cacheWrite,
			outputTokens: output,
			...(cost !== undefined ? { cost } : {}),
		};
		const v = estimateCredits(totals);
		return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
	};
	return {
		feed(event: PiRuntimeEvent): UiEvent | null {
			const delta = extractUsageDelta(event);
			if (delta) {
				seenUsage = true;
				input += delta.inputTokens;
				cacheRead += delta.cacheReadTokens;
				cacheWrite += delta.cacheWriteTokens;
				output += delta.outputTokens;
				if (delta.cost !== undefined) {
					cost = (cost ?? 0) + delta.cost;
				}
				// Q2：实时预估（running 状态行）。estimateCredits 缺席/不可算（cost=0）时不发——
				// 状态行退回「无预估」形态，绝不显示 0 积分假象。
				const est = creditsOf();
				if (est !== null) {
					return {
						type: "usage_delta",
						data: {
							inputTokens: input,
							cacheReadTokens: cacheRead,
							cacheWriteTokens: cacheWrite,
							outputTokens: output,
							estimatedCredits: est,
							transient: true,
						},
						seq: event.seq,
					};
				}
				return null;
			}
			if (event.type === "agent_end") {
				if (!seenUsage) return null;
				const est = creditsOf();
				return {
					type: "turn_usage",
					data: {
						inputTokens: input,
						cacheReadTokens: cacheRead,
						cacheWriteTokens: cacheWrite,
						outputTokens: output,
						...(cost && cost > 0 ? { cost } : {}),
						...(est !== null ? { estimatedCredits: est } : {}),
					},
					seq: event.seq,
				};
			}
			return null;
		},
	};
}
