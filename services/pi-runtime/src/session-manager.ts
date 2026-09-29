/**
 * 会话管理（spec §6.2.0 B8 pi-runtime 侧）
 *
 * 职责：把 vendored pi 的 AgentHarness 会话生命周期封装为可被 Nest RPC 的形态。
 * 所有 API 均基于 PoC（packages/pi-poc 5/5 PASS）实测过的调用模式。
 *
 * 事件归一（实测校准，对应 spec §8.5.1 命名）：
 *   pi harness 层事件名与底层 Agent.subscribe() 的 AgentEvent 有命名差：
 *     run_start      → agent_start
 *     run_end        → agent_end
 *     tool_start     → tool_execution_start
 *     tool_update    → tool_execution_update
 *     tool_end       → tool_execution_end
 *   message_* / turn_* 同名直传；fault / handler_error 归一为 error（spec 称 pi
 *   无独立 error 事件是指 AgentEvent 层——harness 层有，必须转发否则丢错）。
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	AgentHarness,
	type AgentHarnessTool,
	type Context,
	type ThinkingLevel,
	BACKGROUND_CONTEXT,
	JsonlSessionRepo,
	withCancel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { assembleModel, type SessionLlmOverride } from "./model-assembly.js";
import { stripImageBlocks } from "./sse-sanitize.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { LnkpiToolContext, SidebarAttachment } from "./tools/types.js";

export type NormalizedEventType =
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

export interface NormalizedEvent {
	type: NormalizedEventType;
	lane?: string;
	ts: number;
	/** 会话内单调递增（从 0 起），SSE id 帧与客户端增量重连的 offset（P0-③）。 */
	seq: number;
	data: unknown;
}

export type EventListener = (event: NormalizedEvent) => void;

const DATA_ROOT = process.env.PI_RUNTIME_DATA_DIR ?? join(process.cwd(), ".pi-runtime-data");

/** harness 事件类型 → SSE 归一事件类型（同名直传的映射也显式列出，便于审计）。 */
const EVENT_MAP: ReadonlyArray<readonly [string, NormalizedEventType]> = [
	["run_start", "agent_start"],
	["run_end", "agent_end"],
	["turn_start", "turn_start"],
	["turn_end", "turn_end"],
	["message_start", "message_start"],
	["message_update", "message_update"],
	["message_end", "message_end"],
	["tool_start", "tool_execution_start"],
	["tool_update", "tool_execution_update"],
	["tool_end", "tool_execution_end"],
	["fault", "error"],
	["handler_error", "error"],
];

/** 可携带 tool result（含 image block）的 harness 事件：SSE/缓冲副本必须剥离图数据。 */
const TOOL_RESULT_EVENT_TYPES = new Set(["tool_end", "message_start", "message_end", "turn_end"]);

interface SessionEntry {
	id: string;
	harness: AgentHarness<LnkpiToolContext>;
	env: NodeExecutionEnv;
	repo: JsonlSessionRepo;
	listeners: Set<EventListener>;
	buffer: NormalizedEvent[];
	unsubscribes: Array<() => void>;
	prompting: boolean;
	/** 当前 run 的取消函数（withCancel 产出）；run 结束后清空。用户点「停止」时调用。 */
	cancelRun?: (reason?: unknown) => void;
	/** 本轮 run 是否被用户主动取消（用于抑制取消引发的 error 事件，避免重连补发假警报）。 */
	userAborted?: boolean;
	/** 下一个待分配的事件 seq（会话内单调递增，P0-③）。 */
	nextSeq: number;
}

const BUFFER_LIMIT = 500;

export type HarnessFactory = typeof AgentHarness.create;

/**
 * B-5：会话级生命周期钩子。onSessionCreated 在 harness 创建后（注册事件订阅之前）
 * 调用——HITL Gate 用它注册 per-session before_tool/after_tool hook（闭包捕获 sessionId）；
 * onPrompt 在每次用户 prompt 进入时调用——Gate 的 turn 计数数据源。
 */
export interface SessionHooks {
	onSessionCreated?(sessionId: string, harness: AgentHarness<LnkpiToolContext>): void;
	onPrompt?(sessionId: string): void;
}

/** 可观测性专项 ④：显性 skill 调用——把 skill 正文作为指令前缀注入 prompt 文本。 */
export function withForcedSkills(
	text: string,
	forceSkills: string[] | undefined,
	resolveBody: (name: string) => string | undefined,
): string {
	if (!forceSkills || forceSkills.length === 0) return text;
	const parts: string[] = [];
	for (const name of forceSkills) {
		const body = resolveBody(name);
		parts.push(
			body
				? `[用户显式调用 skill: ${name}]\n请严格按以下指导执行：\n\n${body}`
				: `[用户显式调用了未安装的 skill: ${name}；先告知用户该技能不存在，再按其原意尽力完成]`,
		);
	}
	return `${parts.join("\n\n")}\n\n---\n用户请求：${text}`;
}

/** 思考默认档位：vendored pi harness 默认 off（模型不产出 thinking_delta，前端「思考」步骤恒空）。
 * 会话级默认 medium（P1 前端开关落地前的过渡值）；ops 可用 env PI_RUNTIME_THINKING_LEVEL=off 快速关闭（helm --set env.* 后 rollout restart）。 */
export const DEFAULT_THINKING_LEVEL = (process.env.PI_RUNTIME_THINKING_LEVEL ?? "medium") as ThinkingLevel;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 会话级 thinking 档位：Nest 显式传入且合法时覆盖 env 默认。
 * 注意：harness 的 thinkingLevel 仅 create 时可设，prompt 阶段不可改——多轮同 sessionId
 * 换档依赖 createSessionReplacingStale 重建会话（Nest 现有机制）。 */
export function resolveThinkingLevel(level?: string): ThinkingLevel {
	if (level && THINKING_LEVELS.has(level)) return level as ThinkingLevel;
	return DEFAULT_THINKING_LEVEL;
}

export class SessionManager {
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly context: Context = BACKGROUND_CONTEXT;

	constructor(
		private readonly tools: AgentHarnessTool<LnkpiToolContext>[] = [],
		private readonly systemPromptDefault = process.env.PI_RUNTIME_SYSTEM_PROMPT ?? "",
		private readonly modelFactory: typeof assembleModel = assembleModel,
		private readonly harnessFactory: HarnessFactory = AgentHarness.create,
		private readonly hooks?: SessionHooks,
		private readonly skills?: SkillRegistry,
	) {}

	has(id: string): boolean {
		return this.sessions.has(id);
	}

	count(): number {
		return this.sessions.size;
	}

	listSkills(): Array<{ name: string; description: string }> {
		return (this.skills?.entries ?? []).map((e) => ({ name: e.name, description: e.description }));
	}

	async create(
		id: string,
		opts: {
			systemPrompt?: string;
			workingDir?: string;
			userId?: string;
			attachments?: SidebarAttachment[];
			mentionedKeys?: string[];
			refOrder?: string[];
			focusNodeId?: string;
			thinkingLevel?: string;
			/** K-1：BYOK 会话级模型覆盖（仅来自 Nest create 注入，本进程不从其它来源读取）。 */
			llm?: SessionLlmOverride;
		} = {},
	): Promise<{ provider: string; model: string }> {
		if (this.sessions.has(id)) throw new ConflictError(id);
		const { models, model, providerId } = this.modelFactory(opts.llm);

		const cwd = opts.workingDir ?? join(DATA_ROOT, id);
		await mkdir(cwd, { recursive: true });
		const env = new NodeExecutionEnv({ cwd });
		const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
		const session = await repo.create({ cwd }, this.context);

		const { harness } = await this.harnessFactory<LnkpiToolContext>(
			{
				session,
				models,
				model,
				tools: [...this.tools, ...(this.skills?.tools ?? [])],
				toolContext: {
					sessionId: id,
					userId: opts.userId,
					attachments: opts.attachments,
					mentionedKeys: opts.mentionedKeys,
					refOrder: opts.refOrder,
					focusNodeId: opts.focusNodeId,
				},
				systemPrompt: this.composeSystemPrompt(opts.systemPrompt),
				thinkingLevel: resolveThinkingLevel(opts.thinkingLevel),
			},
			this.context,
		);

		const entry: SessionEntry = {
			id,
			harness,
			env,
			repo,
			listeners: new Set(),
			buffer: [],
			unsubscribes: [],
			prompting: false,
			nextSeq: 0,
		};

		this.hooks?.onSessionCreated?.(id, harness);

		for (const [harnessType, sseType] of EVENT_MAP) {
			entry.unsubscribes.push(
				harness.events.on(harnessType as never, (evt: { lane?: string }) => {
					this.dispatch(entry, {
						type: sseType,
						lane: evt.lane,
						ts: Date.now(),
						// ⑦：图只进模型上下文，SSE/缓冲副本剥离（无图时原引用返回）
						data: TOOL_RESULT_EVENT_TYPES.has(harnessType) ? stripImageBlocks(evt) : evt,
					});
				}),
			);
		}

		this.sessions.set(id, entry);
		return { provider: providerId, model: model.id };
	}

	subscribe(id: string, listener: EventListener, afterSeq = -1): NormalizedEvent[] {
		const entry = this.require(id);
		entry.listeners.add(listener);
		// 增量重放（P0-③）：只回放 seq > afterSeq 的缓冲；afterSeq 早于 buffer 最旧条目时
		// best-effort 返回全部 buffered（会话单轮生命周期下 buffer 溢出概率极低，不做全量重建）
		return entry.buffer.filter((e) => e.seq > afterSeq);
	}

	unsubscribe(id: string, listener: EventListener): void {
		this.sessions.get(id)?.listeners.delete(listener);
	}

	/** 触发一次 prompt。不 await 完成——事件经 events 总线流出；run 结束由 agent_end 表达。 */
	async prompt(
		id: string,
		text: string,
		laneName = "main",
		opts?: { forceSkills?: string[] },
	): Promise<{ accepted: boolean }> {
		const entry = this.require(id);
		const effectiveText = withForcedSkills(text, opts?.forceSkills, (name) =>
			this.skills?.loadBody(name),
		);
		this.hooks?.onPrompt?.(id);
		// 每个 run 一个可取消的子 context：用户点「停止」时 abort 这一条链路。
		// vendored pi 的中断入口是 context（withCancel → { context, cancel }），
		// 不是 lane.prompt 的参数（其第二参是 images，传不了 signal）。
		const run = withCancel(this.context);
		entry.cancelRun = run.cancel;
		entry.userAborted = false;
		const lane = await entry.harness.lane(laneName, this.context);
		entry.prompting = true;
		void lane
			.prompt(effectiveText, undefined, run.context)
			.then((result) => {
				if (!result.ok) {
					this.dispatch(entry, {
						type: "error",
						lane: laneName,
						ts: Date.now(),
						data: { source: "prompt", message: String(result.error) },
					});
				}
			})
			.catch((err: unknown) => {
				// 用户主动取消：不派发 error（否则重连补发 buffer 时会显示「出错了」的假警报）
				if (entry.userAborted) {
					console.log(`[pi-runtime] run aborted by user: ${id}`);
					return;
				}
				this.dispatch(entry, {
					type: "error",
					lane: laneName,
					ts: Date.now(),
					data: { source: "prompt", message: err instanceof Error ? err.message : String(err) },
				});
			})
			.finally(() => {
				entry.prompting = false;
				entry.cancelRun = undefined;
				entry.userAborted = false;
			});
		return { accepted: true };
	}

	/**
	 * 中断该会话当前正在跑的 run（用户点「停止」）。
	 * 会话本身保留——用户可以接着发新消息；无活跃 run 时返回 false（前端按「已断开」提示）。
	 */
	abort(id: string): boolean {
		const entry = this.sessions.get(id);
		if (!entry?.cancelRun) return false;
		entry.userAborted = true;
		entry.cancelRun("user_cancel");
		entry.cancelRun = undefined;
		return true;
	}

	async remove(id: string): Promise<boolean> {
		const entry = this.sessions.get(id);
		if (!entry) return false;
		for (const unsub of entry.unsubscribes) unsub();
		entry.listeners.clear();
		this.sessions.delete(id);
		try {
			await entry.harness.close(this.context);
			await entry.repo.close(this.context);
			await entry.env.cleanup(this.context);
		} catch {
			// 清理失败不阻塞删除响应（会话目录留待 K8s PVC 生命周期回收）
		}
		await rm(join(DATA_ROOT, id), { recursive: true, force: true }).catch(() => {});
		return true;
	}

	/** seq 由本方法独占分配；调用方只提供无 seq 的事件骨架。 */
	private dispatch(entry: SessionEntry, event: Omit<NormalizedEvent, "seq">): void {
		const withSeq = { ...event, seq: entry.nextSeq++ };
		entry.buffer.push(withSeq);
		if (entry.buffer.length > BUFFER_LIMIT) entry.buffer.shift();
		for (const listener of entry.listeners) {
			try {
				listener(withSeq);
			} catch {
				// 单个订阅者异常不阻断其他订阅者（对齐 HarnessEventBus 的隔离语义）
			}
		}
	}

	private require(id: string): SessionEntry {
		const entry = this.sessions.get(id);
		if (!entry) throw new NotFoundError(id);
		return entry;
	}

	/** D-η'：base 为空回退默认 prompt；skills index 块常驻尾部（无 skills 时原样返回）。 */
	private composeSystemPrompt(base?: string): string {
		const prompt = base || this.systemPromptDefault;
		const index = this.skills?.indexBlock ?? "";
		if (!index) return prompt;
		return prompt ? `${prompt}\n\n${index}` : index;
	}
}

export class ConflictError extends Error {
	constructor(id: string) {
		super(`session exists: ${id}`);
	}
}

export class NotFoundError extends Error {
	constructor(id: string) {
		super(`session not found: ${id}`);
	}
}
