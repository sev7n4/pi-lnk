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
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	AgentHarness,
	type AgentHarnessTool,
	type Context,
	type Session,
	type ThinkingLevel,
	BACKGROUND_CONTEXT,
	JsonlSessionRepo,
	withCancel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { assembleModel, type SessionLlmOverride } from "./model-assembly.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
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
	/** create 时确定的静态段（规则 + skills index），会话期内不再变更。 */
	staticPrompt: string;
	/** 会话身份（BYOK provider 哈希），用于 create 时判定是否需重建。 */
	identity: LlmIdentity;
	/** 会话归属用户；resume 时不一致 → 409 fail-closed。 */
	userId?: string;
	/** 每轮易变上下文（spec §5.3 T 层）。 */
	turn: TurnContext;
	/** 最近一次活动时间，TTL 的唯一数据源。 */
	lastActivityAt: number;
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

/** 每轮易变上下文（spec §5.3 T 层）：由 Nest 随 prompt 携带，不进对话历史。 */
export interface TurnContext {
	dynamicBlocks?: string[];
	attachments?: SidebarAttachment[];
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
}

/** 会话身份：BYOK 时 provider 为 `byok-<12hex>`（providerRef 哈希），平台时为 `agnes`。 */
export interface LlmIdentity {
	provider: string;
	model: string;
}

/** create 的三态：新建 / 复用（内存或磁盘）/ 因身份变更重建。 */
export type CreateStatus = "created" | "resumed" | "rebuilt";

export interface CreateOptions {
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
}

export interface CreateResult {
	provider: string;
	model: string;
	status: CreateStatus;
	/** 仅 status=resumed 时存在：复用来源（内存快速路径 vs 磁盘 repo.open）。 */
	resumedFrom?: "memory" | "disk";
}

const SESSION_KEY_INVALID = /[^A-Za-z0-9._-]/g;

/**
 * threadKey → 磁盘安全且可寻回的会话键（spec §4 键 sanitize 判据）。
 * `:`（threadId 的规范分隔符）等非法字符替换为 `_`，再追加原文 sha256 前 8 位保证无碰撞；
 * 非幂等——调用方（路由入口）只应用一次。
 */
export function toSessionKey(threadKey: string): string {
	const trimmed = threadKey.trim();
	if (!trimmed) throw new Error("toSessionKey requires a non-empty threadKey");
	const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
	return `${trimmed.replace(SESSION_KEY_INVALID, "_")}-${digest}`;
}

/** 静态段在前、动态段尾部追加（spec §4 动态上下文判据：稳定前缀不被易变内容推到后面）。 */
export function composeSystemPrompt(staticPart: string, dynamicBlocks: readonly string[]): string {
	const blocks = dynamicBlocks.map((b) => b.trim()).filter(Boolean);
	if (blocks.length === 0) return staticPart;
	if (!staticPart) return blocks.join("\n\n");
	return `${staticPart}\n\n${blocks.join("\n\n")}`;
}

export function isSameLlmIdentity(a: LlmIdentity, b: LlmIdentity): boolean {
	return a.provider === b.provider && a.model === b.model;
}

function sameStringArray(a?: readonly string[], b?: readonly string[]): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((v, i) => v === right[i]);
}

function sameAttachments(a?: readonly SidebarAttachment[], b?: readonly SidebarAttachment[]): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return (
		left.length === right.length &&
		left.every(
			(v, i) =>
				(v.url ?? "") === (right[i]?.url ?? "") &&
				(v.text ?? "") === (right[i]?.text ?? "") &&
				(v.mediaType ?? "") === (right[i]?.mediaType ?? ""),
		)
	);
}

/** 判断 turnContext 是否真的变了（避免每轮无谓替换导致 systemPrompt 缓存抖动）。 */
export function isTurnContextEqual(a: TurnContext, b: TurnContext): boolean {
	return (
		sameStringArray(a.dynamicBlocks, b.dynamicBlocks) &&
		sameStringArray(a.mentionedKeys, b.mentionedKeys) &&
		sameStringArray(a.refOrder, b.refOrder) &&
		(a.focusNodeId ?? "") === (b.focusNodeId ?? "") &&
		sameAttachments(a.attachments, b.attachments)
	);
}

/** 思考默认档位：vendored pi harness 默认 off（模型不产出 thinking_delta，前端「思考」步骤恒空）。
 * 会话级默认 medium（P1 前端开关落地前的过渡值）；ops 可用 env PI_RUNTIME_THINKING_LEVEL=off 快速关闭（helm --set env.* 后 rollout restart）。 */
export const DEFAULT_THINKING_LEVEL = (process.env.PI_RUNTIME_THINKING_LEVEL ?? "medium") as ThinkingLevel;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 会话级 thinking 档位：Nest 显式传入且合法时覆盖 env 默认。
 * 注意：harness 的 thinkingLevel 仅 create 时可设，prompt 阶段不可改——多轮同键换档
 * 由 Nest 走「身份变更」路径重建会话（spec §5.5 换档兜底）。 */
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
		private readonly config: RuntimeConfig = loadRuntimeConfig(process.env),
	) {}

	/** threadKey（Nest 的 threadId || sessionId）→ 是否已有内存驻留会话。 */
	hasKey(threadKey: string): boolean {
		return this.sessions.has(toSessionKey(threadKey));
	}

	/** 内存驻留会话键集合（TTL / LRU 豁免的唯一数据源）。 */
	activeKeys(): Set<string> {
		return new Set(this.sessions.keys());
	}

	count(): number {
		return this.sessions.size;
	}

	listSkills(): Array<{ name: string; description: string }> {
		return (this.skills?.entries ?? []).map((e) => ({ name: e.name, description: e.description }));
	}

	/**
	 * 幂等 upsert（spec §5.4）：
	 *   内存命中且身份一致 → resumed（不重置历史、不重设静态段）
	 *   内存命中但身份变更 → rebuilt（关闭并删目录后按新身份重建）
	 *   仅磁盘命中         → repo.open + harness.create（vendor 自动 restoreSession）→ resumed
	 *   都没有             → created
	 * userId 不一致一律 ConflictError（fail-closed，不返回任何会话内容）。
	 */
	async create(
		threadKey: string,
		opts: CreateOptions = {},
	): Promise<CreateResult> {
		const key = toSessionKey(threadKey);
		const { models, model, providerId } = this.modelFactory(opts.llm);
		const identity: LlmIdentity = { provider: providerId, model: model.id };

		const existing = this.sessions.get(key);
		if (existing) {
			if (existing.userId && existing.userId !== opts.userId) throw new ConflictError(key);
			if (!isSameLlmIdentity(existing.identity, identity)) {
				await this.destroy(key);
				const created = await this.build(key, opts, models, model, identity);
				return { ...created, status: "rebuilt" };
			}
			existing.lastActivityAt = Date.now();
			return { provider: existing.identity.provider, model: existing.identity.model, status: "resumed", resumedFrom: "memory" };
		}

		const cwd = opts.workingDir ?? join(this.config.dataRoot, key);
		const env = new NodeExecutionEnv({ cwd });
		const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
		const opened = await this.openExisting(repo, cwd);
		if (opened) {
			const built = await this.build(key, opts, models, model, identity, { env, repo, session: opened });
			return { ...built, status: "resumed", resumedFrom: "disk" };
		}
		const created = await this.build(key, opts, models, model, identity, { env, repo });
		return { ...created, status: "created" };
	}

	/** 磁盘上存在可恢复会话时返回它（repo.list 按 createdAt 降序，取最新一条）。 */
	private async openExisting(repo: JsonlSessionRepo, cwd: string): Promise<Session | undefined> {
		const list = await repo.list({ cwd }, this.context).catch(() => []);
		const newest = list[0];
		if (!newest) return undefined;
		return repo.open(newest, this.context);
	}

	/** 建 harness（新建或恢复）并登记 entry；静态段在此定型。 */
	private async build(
		key: string,
		opts: CreateOptions,
		models: ReturnType<typeof assembleModel>["models"],
		model: ReturnType<typeof assembleModel>["model"],
		identity: LlmIdentity,
		existingFs?: { env: NodeExecutionEnv; repo: JsonlSessionRepo; session?: Session },
	): Promise<{ provider: string; model: string }> {
		const cwd = opts.workingDir ?? join(this.config.dataRoot, key);
		await mkdir(cwd, { recursive: true });
		const env = existingFs?.env ?? new NodeExecutionEnv({ cwd });
		const repo = existingFs?.repo ?? new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
		const session = existingFs?.session ?? (await repo.create({ cwd }, this.context));

		const entry: SessionEntry = {
			id: key,
			harness: undefined as never,
			env,
			repo,
			listeners: new Set(),
			buffer: [],
			unsubscribes: [],
			prompting: false,
			nextSeq: 0,
			staticPrompt: this.composeSystemPrompt(opts.systemPrompt),
			identity,
			userId: opts.userId,
			turn: {
				attachments: opts.attachments,
				mentionedKeys: opts.mentionedKeys,
				refOrder: opts.refOrder,
				focusNodeId: opts.focusNodeId,
			},
			lastActivityAt: Date.now(),
		};

		const { harness } = await this.harnessFactory<LnkpiToolContext>(
			{
				session,
				models,
				model,
				tools: [...this.tools, ...(this.skills?.tools ?? [])],
				// 函数形态（spec §5.3/§5.4）：harness 在每次 LLM 调用前求值，读到的是最新 turn。
				toolContext: () => ({ sessionId: key, userId: entry.userId, ...entry.turn }),
				systemPrompt: () => composeSystemPrompt(entry.staticPrompt, entry.turn.dynamicBlocks ?? []),
				thinkingLevel: resolveThinkingLevel(opts.thinkingLevel),
				compaction: this.config.compaction,
			},
			this.context,
		);
		entry.harness = harness;

		this.hooks?.onSessionCreated?.(key, harness);

		for (const [harnessType, sseType] of EVENT_MAP) {
			entry.unsubscribes.push(
				harness.events.on(harnessType as never, (evt: { lane?: string }) => {
					this.dispatch(entry, {
						type: sseType,
						lane: evt.lane,
						ts: Date.now(),
						data: evt,
					});
				}),
			);
		}

		this.sessions.set(key, entry);
		return { provider: identity.provider, model: identity.model };
	}

	/** 关闭并删除：内存句柄 + 磁盘目录（身份变更 / 显式删除共用）。 */
	private async destroy(key: string): Promise<void> {
		const entry = this.sessions.get(key);
		if (!entry) return;
		for (const unsub of entry.unsubscribes) unsub();
		entry.listeners.clear();
		this.sessions.delete(key);
		await entry.harness.close(this.context).catch(() => {});
		await entry.repo.close(this.context).catch(() => {});
		await entry.env.cleanup(this.context).catch(() => {});
		await rm(join(this.config.dataRoot, key), { recursive: true, force: true }).catch(() => {});
	}

	subscribe(threadKey: string, listener: EventListener, afterSeq = -1): NormalizedEvent[] {
		const entry = this.require(threadKey);
		entry.listeners.add(listener);
		// 增量重放（P0-③）：只回放 seq > afterSeq 的缓冲；afterSeq 早于 buffer 最旧条目时
		// best-effort 返回全部 buffered（会话单轮生命周期下 buffer 溢出概率极低，不做全量重建）
		return entry.buffer.filter((e) => e.seq > afterSeq);
	}

	unsubscribe(threadKey: string, listener: EventListener): void {
		this.sessions.get(toSessionKey(threadKey))?.listeners.delete(listener);
	}

	/** 触发一次 prompt。不 await 完成——事件经 events 总线流出；run 结束由 agent_end 表达。 */
	async prompt(
		threadKey: string,
		text: string,
		laneName = "main",
		opts?: { forceSkills?: string[] },
	): Promise<{ accepted: boolean }> {
		const entry = this.require(threadKey);
		const effectiveText = withForcedSkills(text, opts?.forceSkills, (name) =>
			this.skills?.loadBody(name),
		);
		this.hooks?.onPrompt?.(entry.id);
		entry.lastActivityAt = Date.now();
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
					console.log(`[pi-runtime] run aborted by user: ${entry.id}`);
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
	abort(threadKey: string): boolean {
		const entry = this.sessions.get(toSessionKey(threadKey));
		if (!entry?.cancelRun) return false;
		entry.userAborted = true;
		entry.cancelRun("user_cancel");
		entry.cancelRun = undefined;
		return true;
	}

	async remove(threadKey: string): Promise<boolean> {
		const key = toSessionKey(threadKey);
		if (!this.sessions.has(key)) return false;
		await this.destroy(key);
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

	private require(threadKey: string): SessionEntry {
		const entry = this.sessions.get(toSessionKey(threadKey));
		if (!entry) throw new NotFoundError(threadKey);
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
