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
	type AgentLane,
	type Context,
	type JsonlSessionMetadata,
	type QueueMode,
	type Session,
	type ThinkingLevel,
	BACKGROUND_CONTEXT,
	JsonlSessionRepo,
	withCancel,
	compact,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	classifyCompactionError,
	decideCompaction,
	type CompactionOutcome,
	type CompactionSkipReason,
} from "./compaction-check.js";
import type { Metrics } from "./metrics.js";
import { missingSummarySections } from "./compaction-summary.js";
import { assembleModel, type SessionLlmOverride } from "./model-assembly.js";
import { effectiveCompactionSettings, loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
import { applyDynamicBudget, classifyBlock } from "./dynamic-budget.js"
import { estimateImageTokens, toImageContents, type DirectImage } from "./direct-images.js";
import { annotateImagesForSummary } from "./compaction-images.js";
import { enforceRetention } from "./session-retention.js";
import { buildToolEnsemble } from "./tools/tiering.js";
import type { PendingToolRegistry } from "./pending-registry.js";
import type { SkillRegistry } from "./skills/registry.js";
import { stripImageBlocks } from "./sse-sanitize.js";
import type { LnkpiToolContext, SidebarAttachment, LnkpiTool } from "./tools/types.js";

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
	| "error"
	/** 阻塞式确认工具（ask_user / propose_generation）进入/退出等待（2026-10-01）。
	 *  等待**开始**即发：tool_result 在等待结束后才到，靠它反推「等待中」永远不成立。 */
	| "waiting_user"
	/** 「正在做什么 / 做到第几步」（P1 决策 8）。与 tool_start 同源，紧跟 tool_execution_start 之后一条。 */
	| "activity";

/** `activity` 事件载荷。
 *
 * 刻意只带英文工具名 + 步号，**不含中文文案**：人话翻译由客户端目录决定
 * （决策 7：agent 只声明意图，按钮与措辞由客户端渲染层出），避免 runtime 与 Web 两份文案漂移。
 * `total` 在 vendor harness 侧无源（`turn_start` 不带计划步数）→ 不广播，
 * 客户端按「第 N 步」措辞，不要渲染「3/8」这种假分母。
 */
export interface ActivityData {
	toolName?: string;
	/** 本轮第几个工具（1-based，turn_start 归零）；前端据此出进度语义。 */
	done?: number;
}

/** `waiting_user` 事件载荷。status: waiting = 刚挂起等用户；resolved = 已作答/超时/中止。 */
export interface WaitingUserData {
	status: "waiting" | "resolved";
	toolName: string;
	callId: string;
	/** 等待上限（ms）；resolved 时也带上，便于前端算倒计时。 */
	timeoutMs?: number;
	/** 工具透传上下文（propose → nodeId，供前端「定位节点」）。 */
	nodeId?: string;
	/** resolved 的原因（answered / timeout / aborted）；waiting 时省略。 */
	reason?: "answered" | "timeout" | "aborted";
}

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

/** attachEvents 里要读的 tool 类载荷字段（vendor 侧 tool_start 全 camelCase）。 */
type ToolLikeEvent = {
	toolName?: string;
	toolCallId?: string;
};

/**
 * 入队标签（vendor inbox item kind，见 `agent-harness.ts:219` LaneQueuedItem）。
 *
 * 只关心 steer / followUp / nextRun：三者是「插话 / 尾随 / 下一段」三类用户意图，
 * `write` 是 vendor 内部写入，不进用户队列口径。
 */
export type QueuedKind = "steer" | "followUp" | "nextRun";

interface SessionEntry {
	id: string;
	harness: AgentHarness<LnkpiToolContext>;
	env: NodeExecutionEnv;
	repo: JsonlSessionRepo;
	listeners: Set<EventListener>;
	buffer: NormalizedEvent[];
	unsubscribes: Array<() => void>;
	prompting: boolean;
	/**
	 * 当前滞留在 vendor lane inbox 里的队列标签（由 `queue_update` 事件维护全量快照）。
	 *
	 * 存在理由：vendor **不会**自动排空 idle 队列（`docs/work-packages/05-direct-durable-drive.md:69`
	 * 原话 "There is no terminal drain"）。用户在 run 结束后插话，消息会一直睡到下一次
	 * `accept()`；本字段就是「要不要替用户开一轮去接住它」的判据。
	 */
	queued: Set<QueuedKind>;
	/** 排空 in-flight 守卫：防止 run 收尾 drain 与新 prompt 撞车时重复 accept。 */
	draining?: boolean;
	/** 当前 run 的取消函数（withCancel 产出）；run 结束后清空。用户点「停止」时调用。 */
	cancelRun?: (reason?: unknown) => void;
	/** 本轮 run 是否被用户主动取消（用于抑制取消引发的 error 事件，避免重连补发假警报）。 */
	userAborted?: boolean;
	/**
	 * run 后的异步压缩是否在途（reviewer Critical #1）。
	 *
	 * vendor Lane 维持「同一时刻只允许一个 active operation」的不变式
	 * （`lane.ts` 里 `state.operation !== null → LaneBusy`）。压缩是 fire-and-forget 的，
	 * 若期间放行新 prompt，该 prompt 会撞上 LaneBusy：接口返回 200 accepted，
	 * 用户最终只收到一个 error 事件、**拿不到任何回答**。故必须与 `prompting` 同等对待：
	 * 在途期间一律 fail-closed 拒绝。
	 */
	compacting?: boolean;
	/** 下一个待分配的事件 seq（会话内单调递增，P0-③）。 */
	nextSeq: number;
	/** 本轮已广播的 activity 步数（turn_start 归零），供 `activity.done` 使用。 */
	activityStep: number;
	/** create 时确定的静态段（规则 + skills index），会话期内不再变更。 */
	staticPrompt: string;
	/** 未装饰的 base prompt（不含 skills index / 延迟工具索引块）。fork 复用必须传它
	 *  而非 staticPrompt，否则 composeSystemPrompt 会把装饰块拼两份（评审 finding 1）。 */
	basePrompt: string;
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
	/**
	 * 本会话实际使用的上下文窗口上限（来自 model.contextWindow，可被 env 覆盖）。
	 *
	 * run 后压缩判定的阈值基准：缺失时 `decideCompaction` 一律短路为 `no_window`、
	 * 不压缩（fail-safe）。存在理由见下 build 处注释（agnes 的 100 万声明值）。
	 */
	contextWindow?: number;
	/**
	 * 底层 vendored Session 引用：fork 校验目标 entry 是否存在用（避免依赖 vendored 的
	 * 英文报错文案来映射 400）。会话常驻时该句柄一直打开，可直接 `getEntry`。
	 */
	session: Session<JsonlSessionMetadata>;
	/** 会话磁盘元数据快照（cwd + uuid id）：fork 时作为 `repo.fork` 的 source。 */
	sessionMeta: JsonlSessionMetadata;
	/** 解析后的模型集合/单模型描述：fork 须沿用来源 LLM 身份（BYOK/model），不重算。 */
	models: ReturnType<typeof assembleModel>["models"];
	model: ReturnType<typeof assembleModel>["model"];
	/** 最近一次活动时间，TTL 的唯一数据源。 */
	lastActivityAt: number;
}

const BUFFER_LIMIT = 500;

/** 默认（也是唯一）对话 lane 名；换档等 lane 级操作必须落在与 prompt 同一条 lane 上。 */
const MAIN_LANE = "main";

/**
 * run 后压缩（摘要 LLM 调用）的等待上限。
 *
 * 刻意不做成 env 旋钮：这是「防会话被永久卡死」的兜底值，调小会把正常长上下文摘要掐掉，
 * 调大毫无收益；运维没有安全的取值区间，配错反而制造事故。
 */
const COMPACTION_MAX_WAIT_MS = 120_000;

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

/**
 * 静态段块追加（幂等，评审 finding 1）：base 已含某块时跳过。
 * 存在理由：fork 曾把已装饰的 staticPrompt 当 base 再喂 build → composeSystemPrompt，
 * skills index（既有）与延迟工具索引块（本评审发现）都会拼两份、每轮白烧 token。
 * 幂等守卫让「传错已装饰串」不再放大成重复块；fork 侧同时改为传未装饰的 basePrompt。
 */
export function appendPromptBlocks(base: string, blocks: readonly string[]): string {
	const parts = [base, ...blocks.filter((b) => b.length > 0 && !base.includes(b))].filter(
		(p) => p.length > 0,
	);
	return parts.join("\n\n");
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

/**
 * ⚠️ 这里**不再**给 system prompt 挂「运行中插话须先复述再动工具」这类约定段（原 `QUEUE_GUIDANCE`，2026-10-02 取消）。
 *
 * 取消的不是需求，是**杠杆**：
 *  1. system prompt 在会话**创建时**拼一次、此后整轮对话每轮都带；而「有 steer/followUp 积压」是几秒级的
 *     窗口 ⇒ 绝大多数轮次在为一个瞬态付常驻 context 税，还顺手稀释了原本稳定的人设/工作流；
 *  2. 它换回来的是**概率行为**：模型照样可以一个字不说直接跳工具，而且这种退化没有任何事件可观测
 *     （当年 load_tools 强指令化也是同一形状 —— 模型能逐字复述指令，就是不执行）；
 *  3. 「用户看得到它接住了」本来就有一半是**确定性**可解的问题（前端状态 + 事件），不该摊给模型即兴发挥；
 *     至于「它怎么改计划」，那是模型 reasoning 的自然产物，用 instruction 逼它"复述"只会产出空洞的复述体。
 *
 * 替代做法见 `apps/server/src/agent/pi-runtime/pi-runtime.client.ts` 的 `queue()`：
 * 在 steer / followUp 这**一条**消息上加一行 kind 标签（"用户补充 · 插在本轮进行中"），
 * 告诉模型这条消息**是什么来头**（这是「先重新规划」的真实触发条件），而不是命令它「你该说什么」。
 * 常态 context 零增加，且行为确定性由消息结构保证，不靠模型记性。
 */

/** 静态段在前、动态段尾部追加（spec §4 动态上下文判据：稳定前缀不被易变内容推到后面）。 */
export function composeSystemPrompt(
	staticPart: string,
	dynamicBlocks: readonly string[],
	budget?: {
		totalChars: number;
		onDrop?: (kind: string) => void;
		onUnknownKind?: () => void;
	},
): string {
	const blocks = dynamicBlocks.map((b) => b.trim()).filter(Boolean);
	if (blocks.length === 0) return staticPart;
	let joined: string;
	if (budget) {
		// T3：预算截断（byte-stable——判定只依赖块内容；off/未传时走原路径逐字节不变）。
		const r = applyDynamicBudget(blocks, { totalChars: budget.totalChars });
		for (const [kind, n] of Object.entries(r.dropped)) {
			for (let i = 0; i < n; i++) budget.onDrop?.(kind);
		}
		for (const b of blocks) {
			if (classifyBlock(b) === "general") budget.onUnknownKind?.();
		}
		joined = r.blocks.join("\n\n");
	} else {
		joined = blocks.join("\n\n");
	}
	if (!staticPart) return joined;
	return `${staticPart}\n\n${joined}`;
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
	/** 阻塞式确认类工具的等待注册表（index.ts 装配注入，abort 联动用）。 */
	private pendingRegistry?: PendingToolRegistry;

	/**
	 * run 后压缩（扫盘 + 摘要 LLM 调用）的整体等待上限；**仅用于测试注入**，
	 * 生产恒为 COMPACTION_MAX_WAIT_MS。见 maybeCompact 的 deadline 注释。
	 */
	compactionMaxWaitMs: number = COMPACTION_MAX_WAIT_MS;

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
	/**
	 * 压缩「跳过理由」计数。刻意与 `onCompaction` 分开：后者由 harness 事件驱动
	 * （ok/error 是**结果**），本度量则是**未发生的理由**（disabled/no_window/
	 * below_threshold/lane_busy…）。二者混计会把真实失败率稀释掉。
	 */
	private readonly metrics?: Metrics,
	/**
	 * 审计 #6/#7：压缩完成后的摘要上报钩子（宿主把摘要落 Nest ContextSnapshot）。
	 * 刻意由构造器注入而非直接 fetch：SessionManager 不依赖传输层，测试可捕获。
	 */
	private readonly compactionAudit?: {
		onSnapshot: (payload: {
			threadId: string;
			sessionId: string;
			stage: string;
			planSummary: string;
			messageCount: number | null;
		}) => void;
	},
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
				// 压缩在途同样是 active operation：此时 destroy 会让 lane.compact 以 Closed 收场，
				// 且摘要写回的会话已被丢弃 —— 白跑一次 LLM 调用。
				if (existing.compacting) throw new BusyError(key, "compacting");
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
	private async openExisting(
		repo: JsonlSessionRepo,
		cwd: string,
	): Promise<Session<JsonlSessionMetadata> | undefined> {
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
		existingFs?: {
			env: NodeExecutionEnv;
			repo: JsonlSessionRepo;
			// 必须带 JsonlSessionMetadata 泛型：否则 session.metadata 退化为基类
			// SessionMetadata（缺 path/modifiedAt），fork 拿不到合规的 source 元数据。
			session?: Session<JsonlSessionMetadata>;
		},
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
			queued: new Set(),
			nextSeq: 0,
			activityStep: 0,
			// ⚠️ base 必须回落到构造时的 systemPromptDefault：`POST /sessions` 的 systemPrompt 是可选
			// 字段（app.ts:113），传空串 / 不传时这里**不能**退化成「没有 base prompt」——
			// 否则默认系统提示被整段顶替掉（生产上表现为 agent 没有任何基础人设，只剩裸动态段）。
			// 插话显化不再靠 system prompt（见文件顶部的取消说明），故这里是纯 base，无 guidance 段。
			staticPrompt: this.composeSystemPrompt(
				opts.systemPrompt || this.systemPromptDefault,
			),
			basePrompt: opts.systemPrompt ?? "",
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
			// 压缩阈值基准。优先级刻意是「配置覆盖 → 模型声明值」：agnes provider 把
			// contextWindow 声明为 1_000_000，直接用它算出的阈值 983,616 永不触及，
			// 触发链路接好了也一次都不会压缩（2026-09-30 诊断 F-01 · Review Focus #1）。
			contextWindow: this.config.compactionContextWindow ?? model.contextWindow,
			// fork 复用需要：底层 Session / 元数据 / 模型对象（来源身份沿用，不重算）
			session,
			sessionMeta: session.metadata,
			models,
			model,
			lastActivityAt: Date.now(),
		};
		// 归属/身份落盘（磁盘 resume 的 fail-closed 数据源，复核 Important #4）。
		await writeSessionMeta(cwd, { userId: opts.userId ?? null, provider: identity.provider, model: identity.model });

		const toolEnsemble = this.getToolEnsemble();
		const { harness } = await this.harnessFactory<LnkpiToolContext>(
			{
				session,
				models,
				model,
				// 审计 P0-④ 官方模式（vendor coding-agent docs/extensions.md Dynamic Tool Loading）：
				// 全部工具注册进 config.tools（延迟工具「存在但未激活」），activeToolNames 初始
				// = 常驻集 + tool_search。vendor generation.ts 只下发 active 的 schema（省上下文
				// 不变）；tiering off → registered=全量、activeToolNames=全量（逐字节现状）。
				tools: toolEnsemble.registered,
				activeToolNames: toolEnsemble.activeToolNames,
				// 函数形态（spec §5.3/§5.4）：harness 在每次 LLM 调用前求值，读到的是最新 turn。
				// ⚠️ `sessionId` 语义 = **画布会话 id**（Nest 用它查库），不是 pi 会话键 `key`。
				// 取值优先级：本轮/建会话时传入的 canvasSessionId → 会话内已存值 → 回落 pi 会话键
				// （旧 Nest 不传该字段时语义退化为 #70 行为，不产生新失败形态）。
				toolContext: () => ({
					sessionId: entry.canvasSessionId ?? key,
					userId: entry.userId,
					...entry.turn,
				}),
				systemPrompt: () => this.composeEntryAndObserve(entry),
				thinkingLevel,
				// steering / followUp 队列模式（2026-10-02）：此前这两个值只在 configmap 里
				// 写过、没人读（死配置），harness 实际吃的是 vendor 默认 "all"。
				steeringMode: this.config.steeringMode,
				followUpMode: this.config.followUpMode,
				compaction: effectiveCompactionSettings(
					this.config.compaction,
					this.config.compactionContextWindow ?? model.contextWindow,
				),
			},
			this.context,
		);
		entry.harness = harness;

		// T4 压缩图片占位（spec §3.3 / B1 取证 Ruling）：before_compaction hook 只能整体替代
		// 压缩结果、宿主又没有 compaction 触发路径，因此在此对 preparation 的消息**副本**做
		// 图片侧注（annotateImagesForSummary）后调 vendor 导出的 compact() 自产摘要并整体返回。
		// fail-soft：无图消息零变换 → 返回 undefined 走 vendor 原生路径；compact 失败同样让路。
		// 已知代价（B1 Ruling）：fromHook 路径 vendor 不记 summary usage 行（观测缺口）。
		{
			const compactionContext = this.context;
			harness.hooks?.on?.("before_compaction", async (event) => {
				try {
					const prep = event.preparation as unknown as Record<string, unknown>;
					const annotated: Record<string, unknown> = { ...prep };
					let changed = false;
					for (const field of ["messagesToSummarize", "turnPrefixMessages"] as const) {
						const list = prep[field];
						if (!Array.isArray(list)) continue;
						const next = annotateImagesForSummary(list as never);
						if (next) {
							annotated[field] = next;
							changed = true;
						}
					}
					if (!changed) return undefined; // 纯文本会话：逐字节原生路径
					const result = await compact(
						annotated as never,
						entry.models,
						entry.model,
						event.customInstructions,
						entry.thinkingLevel,
						undefined,
						undefined,
						compactionContext,
					);
					return result.ok ? { compaction: result.value } : undefined;
				} catch (err) {
					console.warn("[pi-runtime] before_compaction image annotation failed (fail-soft):", err);
					return undefined;
				}
			});
		}

		this.hooks?.onSessionCreated?.(key, harness);

		this.attachEvents(entry, harness);

		this.sessions.set(key, entry);
		return { provider: identity.provider, model: identity.model };
	}

	/** 事件归一订阅：EVENT_MAP 全量透传；compaction_end 顺带计数（同一监听内，避免重复订阅）。
	 *  tool_start 额外发一条 `activity`（决策 8），同样在同一监听内，保证与 tool_execution_start 同帧。 */
	private attachEvents(entry: SessionEntry, harness: AgentHarness<LnkpiToolContext>): void {
		for (const [harnessType, sseType] of EVENT_MAP) {
			entry.unsubscribes.push(
				harness.events.on(harnessType as never, (evt: { lane?: string; status?: string } & ToolLikeEvent) => {
					if (harnessType === "compaction_end") {
						this.observeCompactionOutcome(evt.status);
						// 审计 #6/#7：压缩成功后异步审计摘要（缺段计 metrics + 摘要上报）。
						// fire-and-forget：审计失败不影响事件分发与会话主链路。
						if (evt.status === "completed") void this.auditCompactionSummary(entry);
					}
					if (harnessType === "tool_start") this.dispatchActivity(entry, evt);
					if (harnessType === "turn_start") entry.activityStep = 0;
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
		// 审计 P0-③：usage 事件只进 metrics，**不进** EVENT_MAP / SSE —— Nest 侧
		// PiRuntimeEvent 是封闭联合，未知类型有被静默丢弃或误解析的风险；tokens/cost
		// 的 UI 呈现走 Nest 既有的 message_end.usage 路径，不靠这条。
		// 队列积压追踪（2026-10-02 steering/followUp 接入）：`queue_update` 的 `queues` 是 vendor
		// 的**全量** inbox 快照（`enqueue` 用含新条目的 `state.inbox` 求 readLaneQueues，lane.ts:1499），
		// 故直接整体重建 entry.queued，不增量增删。
		// 刻意**不**派发进 SSE：队列是内部状态，暴露给前端只会让客户端再去画一层「待发队列」。
		entry.unsubscribes.push(
			harness.events.on("queue_update" as never, (evt: { queues?: Array<{ kind?: string }> }) => {
				const kinds = new Set<QueuedKind>();
				for (const item of evt.queues ?? []) {
					if (item.kind === "steer" || item.kind === "followUp" || item.kind === "nextRun") {
						kinds.add(item.kind);
					}
				}
				entry.queued = kinds;
			}),
		);

		if (this.metrics) {
			const metrics = this.metrics;
			entry.unsubscribes.push(
				harness.events.on("usage" as never, (evt: { row?: { usage?: Parameters<Metrics["observeUsage"]>[0] } }) => {
					if (evt.row?.usage) metrics.observeUsage(evt.row.usage);
				}),
			);
		}
	}

	/**
	 * 「正在做什么」广播（P1 决策 8）：每个工具**开始**执行时紧跟一条 `activity`。
	 *
	 * 为什么不让前端从 tool_execution_start 自己攒：长工具（生成 / 压缩 / 联网）期间状态行会
	 * 停在上一句，用户看到的是「正在做 X」而 X 早就结束了 —— activity 让状态行在工具**起手**
	 * 那一刻就换词。载荷只给英文工具名，中文由客户端目录翻译（决策 7）。
	 *
	 * @param evt tool_start 载荷（lane/status 之外只取 toolName）
	 */
	private dispatchActivity(entry: SessionEntry, evt: ToolLikeEvent): void {
		entry.activityStep += 1;
		this.dispatch(entry, {
			type: "activity",
			ts: Date.now(),
			data: { toolName: evt.toolName, done: entry.activityStep } satisfies ActivityData,
		});
	}

	/** declined / aborted 不算失败（hook 拒绝或用户中断），不进错误率。 */
	private observeCompactionOutcome(status?: string): void {
		if (status === "completed") this.onCompaction?.("ok");
		else if (status === "failed") this.onCompaction?.("error");
	}

	/**
	 * 审计 #6/#7：压缩完成后读最新 compaction entry——摘要缺段计 metrics（观测告警，
	 * 不阻断），摘要全文经 compactionAudit.onSnapshot 上报（宿主落 Nest ContextSnapshot）。
	 *
	 * findEntries 用 newestFirst + stopAtType:"compaction"：返回数组第一条即最新压缩点
	 * （与 runCompaction 的 oldestFirst 方向相反，这里只要最新一条）。fail-soft 全包：
	 * lane 缺失/扫盘失败只 warn，绝不影响事件分发与会话主链路。
	 */
	private async auditCompactionSummary(entry: SessionEntry): Promise<void> {
		try {
			const lane = await entry.harness.lane(MAIN_LANE, this.context);
			const entries = (await lane.findEntries(
				{ order: "newestFirst", stopAtType: "compaction" },
				this.context,
			)) as Array<{ type: string; summary?: string; tokensBefore?: number }>;
			const comp = Array.isArray(entries) ? entries.find((e) => e?.type === "compaction") : undefined;
			if (!comp?.summary) return;
			const missing = missingSummarySections(comp.summary);
			if (missing.length) this.metrics?.observeCompactionSummaryGap(missing);
			this.compactionAudit?.onSnapshot({
				threadId: entry.id,
				sessionId: entry.canvasSessionId ?? entry.id,
				stage: "compaction",
				planSummary: comp.summary,
				messageCount: typeof comp.tokensBefore === "number" ? comp.tokensBefore : null,
			});
		} catch (err) {
			console.warn("[compaction-summary] audit failed (fail-soft):", err);
		}
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
			// 压缩在途同样是 active operation：此刻回收会让摘要白跑一次（Closed）。
			if (entry.prompting || entry.compacting) continue;
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

	/**
	 * 阻塞等待可见化（2026-10-01）：按**画布会话 id** 广播 `waiting_user` 事件。
	 *
	 * registry 侧只有画布会话 id（工具域语义），而事件派发需要 pi 会话键的 entry ——
	 * 这里做一次反向查找（`canvasSessionId` 相等，或未提供时回落 `entry.id` 与之相等，
	 * 与 abort 联动 `abortAll(entry.canvasSessionId ?? entry.id)` 同键语义）。
	 * 命中 0 个会话不是错误（sweeper 已回收 / 会话在别的实例）→ 静默返回 0。
	 *
	 * @returns 命中的会话数（诊断用；调用方不据此判成败）
	 */
	dispatchWaitingUser(canvasSessionId: string, data: WaitingUserData): number {
		let hits = 0;
		for (const entry of this.sessions.values()) {
			const key = entry.canvasSessionId ?? entry.id;
			if (key !== canvasSessionId) continue;
			this.dispatch(entry, { type: "waiting_user", ts: Date.now(), data });
			hits += 1;
		}
		return hits;
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
		const sp = composeSystemPrompt(entry.staticPrompt, entry.turn.dynamicBlocks ?? [], this.dynamicBudgetOption());
		this.metrics?.observeSystemPromptBytes(Buffer.byteLength(sp, "utf8")); // M2：utf8 字节（名字是 bytes，UTF-16 length 会低估 CJK 2~3x）
		return sp;
	}

	/** T3 预算选项：off（或未配）返回 undefined = 逐字节回退旧行为；on 时挂 metrics 回调。 */
	private dynamicBudgetOption():
		| { totalChars: number; onDrop?: (kind: string) => void; onUnknownKind?: () => void }
		| undefined {
		if (!(this.config.dynamicBudget ?? true)) return undefined;
		const m = this.metrics;
		return {
			totalChars: this.config.dynamicBudgetTotalChars ?? 48_000,
			onDrop: m ? (kind) => m.observeDynamicBudgetDrop(kind) : undefined,
			onUnknownKind: m ? () => m.observeUnknownBlockKind() : undefined,
		};
	}

	/** 组装 systemPrompt 并上报 bytes 水位（T3 观测）。闭包捕获 entry 而非 require(threadKey)：
	 * harness 可能在会话注册进 this.sessions 之前就调用此闭包（create/fork 时序），require 会炸。 */
	private composeEntryAndObserve(entry: SessionEntry): string {
		const sp = composeSystemPrompt(entry.staticPrompt, entry.turn.dynamicBlocks ?? [], this.dynamicBudgetOption());
		this.metrics?.observeSystemPromptBytes(Buffer.byteLength(sp, "utf8")); // M2：utf8 字节（名字是 bytes，UTF-16 length 会低估 CJK 2~3x）
		return sp;
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
		opts?: { forceSkills?: string[]; turnContext?: TurnContext; images?: DirectImage[] },
	): Promise<{ accepted: boolean }> {
		const entry = this.require(threadKey);
		// 会话常驻后同键并发会串台（同一 harness 上两个 run 交错），fail-closed 拒绝。
		// 复核 Important #2（TOCTOU）：置位必须在任何 await 之前同步完成——原先
		// 「检查 → await harness.lane() → 置位」的窗口里，第二个并发请求能通过检查。
		// 压缩在途同样属于「active operation」，必须与 prompting 一并拒绝（Critical #1）。
		// 只判 prompting 的话，撞 LaneBusy 的那一轮会以 200 accepted 落空——用户拿不到回答。
		if (entry.prompting) throw new BusyError(entry.id);
		if (entry.compacting) throw new BusyError(entry.id, "compacting");
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
			// 多模态直通（T1）：payload 顶层 images → lane.prompt 第二参（ImageContent[]）。
			// 门控 off / 载荷为空 → undefined（纯文本发送，绝不发空数组，Review Focus 1）。
			const directImages = this.config.directImages === false ? undefined : toImageContents(opts?.images);
			if (directImages) {
				const tokensEst = (opts?.images ?? []).reduce((acc, img) => acc + estimateImageTokens(img.data ?? ""), 0);
				this.metrics?.observeDirectImage("sent", tokensEst);
			}
			void lane
				.prompt(effectiveText, directImages, run.context)
				.then((result) => {
					if (!result.ok) {
						this.dispatch(entry, {
							type: "error",
							lane: laneName,
							ts: Date.now(),
							data: { source: "prompt", message: String(result.error) },
						});
					}
					// 只有正常完成的那一轮才判定压缩：取消/出错的轮留到下一轮再说。
					// 位置必须在 finally（会清 userAborted）之前，否则读不到用户的停止意愿。
					// fire-and-forget 的固有代价曾经咬过一次（漏 import 的 ReferenceError 被静默吞掉，
					// 表现为「功能没生效」），故这里必须留痕，哪怕只是 console.warn。
					if (result.ok) {
						// 排空与压缩互不依赖：压缩动历史摘要，排空动 lane inbox；
						// 若压缩已经接管（entry.compacting），drainQueued 会自己让位。
						void this.drainAfterRun(entry, lane).catch((err: unknown) => {
							console.warn(
								`[pi-runtime] drain-after-run hook failed: ${
									err instanceof Error ? err.message : String(err)
								}`,
							);
						});
						void this.maybeCompact(entry, lane).catch((err: unknown) => {
							console.warn(
								`[pi-runtime] post-run compaction hook failed: ${
									err instanceof Error ? err.message : String(err)
								}`,
							);
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
	 * 用户插话（steering 队列）——「run 进行中发言」的唯一正道。
	 *
	 * ⚠️ 消费点（durable lane 的真实位置，**不是** `agent-loop.ts:168/195/257` 那三处，
	 * 那是 legacy `Agent` 的消费点，durable `AgentHarness` 走 `Lane` 运行时、根本不进 agent-loop）：
	 *   1. run 内边界 `runtime/drive/boundary.ts:85-89` —— 每个 checkpoint / 收尾边界把 steer
	 *      选中并让**同一次 run** 再生成一代。这就是「run 进行中插话立刻接上」的落点；
	 *   2. idle 接受 `lane.ts:588-592`（`selectAcceptedInbox`）—— run 不在跑时入的队，
	 *      由本文件的 `drainQueued` 兜底开一轮把它接住。
	 *
	 * 刻意**不**用 followUp 做这条路径：followUp 只在「本轮已无任何 trigger 条目」时才被拉
	 * （boundary.ts:106），且语义是「run 收尾时追加」；工具阻塞（ask_user / propose_generation）
	 * 期间连 checkpoint 边界都不会有，followUp 必睡，steer 才是唯一能等到边界的标签。
	 *
	 * @returns `queued: true`（入队成功）。消息经 `pi.pending.entry` 落盘，进程重启不丢。
	 */
	async steer(
		threadKey: string,
		text: string,
		laneName = MAIN_LANE,
		opts?: { turnContext?: TurnContext },
	): Promise<{ queued: true }> {
		const entry = this.require(threadKey);
		const trimmed = text.trim();
		if (!trimmed) throw new InvalidInputError("steer requires a non-empty text");
		const lane = await entry.harness.lane(laneName, this.context);
		const res = await lane.steer(trimmed, undefined, this.context);
		if (!res.ok) throw new QueueRejectedError(entry.id, `steer: ${describeQueueError(res.error)}`);
		if (opts?.turnContext) this.setTurnContext(threadKey, opts.turnContext);
		entry.lastActivityAt = Date.now();
		// idle 时入队 vendor 不会自己跑（没有 terminal drain），这里当场兜底开一轮。
		// run 在跑时不排空：该轮自己的 checkpoint/finish 边界会消费，抢 accept 只会撞 busy。
		// 入队成功本身就是「有积压」的证据，故不必再看 queue_update 快照。
		if (!entry.prompting) void this.drainQueued(entry, lane);
		return { queued: true };
	}

	/**
	 * 尾随指令（followUp 队列）——「run 收尾时再补一句」的正道。
	 *
	 * 与 steer 的区别不是「谁先谁后」，而是**消费时机**：followUp 只在收尾边界
	 * （`finishRunBoundary`，boundary.ts:187 的 `followUpWhenNoTrigger` 硬编码 true）且本轮
	 * 无 trigger 条目时被选中，作用是把**同一次 run** 续跑一代（同 operationId，不是新 run）。
	 * 所以 run 进行中入 followUp，效果要等到那轮快结束时才出现；想立刻接话请用 `steer`。
	 *
	 * @returns `queued: true`
	 */
	async followUp(
		threadKey: string,
		text: string,
		laneName = MAIN_LANE,
		opts?: { turnContext?: TurnContext },
	): Promise<{ queued: true }> {
		const entry = this.require(threadKey);
		const trimmed = text.trim();
		if (!trimmed) throw new InvalidInputError("followUp requires a non-empty text");
		const lane = await entry.harness.lane(laneName, this.context);
		const res = await lane.followUp(trimmed, undefined, this.context);
		if (!res.ok) throw new QueueRejectedError(entry.id, `followUp: ${describeQueueError(res.error)}`);
		if (opts?.turnContext) this.setTurnContext(threadKey, opts.turnContext);
		entry.lastActivityAt = Date.now();
		if (!entry.prompting) void this.drainQueued(entry, lane);
		return { queued: true };
	}

	/**
	 * idle 排空兜底（vendor 明确没有 terminal drain）。
	 *
	 * `docs/work-packages/05-direct-durable-drive.md:69` 原话 "There is no terminal drain"：
	 * run 结束后入队的 steer/followUp 会一直睡到下一次 `accept()`。用户视角就是「我明明发了，
	 * 但它不理我」—— 这正是本项目此前只有前端单槽队列（刷新即丢）且服务端一律 409 的老毛病。
	 *
	 * 这里替用户在 lane idle 时开一轮空 prompt：accept 会走 `selectAcceptedInbox` 把积压
	 * 全部取走（空 prompt + 有积压是合法组合，`lane.ts:614-626`）。
	 *
	 * 失败不重试：积压留在 vendor inbox 里，下一条 prompt 到来时自然会再被消费一次。
	 */
	private async drainQueued(entry: SessionEntry, lane: AgentLane): Promise<void> {
		if (entry.draining) return;
		// 压缩在途时 lane 判 busy（Critical #1 同构）：排空必失败，保留积压等下一次时机，
		// 不在此处刷 warn——那是正常状态而非故障，刷了只会淹没真错误。
		if (entry.compacting) return;
		entry.draining = true;
		try {
			const res = await lane.prompt("", undefined, this.context);
			if (res.ok) {
				entry.queued.clear();
				return;
			}
			// 仍忙（压缩在途 / 别的 operation）：保留积压，只留痕。
			const msg = describeQueueError(res.error);
			if (/empty|must contain/i.test(msg)) {
				// 我们的快照领先于 vendor 实际 inbox（空 prompt 无内容可排）→ 视为已排空。
				entry.queued.clear();
				return;
			}
			console.warn(`[pi-runtime] drain queued messages failed for ${entry.id}: ${msg}`);
		} finally {
			entry.draining = false;
		}
	}

	/**
	 * run 正常结束后的排空检查：用户在跑这段期间插了话，就该接着跑，而不是等用户再发一次。
	 *
	 * 此时 `entry.prompting` 仍为 true（`.finally` 还没跑），所以**不能**在这里把 prompting
	 * 当守卫——那条守卫只配挂在「消息到达的那一刻」（见 `steer`/`followUp` 调用点）。
	 * 撞 busy 的代价仅是本轮没排上：积压留在 vendor inbox，下一次机会接着试。
	 */
	private async drainAfterRun(entry: SessionEntry, lane: AgentLane): Promise<void> {
		await this.drainQueued(entry, lane);
	}

	/**
	 * run 后压缩判定与触发（诊断 F-01：能力齐全、唯独缺失的那一环）。
	 *
	 * vendor 的决策原语（`shouldCompact`）与执行 API（`lane.compact`）都已写好，但 harness
	 * 自己不调前者、pi-runtime 此前也不调后者，于是 `compaction.enabled` 什么都不控制。
	 * 本方法就是那个「谁来问」的角色。
	 *
	 * 刻意 fire-and-forget（不 await 完成）：不为一次摘要调用阻塞用户对下一条消息的响应。
	 * 刻意不重试：每轮 run 至多走到这里一次，失败留给下一轮再判定（Review Focus #3）。
	 * 「每轮至多一次」由调用位置本身保证——只有 run 的**正常完成**分支会走到这里。
	 *
	 * 压缩在途期间会话处于 busy（`entry.compacting`），新 prompt 会被 BusyError 挡掉——
	 * 因为 vendor Lane 同一时刻只容一个 active operation，放行会让请求静默落空（Critical #1）。
	 */
	private async maybeCompact(entry: SessionEntry, lane: AgentLane): Promise<void> {
		// 置位必须是第一条语句（Critical #2）：调用点在 `lane.prompt().then()` 内，同步段会在
		// run 的 `.finally`（清 prompting）之前跑完；一旦把置位挪到某个 await 之后，就会出现
		// 「run 已结束但压缩尚未接管」的空档，请求溜进去后撞 LaneBusy → 用户拿不到回答。
		entry.compacting = true;
		// 截止自上而下覆盖**整条**链路（扫盘 + 摘要），而不只是摘要那一段：任何一环 hanging
		// 都会让本方法永不返回，`entry.compacting` 就永远不清 —— 该会话此后永久 409。
		const bounded = withCancel(this.context);
		const maxWaitMs = this.compactionMaxWaitMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => {
				// 双保险：既取消 context（真正掐断摘要的 HTTP 流），也在 await 这一侧设逃生口。
				// 后者不可或缺 —— lane 自身不读 abortSignal，全仓只有一处清理 operation
				// （lane.ts:439），若 vendor 未能 settle，光靠 cancel 仍会把这里吊死。
				bounded.cancel(new Error(`compaction exceeded ${maxWaitMs}ms`));
				resolve("timeout");
			}, maxWaitMs);
		});
		try {
			const outcome = await Promise.race([this.runCompaction(entry, lane, bounded.context), deadline]);
			// outcome 为 undefined 表示压缩已成功发起：ok 由 harness 自己下发的
			// compaction_end(status=completed) 事件计数，这里再计一次会翻倍（Review Focus #4）。
			if (outcome === "timeout") this.metrics?.observeCompactionSkip("timeout");
			else if (outcome) this.metrics?.observeCompactionSkip(outcome);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			// 会话可能已在压缩期间被回收；布尔位无所谓，清掉即可。
			// try/finally 覆盖整段（含跳过路径），保证不存在「永久 busy」的残留。
			entry.compacting = false;
		}
	}

	/**
	 * 压缩的决策 + 执行体；返回一个 skip 理由，或 `undefined` 表示已成功发起。
	 *
	 * 刻意不重试：失败留给下一轮再判定（Review Focus #3）。
	 */
	private async runCompaction(
		entry: SessionEntry,
		lane: AgentLane,
		context: Context,
	): Promise<CompactionSkipReason | CompactionOutcome | undefined> {
		// 用户按了停止：不再追加一次摘要类 LLM 调用（Review Focus #2）
		if (entry.userAborted) return undefined;
		// 顺序不可省略（Critical #3）：vendor 的 `getLastAssistantUsage` 把**末元素当最新**
		// （compaction.ts:183），而 `lane.findEntries` 缺省 `newestFirst`（lane.ts:1906）——
		// 两者方向相反。原样透传会让多轮会话取到**第一轮**的 usage，contextTokens 恒为几千，
		// 压缩永不触发，而 skips_total{below_threshold} 照常累加（最危险的一类「假修好」）。
		// `stopAtType: "compaction"` 与 vendor acceptCompaction 同构（lane.ts:703）：
		// 只扫到上一个压缩点为止，避免长会话每轮全量读历史。
		// 缺方法的守卫必须在**调用之前**：`lane.findEntries` 为 undefined 时同步抛 TypeError，
		// 链式 `.catch` 接不住，异常会一路穿到调用点变成一行 console.warn —— 指标上什么都不留。
		// 这与 F-01 同构：「看起来没报错、实际从未压缩」，是本次要根治的形态。
		if (typeof lane.findEntries !== "function") return "lane_unavailable";
		const scanned = await lane
			.findEntries({ order: "oldestFirst", stopAtType: "compaction" }, context)
			.then((entries) => ({ ok: true as const, entries }), () => ({ ok: false as const }));
		// 扫盘失败 ≠ 用量没超阈值：合并成一个 label 就等于放弃了「扫盘有没成功」这个信号。
		if (!scanned.ok) return "entries_unavailable";
		// 阈值口径与 harness options 同源（effectiveCompactionSettings，审计 P0-①）：
		// targetRatio 生效时 reserveTokens 由 entry.contextWindow 反推。
		// ⚠️ 有效窗口口径只约束本 hook 路径；vendor 中途自动压缩仍用 model.contextWindow
		// （vendor 只读），删掉本 hook 会让压缩退回 ~96% 才触发（详见 runtime-config 注释）。
		// entry.contextWindow 理论上必有值（create 时必算）；undefined 走原始配置，fail-soft。
		const settings =
			entry.contextWindow === undefined
				? this.config.compaction
				: effectiveCompactionSettings(this.config.compaction, entry.contextWindow);
		const decision = decideCompaction(scanned.entries, entry.contextWindow, settings);
		if (!decision.shouldRun) return decision.skipReason ?? "unknown";
		try {
			const res = await lane.compact(undefined, context);
			if (res.ok) return undefined; // ok 由事件计，不得在此重复计数
			return classifyCompactionError(res.error);
		} catch (err) {
			// sweeper 抢走句柄等会以异常而非 Result 抛出，同样要归类而非静默。
			return classifyCompactionError(err);
		}
	}

	/**
	 * 中断该会话当前正在跑的 run（用户点「停止」）。
	 * 会话本身保留——用户可以接着发新消息；无活跃 run 时返回 false（前端按「已断开」提示）。
	 *
	 * abort 联动（2026-09-30-ask-user-blocking）：entry 找到即清理该会话的全部阻塞等待
	 * （防御性——即使 cancelRun 已空，ask_user 挂起的 waitForUser 也要以 aborted 交还，
	 * 否则模型侧永久悬挂）。键 = entry.canvasSessionId（工具域），未提供时回落 entry.id，
	 * 与 toolContext.sessionId 的回落语义一致。
	 */
	abort(threadKey: string): boolean {
		const entry = this.sessions.get(toSessionKey(threadKey));
		if (entry) this.pendingRegistry?.abortAll(entry.canvasSessionId ?? entry.id);
		if (!entry?.cancelRun) return false;
		entry.userAborted = true;
		entry.cancelRun("user_cancel");
		entry.cancelRun = undefined;
		return true;
	}

	/** index.ts 装配用（构造签名长，避免位置参数漂移）。 */
	setPendingRegistry(registry: PendingToolRegistry): void {
		this.pendingRegistry = registry;
	}

	/**
	 * ③ 重跑：后端线程截断（与 WorkBuddy「编辑并重发」一致）。
	 *
	 * 以 `atEntryId` 为切点，从来源会话 fork 出一条**新**分支会话：目标消息及其之后全部
	 * 丢弃（`position: "before"`），新 run 从切点父节点续写。来源会话磁盘/内存均不动。
	 *
	 * 关键不变量（踩过双重哈希的坑）：
	 *   - 返回给调用方的 `newKey` 是**原始** threadKey（`<来源>__fork_<uuid>`），Nest 后续
	 *     以它作为 threadId → pi-runtime 内部 `toSessionKey(newKey)` 得到与本方法注册时
	 *     完全一致的内存键。绝不可把已哈希的键回传，否则二次哈希后会话对不上。
	 *   - forkedSession 已在 `source.repo` 内打开，故 `build` 走 `existingFs` 分支直接挂
	 *     harness，不重建磁盘、不重复 open（避免 "Session is already open"）。
	 *   - 沿用来源 `identity`/`staticPrompt`/`canvasSessionId`，保证分支与原对话同模型、同系统上下文。
	 */
	async fork(
		threadKey: string,
		atEntryId: string,
	): Promise<{ newKey: string; newSessionId: string }> {
		const source = this.require(threadKey);
		// 正在跑 run 的会话不允许 fork（fork 会读 source 快照，串台风险 fail-closed）。
		if (source.prompting) throw new BusyError(source.id);
		// 压缩在途也不允许：压缩会改写会话条目（截断 + 写摘要），此刻 fork 可能拷到中间态。
		if (source.compacting) throw new BusyError(source.id, "compacting");
		if (!source.session || !source.sessionMeta) {
			throw new Error(`session ${source.id} missing underlying session snapshot; cannot fork`);
		}
		// 先校验目标 entry 确实存在（main 分支上）。用底层句柄自查，不依赖 vendored 的
		// 英文报错文案 —— 不存在统一映射 400（WorkBuddy「重跑」要求 branchFromEntryId 有效）。
		const target = await source.session
			.getEntry(atEntryId, this.context)
			.catch(() => undefined);
		if (!target) throw new ForkTargetUnknownError(source.id, atEntryId);

		const forkedSession = await source.repo.fork(
			source.sessionMeta,
			{ scope: "branch", branch: MAIN_LANE, entryId: atEntryId, position: "before" },
			this.context,
		);
		const newSessionId = forkedSession.metadata.id;
		const rawNewKey = `${threadKey}__fork_${newSessionId}`;
		const internalKey = toSessionKey(rawNewKey);
		// 复用来源 env/repo（forkedSession 已在其中打开），直接挂 harness，不重建磁盘。
		await this.build(
			internalKey,
			{
				systemPrompt: source.basePrompt,
				workingDir: source.sessionMeta.cwd,
				canvasSessionId: source.canvasSessionId,
				userId: source.userId,
				thinkingLevel: source.thinkingLevel,
			},
			source.models,
			source.model,
			source.identity,
			{ env: source.env, repo: source.repo, session: forkedSession },
		);
		return { newKey: rawNewKey, newSessionId };
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
		// 官方模式：不再注入延迟工具索引块（名单会诱使弱模型直调未激活工具；
		// 发现能力由 tool_search 搜索语义承担，见 tools/tiering.ts 头注释）。
		return appendPromptBlocks(prompt, [index]);
	}

/** 工具分层（审计 P0-④，懒计算一次）：官方模式两件套 registered / activeToolNames。 */
	private toolEnsemble?: ReturnType<typeof buildToolEnsemble>;
	private getToolEnsemble(): ReturnType<typeof buildToolEnsemble> {
		if (!this.toolEnsemble) {
			// 构造入参类型是 AgentHarnessTool（无 tier 字段），生产链路传入的全部是
			// LnkpiTool（tools/config.ts 组装）；此处按 name 分档，字段消费只到 name/description。
			// 搜索语义观测（hit/miss/empty + 激活数）→ metrics；无 metrics 实例则不打点。
			this.toolEnsemble = buildToolEnsemble(
				[...this.tools, ...(this.skills?.tools ?? [])] as LnkpiTool[],
				this.config.toolTiering ?? true,
				this.metrics ? (outcome, activated) => this.metrics!.observeToolSearch(outcome, activated) : undefined,
			);
		}
		return this.toolEnsemble;
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

/** 队列入参非法（空文本等）：路由层映射 400，不进 503 混淆「下游不可用」。 */
export class InvalidInputError extends Error {
	constructor(message: string) {
		super(message);
	}
}

/** vendor 拒绝入队（Closed / InvalidMessage 等）：路由层按上游错误映射 503。 */
export class QueueRejectedError extends Error {
	constructor(id: string, detail: string) {
		super(`queue rejected (${detail}): ${id}`);
	}
}

/**
 * vendor `Result` 的 err 侧宽松取值。
 *
 * `lane.steer()` / `lane.followUp()` 返回的是 Result 而非抛异常，错误既可能是
 * `{_tag:"err", error: Error}`，也可能是裸字符串文案。这里逐个兜住，避免只处理一种形态
 * 导致另 50% 的情况退化成 "[object Object]" 的可观测性黑洞（历史教训：静默吞异常会让
 * 「插话没生效」这种事永远查不到）。
 */
function describeQueueError(err: unknown): string {
	const shaped = err as { message?: string; error?: unknown } | undefined;
	const inner = shaped?.error;
	if (inner instanceof Error) return inner.message;
	if (typeof inner === "string" && inner) return inner;
	return shaped?.message ?? String(err);
}

/** 同键并发 prompt：会话常驻后同一 harness 上两个 run 会交错，一律拒绝（路由层映射 409）。 */
export class BusyError extends Error {
	readonly reason: "running" | "compacting";

	constructor(id: string, reason: "running" | "compacting" = "running") {
		super(`session busy (${reason}): ${id}`);
		this.reason = reason;
	}
}

/** ③ 重跑：fork 切点 entry 在来源会话 main 分支上不存在（路由层映射 400）。 */
export class ForkTargetUnknownError extends Error {
	constructor(sessionId: string, entryId: string) {
		super(`fork target entry ${entryId} not found in session ${sessionId}`);
	}
}
