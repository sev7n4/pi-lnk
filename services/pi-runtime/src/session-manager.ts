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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { enforceRetention } from "./session-retention.js";
import type { SkillRegistry } from "./skills/registry.js";
import { stripImageBlocks } from "./sse-sanitize.js";
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
	| "compaction"
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
	// P0-①：上下文压缩（vendor 事件名实测为 compaction_start / compaction_end，载荷带 status）。
	// 两者都归一到 "compaction"，前端据此显示「正在压缩上下文」；成败计数只在 end 分支。
	["compaction_start", "compaction"],
	["compaction_end", "compaction"],
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
	/** create 时确定的静态段（规则 + skills index），会话期内不再变更。 */
	staticPrompt: string;
	/** 会话身份（BYOK provider 哈希），用于 create 时判定是否需重建。 */
	identity: LlmIdentity;
	/** 会话归属用户；resume 时不一致 → 409 fail-closed。 */
	userId?: string;
	/**
	 * 画布会话 id（与 pi 会话键**解耦**）：工具经 `toolContext.sessionId` 拿到的就是它。
	 *
	 * ⚠️ 本字段存在的原因：`id`（= `toSessionKey(threadKey)`）是 pi 侧的持久化键，
	 * 而 Nest 的 `/agent/internal/*` 拿 `sessionId` 去 `prisma.session.findUnique({id})`
	 * 查**画布**会话。二者混用会让全部画布工具 404（2026-09-29 hotfix 复盘）。
	 * 未提供时回落 `id`（见 `toolContext`），语义退化为旧行为而非崩溃。
	 */
	canvasSessionId?: string;
	/** 每轮易变上下文（spec §5.3 T 层）。 */
	turn: TurnContext;
	/** 当前思考档位（常驻会话下换档走 lane setter，不重建会话；spec §5.5）。 */
	thinkingLevel: ThinkingLevel;
	/** 最近一次活动时间，TTL 的唯一数据源。 */
	lastActivityAt: number;
}

const BUFFER_LIMIT = 500;

/** 默认（也是唯一）对话 lane 名；换档等 lane 级操作必须落在与 prompt 同一条 lane 上。 */
const MAIN_LANE = "main";

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

/**
 * TurnContext 写入归一（spec §5.4「整体覆盖」）：缺省字段一律归一为空值。
 * 复核 Important #1——若只在写入时做 `{ ...old, ...new }` 合并，Nest 在「本轮无附件 /
 * 无 @ 提及」时传 undefined，旧轮的侧栏附件/焦点节点会泄漏进本轮 toolContext（工具拿
 * 到用户已不再指涉的素材）。Nest 侧契约是「每轮发送完整 turnContext，缺省即清空」。
 */
export function normalizeTurnContext(turn: TurnContext): TurnContext {
	return {
		dynamicBlocks: turn.dynamicBlocks ?? [],
		attachments: turn.attachments ?? [],
		mentionedKeys: turn.mentionedKeys ?? [],
		refOrder: turn.refOrder ?? [],
		focusNodeId: turn.focusNodeId,
	};
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
	/**
	 * 画布会话 id（Nest 的 `/sessions` body 字段）。工具经 `toolContext.sessionId` 取用，
	 * 用于回打 Nest 的画布端点；**不要**与 pi 会话键 `key` 混用。
	 */
	canvasSessionId?: string;
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

/** 会话目录里的归属/身份落盘记录（磁盘路径 fail-closed 的数据源，复核 Important #4）。 */
export interface SessionMeta {
	/** null = 匿名会话（未带 userId 创建）。 */
	userId: string | null;
	provider: string;
	model: string;
}

const SESSION_META_FILE = "meta.json";

async function readSessionMeta(cwd: string): Promise<SessionMeta | undefined> {
	try {
		const raw = await readFile(join(cwd, SESSION_META_FILE), "utf8");
		const parsed = JSON.parse(raw) as Partial<SessionMeta>;
		if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") return undefined;
		return {
			userId: typeof parsed.userId === "string" ? parsed.userId : null,
			provider: parsed.provider,
			model: parsed.model,
		};
	} catch {
		return undefined; // 不存在 / 半截写入 / 权限问题：按「无记录」处理（调用方走不恢复路径）
	}
}

async function writeSessionMeta(cwd: string, meta: SessionMeta): Promise<void> {
	// 写盘失败不阻断建会话（历史照常落 JSONL）；代价仅是下次磁盘 resume 按「无记录」新建。
	// 这条 warn 是磁盘 resume 静默退化的唯一线索，不能吞。
	await writeFile(join(cwd, SESSION_META_FILE), JSON.stringify(meta), "utf8").catch((err: unknown) => {
		console.warn(
			`[pi-runtime] write session meta failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
		);
	});
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
 * 常驻会话下同键换档走 lane.setThinkingLevel（applyThinkingLevel，失败降级沿用旧档），
 * 只有 LLM 身份（provider+model）变更才重建会话（isSameLlmIdentity，spec §5.5）。 */
export function resolveThinkingLevel(level?: string): ThinkingLevel {
	if (level && THINKING_LEVELS.has(level)) return level as ThinkingLevel;
	return DEFAULT_THINKING_LEVEL;
}

export class SessionManager {
	private readonly sessions = new Map<string, SessionEntry>();
	/** 在途 create（按会话键）：并发同键共享同一次 build（防句柄泄漏，见 create 注释）。 */
	private readonly creating = new Map<string, Promise<CreateResult>>();
	private readonly context: Context = BACKGROUND_CONTEXT;
	private sweeper?: NodeJS.Timeout;

	constructor(
		private readonly tools: AgentHarnessTool<LnkpiToolContext>[] = [],
		private readonly systemPromptDefault = process.env.PI_RUNTIME_SYSTEM_PROMPT ?? "",
		private readonly modelFactory: typeof assembleModel = assembleModel,
		private readonly harnessFactory: HarnessFactory = AgentHarness.create,
		private readonly hooks?: SessionHooks,
		private readonly skills?: SkillRegistry,
		private readonly config: RuntimeConfig = loadRuntimeConfig(process.env),
		/** P0-① 观测：compaction 成败计数（只在 compaction_end 且 completed/failed 时回调）。 */
		private readonly onCompaction?: (result: "ok" | "error") => void,
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
	 * userId 不一致一律 ConflictError（fail-closed，不返回任何会话内容）——内存与磁盘两条路径都校验。
	 */
	async create(threadKey: string, opts: CreateOptions = {}): Promise<CreateResult> {
		const key = toSessionKey(threadKey);
		// 复核 Important #3：并发同键去重。两个 create 同时 miss 会各自 openExisting/build，
		// 后写者覆盖前写者 → 前者的 harness/repo/env 永不 close（句柄泄漏 + 事件订阅悬空）。
		// 共享同一在途 Promise 后，第二个调用方拿到的就是同一次 build 的结果。
		const inflight = this.creating.get(key);
		if (inflight) {
			const shared = await inflight;
			// 归属竞争兜底：若共享结果的归属者不是本次调用方，fail-closed。
			// （返回体只含 provider/model/status，窗口内没有会话内容外泄；下一轮 create 亦会拦截。）
			const entry = this.sessions.get(key);
			if (entry?.userId && opts.userId !== undefined && entry.userId !== opts.userId) {
				throw new ConflictError(key);
			}
			return shared;
		}
		const task = this.doCreate(key, opts).finally(() => this.creating.delete(key));
		this.creating.set(key, task);
		return task;
	}

	private async doCreate(key: string, opts: CreateOptions): Promise<CreateResult> {
		const { models, model, providerId } = this.modelFactory(opts.llm);
		const identity: LlmIdentity = { provider: providerId, model: model.id };

		const existing = this.sessions.get(key);
		if (existing) {
			if (existing.userId && existing.userId !== opts.userId) throw new ConflictError(key);
			if (!isSameLlmIdentity(existing.identity, identity)) {
				// 复核 Minor #6：run 进行中不得抽走在跑的 harness（重建会话 = 换掉 harness 实例）。
				if (existing.prompting) throw new BusyError(key);
				await this.destroy(key);
				const created = await this.build(key, opts, models, model, identity);
				return { ...created, status: "rebuilt" };
			}
			// spec §5.5：身份一致时换档不重建会话，走 lane setter（失败降级为沿用旧档位）。
			const level = resolveThinkingLevel(opts.thinkingLevel);
			if (level !== existing.thinkingLevel) await this.applyThinkingLevel(existing, level);
			// 画布会话 id 每轮自愈：Nest 每轮都调 create，若本会话是在「旧 Nest 未传该字段」
			// 期间建的，这里补上即可消除残留错值（否则要等 TTL 回收才恢复）。
			if (opts.canvasSessionId) existing.canvasSessionId = opts.canvasSessionId;
			existing.lastActivityAt = Date.now();
			return { provider: existing.identity.provider, model: existing.identity.model, status: "resumed", resumedFrom: "memory" };
		}

		const cwd = opts.workingDir ?? join(this.config.dataRoot, key);
		const env = new NodeExecutionEnv({ cwd });
		const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
		// 复核 Important #4：磁盘路径同样 fail-closed。内存回收（TTL）不删磁盘，meta.json 是
		// 归属与身份在磁盘上的唯一记录——threadKey 来自客户端可伪造，缺这层校验时，另一用户
		// 持同键可在会话被回收后恢复他人对话上下文。
		const meta = await readSessionMeta(cwd);
		if (meta) {
			if (meta.userId !== null && opts.userId !== undefined && meta.userId !== opts.userId) {
				throw new ConflictError(key);
			}
			if (!isSameLlmIdentity({ provider: meta.provider, model: meta.model }, identity)) {
				// 与内存路径同语义：身份变更 → 删目录重建（历史随旧身份一起作废）。
				await rm(join(this.config.dataRoot, key), { recursive: true, force: true }).catch(() => {});
				const built = await this.build(key, opts, models, model, identity);
				return { ...built, status: "rebuilt" };
			}
		}
		// 无 meta（部署前遗留目录 / meta 写盘失败）不恢复历史：fail-closed 于「未知归属」，
		// 代价是遗留目录里的旧会话历史不接续（旧链路本就每轮删除会话，遗留目录无接续价值）。
		const opened = meta ? await this.openExisting(repo, cwd) : undefined;
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

		const thinkingLevel = resolveThinkingLevel(opts.thinkingLevel);
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
			canvasSessionId: opts.canvasSessionId,
			turn: normalizeTurnContext({
				attachments: opts.attachments,
				mentionedKeys: opts.mentionedKeys,
				refOrder: opts.refOrder,
				focusNodeId: opts.focusNodeId,
			}),
			thinkingLevel,
			lastActivityAt: Date.now(),
		};
		// 归属/身份落盘（磁盘 resume 的 fail-closed 数据源，复核 Important #4）。
		await writeSessionMeta(cwd, { userId: opts.userId ?? null, provider: identity.provider, model: identity.model });

		const { harness } = await this.harnessFactory<LnkpiToolContext>(
			{
				session,
				models,
				model,
				tools: [...this.tools, ...(this.skills?.tools ?? [])],
				// 函数形态（spec §5.3/§5.4）：harness 在每次 LLM 调用前求值，读到的是最新 turn。
				// ⚠️ `sessionId` 语义 = **画布会话 id**（Nest 用它查库），不是 pi 会话键 `key`。
				// 取值优先级：本轮/建会话时传入的 canvasSessionId → 会话内已存值 → 回落 pi 会话键
				// （旧 Nest 不传该字段时语义退化为 #70 行为，不产生新失败形态）。
				toolContext: () => ({
					sessionId: entry.canvasSessionId ?? key,
					userId: entry.userId,
					...entry.turn,
				}),
				systemPrompt: () => composeSystemPrompt(entry.staticPrompt, entry.turn.dynamicBlocks ?? []),
				thinkingLevel,
				compaction: this.config.compaction,
			},
			this.context,
		);
		entry.harness = harness;

		this.hooks?.onSessionCreated?.(key, harness);

		this.attachEvents(entry, harness);

		this.sessions.set(key, entry);
		return { provider: identity.provider, model: identity.model };
	}

	/** 事件归一订阅：EVENT_MAP 全量透传；compaction_end 顺带计数（同一监听内，避免重复订阅）。 */
	private attachEvents(entry: SessionEntry, harness: AgentHarness<LnkpiToolContext>): void {
		for (const [harnessType, sseType] of EVENT_MAP) {
			entry.unsubscribes.push(
				harness.events.on(harnessType as never, (evt: { lane?: string; status?: string }) => {
					if (harnessType === "compaction_end") this.observeCompactionOutcome(evt.status);
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
	}

	/** declined / aborted 不算失败（hook 拒绝或用户中断），不进错误率。 */
	private observeCompactionOutcome(status?: string): void {
		if (status === "completed") this.onCompaction?.("ok");
		else if (status === "failed") this.onCompaction?.("error");
	}

	/** 关闭并删除：内存句柄 + 磁盘目录（身份变更 / 显式删除共用）。 */
	private async destroy(key: string): Promise<void> {
		const entry = this.sessions.get(key);
		if (!entry) return;
		this.sessions.delete(key);
		await this.releaseHandles(entry);
		await rm(join(this.config.dataRoot, key), { recursive: true, force: true }).catch(() => {});
	}

	/** 只释放内存句柄（harness/repo/env close），**不删磁盘**（TTL 回收专用）。 */
	private async destroyMemoryOnly(key: string): Promise<void> {
		const entry = this.sessions.get(key);
		if (!entry) return;
		this.sessions.delete(key);
		await this.releaseHandles(entry);
	}

	private async releaseHandles(entry: SessionEntry): Promise<void> {		for (const unsub of entry.unsubscribes) unsub();
		entry.listeners.clear();
		await entry.harness.close(this.context).catch(() => {});
		await entry.repo.close(this.context).catch(() => {});
		await entry.env.cleanup(this.context).catch(() => {});
	}

	/**
	 * 常驻会话换档（spec §5.5）：harness 的 thinkingLevel 只在 create 时可设，但会话不再每轮重建，
	 * 故复用路径必须走 lane setter。setter 不可用时降级为沿用旧档位（不阻断本轮对话）。
	 */
	private async applyThinkingLevel(entry: SessionEntry, level: ThinkingLevel): Promise<void> {
		try {
			const lane = await entry.harness.lane(MAIN_LANE, this.context);
			await lane.setThinkingLevel(level, this.context);
			entry.thinkingLevel = level;
		} catch (err) {
			console.warn(
				`[pi-runtime] setThinkingLevel failed for ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** 正在跑 run 的会话：TTL 与磁盘 LRU 双豁免（长任务期间不能把会话/工作目录抽走）。 */
	private runningKeys(): Set<string> {
		const running = new Set<string>();
		for (const [key, entry] of this.sessions) if (entry.prompting) running.add(key);
		return running;
	}

	/**
	 * 一次回收：TTL 只关内存（磁盘保留）；磁盘 LRU 跳过「内存驻留 + 正在跑 run」。
	 * `now` 可注入，便于测试。
	 */
	async sweepOnce(now = Date.now()): Promise<{ closed: string[]; removedFromDisk: string[] }> {
		const closed: string[] = [];
		for (const [key, entry] of [...this.sessions]) {
			if (entry.prompting) continue;
			if (now - entry.lastActivityAt < this.config.sessionTtlMs) continue;
			await this.destroyMemoryOnly(key);
			closed.push(key);
		}
		const protectedKeys = new Set<string>([...this.sessions.keys(), ...this.runningKeys()]);
		const removedFromDisk = await enforceRetention(
			this.config.dataRoot,
			{ maxBytes: this.config.sessionsMaxBytes, maxCount: this.config.sessionsMaxCount },
			protectedKeys,
		);
		return { closed, removedFromDisk };
	}

	startSweeper(): void {
		if (this.sweeper) return;
		this.sweeper = setInterval(() => {
			void this.sweepOnce().catch(() => {});
		}, this.config.sweepIntervalMs);
		// 不让 sweeper 拖住进程退出
		this.sweeper.unref?.();
	}

	stopSweeper(): void {
		if (!this.sweeper) return;
		clearInterval(this.sweeper);
		this.sweeper = undefined;
	}

	/**
	 * B-5 gate 用：按 pi 会话键取画布会话 id（#74 解耦语义）。
	 * gate 的 before_tool 钩子闭包里只有 pi 会话键，而 Nest `/agent/internal/get-node`
	 * 拿 `sessionId` 查**画布**会话 —— 直接传键必 404 → run_* 全被 fail-closed 假阳性拦截。
	 * 未提供建会话时的回落值 = 键本身（退化旧语义，不崩溃）。会话不存在时同样回落键。
	 */
	getCanvasSessionId(threadKey: string): string {
		return this.sessions.get(threadKey)?.canvasSessionId ?? threadKey;
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

	/**
	 * 订阅「只收未来事件」——**不重放缓冲**（P0-A 跨轮重放修复，2026-09-29）。
	 *
	 * 语义 = from now：挂上监听后，只有此后 `dispatch` 的事件会送达。
	 * 供 Nest **每轮新订阅** 用。持久会话的 `buffer` 跨轮累积（`dispatch` 只 push 不清），
	 * 若每轮都从 `afterSeq=-1` 全量重放，客户端会先收到上一轮的全部事件（含其 `agent_end`）
	 * → Nest 命中即 emit `done` 关流 → 本轮回答被上一轮回答顶替（生产实证：S2–S6 每轮
	 * ~100ms 内返回与 S1 逐字相同的回复）。
	 * 断线重连仍走 `subscribe(afterSeq)`（P0-③），二者职责不同、互不替代。
	 */
	subscribeLive(threadKey: string, listener: EventListener): void {
		this.require(threadKey).listeners.add(listener);
	}

	/**
	 * 每轮刷新易变上下文；返回是否真的变化（供 metrics/日志）。
	 * 复核 Important #1（spec §5.4「整体覆盖」）：**替换语义**——Nest 每轮发送完整
	 * turnContext，缺省即清空；不做 `{ ...old, ...new }` 合并（undefined 会保留旧值，
	 * 上一轮的侧栏附件/焦点节点会泄漏进本轮 toolContext）。
	 */
	setTurnContext(threadKey: string, turn: TurnContext): boolean {
		const entry = this.require(threadKey);
		const next = normalizeTurnContext(turn);
		const changed = !isTurnContextEqual(entry.turn, next);
		if (changed) entry.turn = next;
		entry.lastActivityAt = Date.now();
		return changed;
	}

	/** 测试观测口：按会话当前 turn 求值 systemPrompt（与 harness 内部同一组合函数）。 */
	resolveSystemPromptForTest(threadKey: string): string {
		const entry = this.require(threadKey);
		return composeSystemPrompt(entry.staticPrompt, entry.turn.dynamicBlocks ?? []);
	}

	/**
	 * 触发一次 prompt。不 await 完成——事件经 events 总线流出；run 结束由 agent_end 表达。
	 * `opts.turnContext` 在 busy 校验**之后**同步应用（复核 Important #5）：被 409 拒绝的
	 * 请求不得改写在跑 run 下一轮 LLM 调用将读到的动态上下文。
	 */
	async prompt(
		threadKey: string,
		text: string,
		laneName = MAIN_LANE,
		opts?: { forceSkills?: string[]; turnContext?: TurnContext },
	): Promise<{ accepted: boolean }> {
		const entry = this.require(threadKey);
		// 会话常驻后同键并发会串台（同一 harness 上两个 run 交错），fail-closed 拒绝。
		// 复核 Important #2（TOCTOU）：置位必须在任何 await 之前同步完成——原先
		// 「检查 → await harness.lane() → 置位」的窗口里，第二个并发请求能通过检查。
		if (entry.prompting) throw new BusyError(entry.id);
		entry.prompting = true;
		if (opts?.turnContext) this.setTurnContext(threadKey, opts.turnContext);
		try {
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
		} catch (err) {
			// lane 解析失败等同步段异常：复位守卫位，否则会话永久卡在 busy。
			entry.prompting = false;
			entry.cancelRun = undefined;
			entry.userAborted = false;
			throw err;
		}
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

/** 同键并发 prompt：会话常驻后同一 harness 上两个 run 会交错，一律拒绝（路由层映射 409）。 */
export class BusyError extends Error {
	constructor(id: string) {
		super(`session busy: ${id}`);
	}
}
