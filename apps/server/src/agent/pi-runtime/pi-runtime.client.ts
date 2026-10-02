/**
 * B8：Nest ↔ pi-runtime RPC 客户端（spec §6.2.0 B8）
 *
 * 轻量 fetch 封装（无 SDK 依赖），SSE 解析为手工帧处理：
 *   `event: <type>\n` + `data: <json>\n\n`，`: heartbeat` 注释帧忽略。
 *
 * D-ζ' 回退语义：老 agent-runtime（:8000）与 pi-runtime（:8100）迁移期共存，
 * 本客户端不持有全局状态，调用方（B4 Nest L6 入口）按开关选择 runtime。
 */
import type { SidebarAttachment } from "@lnkpi/shared";
import type { PiRuntimeEvent } from "./pi-events";

export interface PiRuntimeClientOptions {
	baseUrl: string;
	fetchImpl?: typeof fetch;
	/** 请求超时（ms），默认 10s；SSE 流式请求不受此限制 */
	timeoutMs?: number;
}

/**
 * P0-① 会话 create 三态：
 *  - created：新建；resumed：复用（内存或磁盘，语义由 pi-runtime 内部判定）；rebuilt：身份变更后重建。
 *  `resumedFrom` 仅 status=resumed 时存在（memory=内存快路径 / disk=repo.open 恢复），观测用。
 */
export type PiSessionCreateStatus = "created" | "resumed" | "rebuilt";

export interface CreateSessionResult {
	sessionId: string;
	provider: string;
	model: string;
	status: PiSessionCreateStatus;
	resumedFrom?: "memory" | "disk";
}

/** 每轮易变上下文（spec §5.3 T 层）：随 prompt 携带，不进对话历史、不参与静态段。 */
export interface PiTurnContext {
	dynamicBlocks?: string[];
	attachments?: SidebarAttachment[];
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
}

/** K-1：会话级 LLM 覆盖（BYOK）。与 pi-runtime `SessionLlmOverride` 同构。
 * apiKey 明文仅在 Nest→pi-runtime 的 loopback/内网请求体中出现，不落盘、不入日志。 */
export interface PiSessionLlmOverride {
	model: string;
	apiKey: string;
	baseUrl: string;
	providerRef: string;
	source: "user" | "platform";
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

/** #12：/sessions 全量可选字段（pi-runtime 侧原样透传进 toolContext）。 */
export interface CreateSessionOptions {
	systemPrompt?: string;
	userId?: string;
	attachments?: Array<{ url?: string; text?: string; mediaType?: string }>;
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
	thinkingLevel?: "off" | "medium" | "high";
	/** K-1：BYOK 覆盖；不传则 pi-runtime 走 env 装配 */
	llm?: PiSessionLlmOverride;
	/**
	 * 画布会话 id（= Nest `Session.id`，即 prisma 主键）。
	 *
	 * ⚠️ 与第一个参数 `sessionId`（pi 会话键）**不是**一回事：`sessionId` 是
	 * `threadId || 画布id` 的复合键，pi-runtime 会把它哈希成 `toSessionKey()` 当持久化目录名；
	 * 而 pi-runtime 侧的工具经 `toolContext.sessionId` 拿到的东西会被原样发回 Nest
	 * `/api/agent/internal/*`，Nest 直接拿它 `prisma.session.findUnique({id})` 查**画布**会话。
	 * 因此这里必须显式把画布 id 单独传过去，否则全部画布工具 404（2026-09-29 hotfix）。
	 */
	canvasSessionId?: string;
}

/**
 * 队列消息的**事实标记**（2026-10-02）：steer / followUp 落到 vendor lane 的都是普通 user 消息
 * （`lane.ts:1456-1460` 两者在 `enqueue` 里构造的是同一个载荷），而它们的送达时机差着好几秒到几十秒
 * —— steer 插在本轮回答进行中、followUp 等到收尾边界。模型看不出区别，自然也就不会重新规划。
 *
 * 所以在这里给**这一条**消息加一行 kind 标签：**信息，不是命令**。
 *  - 信息（这里）：告诉模型「这条消息是什么来头 / 什么时候到的」→ 它才会真的重新评估执行计划；
 *  - 命令（原先走 system prompt 的做法）：「你必须先复述…再调工具」→ 概率行为、每轮常驻、
 *    而且只会逼出空洞的复述体。2026-10-02 已把那段 `QUEUE_GUIDANCE` 从 system prompt 里删掉。
 *
 * 加在 Nest 这一层（而不是 pi-runtime 的 `session-manager.steer/followUp`）是有意的：
 * 只影响这一条消息，常态 context 零增加，且 **pi-runtime 无需重新部署**。
 *
 * ⚠️ 刻意保持"标签"而非"长指令前缀"：vendor 侧的原话顾虑是污染用户自己写的原话——
 * 回看会话历史时那串东西是噪音。一行方括号标签不是这个问题，别再加长。
 */
export const QUEUE_MARK: Record<"steer" | "followup", string> = {
	steer: "[用户补充 · 插在本轮回答进行中]",
	followup: "[用户补充 · 将在本轮收尾后接上]",
};

export class PiRuntimeError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export class PiRuntimeClient {
	private readonly fetchImpl: typeof fetch;

	constructor(readonly options: PiRuntimeClientOptions) {
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private async request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
		try {
			// content-type 仅在有 body 时携带：Fastify 对「空 body + application/json」
			// 直接 400（Body cannot be empty...），DELETE 这类无 body 请求必须不带
			// 该 header——2026-09-24 生产实测，此 bug 使 DELETE 全部 400 → 会话泄漏。
			const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
			if (init?.body && !headers["content-type"]) headers["content-type"] = "application/json";
			const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
				...init,
				signal: controller.signal,
				headers,
			});
			const text = await res.text();
			const body = text ? (JSON.parse(text) as T) : null;
			return { status: res.status, body };
		} finally {
			clearTimeout(timer);
		}
	}

	async healthz(): Promise<{ status: string; sessions: number } | null> {
		try {
			const { status, body } = await this.request<{ status: string; sessions: number }>("/healthz");
			return status === 200 ? body : null;
		} catch {
			return null; // health 探测失败返回 null（对齐老 AGENT_RUNTIME_URL health 语义）
		}
	}

	/**
	 * 幂等 create（P0-①）：同 threadKey 重复调用返回既有会话（200 `status=resumed`），
	 * 不再需要「409 → 删了重建」。旧 runtime（无 status 字段）按 `created` 容错。
	 */
	async createSession(sessionId: string, opts: CreateSessionOptions = {}): Promise<CreateSessionResult> {
		const { status, body } = await this.request<CreateSessionResult & { error?: string }>("/sessions", {
			method: "POST",
			body: JSON.stringify({
				sessionId,
				systemPrompt: opts.systemPrompt,
				userId: opts.userId,
				attachments: opts.attachments,
				mentionedKeys: opts.mentionedKeys,
				refOrder: opts.refOrder,
				focusNodeId: opts.focusNodeId,
				...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
				// K-1：BYOK 覆盖（不传则 pi-runtime 走 env 装配）
				...(opts.llm ? { llm: opts.llm } : {}),
				// 画布会话 id（与上面的 pi 会话键解耦，见 CreateSessionOptions.canvasSessionId）
				...(opts.canvasSessionId ? { canvasSessionId: opts.canvasSessionId } : {}),
			}),
		});
		if (status >= 400 || !body || body.error) {
			throw new PiRuntimeError(body?.error ?? `createSession failed: HTTP ${status}`, status);
		}
		// 灰度期兼容：旧 runtime 只回 {sessionId, provider, model}，缺失 status 一律按 created。
		const parsedStatus: PiSessionCreateStatus =
			body.status === "resumed" || body.status === "rebuilt" ? body.status : "created";
		return { ...body, status: parsedStatus };
	}

	async prompt(
		sessionId: string,
		text: string,
		lane = "main",
		opts?: { forceSkills?: string[]; turnContext?: PiTurnContext },
	): Promise<void> {
		const { status, body } = await this.request<{ error?: string }>(
			`/sessions/${encodeURIComponent(sessionId)}/prompt`,
			{
				method: "POST",
				body: JSON.stringify({
					text,
					lane,
					...(opts?.forceSkills?.length ? { forceSkills: opts.forceSkills } : {}),
					...(opts?.turnContext ? { turnContext: opts.turnContext } : {}),
				}),
			},
		);
		// pi-runtime ≥ P0-① 返回 202；旧 runtime 返回 200——两者都视为成功。
		if (status >= 400 || body?.error) {
			throw new PiRuntimeError(body?.error ?? `prompt failed: HTTP ${status}`, status);
		}
	}

	/**
	 * 用户插话（steering 队列）：run 进行中发言的正道（2026-10-02）。
	 *
	 * 与 `prompt()` 的差别是**失败语义**：`prompt()` 撞 busy 会 409 抛错，而插话恰恰是在
	 * 「上一轮还在跑」这个前提下才需要它 —— 所以这里入队失败就抛，由调用方决定怎么收。
	 *
	 * @returns `queued: true`（已进 vendor 队列，durable 落盘）
	 */
	async steer(
		sessionId: string,
		text: string,
		lane = "main",
		opts?: { turnContext?: PiTurnContext },
	): Promise<{ queued: boolean }> {
		return this.queue(sessionId, text, "steer", lane, opts);
	}

	/** 尾随指令（followUp 队列）：run 收尾时再接一句，由 vendor 同一次 run 续跑一代。 */
	async followUp(
		sessionId: string,
		text: string,
		lane = "main",
		opts?: { turnContext?: PiTurnContext },
	): Promise<{ queued: boolean }> {
		return this.queue(sessionId, text, "followup", lane, opts);
	}

	private async queue(
		sessionId: string,
		text: string,
		path: "steer" | "followup",
		lane: string,
		opts?: { turnContext?: PiTurnContext },
	): Promise<{ queued: boolean }> {
		const { status, body } = await this.request<{ queued?: boolean; error?: string }>(
			`/sessions/${encodeURIComponent(sessionId)}/${path}`,
			{
				method: "POST",
				body: JSON.stringify({
					text: QUEUE_MARK[path] + "\n" + text,
					lane,
					...(opts?.turnContext ? { turnContext: opts.turnContext } : {}),
				}),
			},
		);
		if (status >= 400 || body?.error) {
			throw new PiRuntimeError(body?.error ?? `${path} failed: HTTP ${status}`, status);
		}
		return { queued: body?.queued !== false };
	}

	/**
	 * ③ 重跑：后端线程截断（与 WorkBuddy「编辑并重发」一致）。
	 *
	 * 以 `atEntryId` 为切点 fork 出一条新分支会话：目标消息及其之后全部丢弃（`position: "before"`），
	 * 之后的新 run 从切点父节点续写。来源会话不动。
	 *
	 * @returns `newKey` = 新会话的**原始** threadKey —— 后续所有调用（prompt / events /
	 * create / abort）都要用它作为 sessionId；pi-runtime 内部 `toSessionKey` 会推导回
	 * 同一内存键（绝不可二次哈希）。
	 */
	async forkSession(
		sessionId: string,
		atEntryId: string,
		opts?: { canvasSessionId?: string; thinkingLevel?: "off" | "medium" | "high" },
	): Promise<{ newKey: string; newSessionId: string }> {
		const { status, body } = await this.request<{
			newKey: string;
			newSessionId: string;
			error?: string;
		}>(`/sessions/${encodeURIComponent(sessionId)}/fork`, {
			method: "POST",
			body: JSON.stringify({
				atEntryId,
				// 分支会话仍属同一画布：工具回查 Nest 需要画布会话 id（2026-09-29 hotfix 语义）
				...(opts?.canvasSessionId ? { canvasSessionId: opts.canvasSessionId } : {}),
				...(opts?.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
			}),
		});
		if (status >= 400 || !body || body.error || !body.newKey) {
			throw new PiRuntimeError(body?.error ?? `forkSession failed: HTTP ${status}`, status);
		}
		return { newKey: body.newKey, newSessionId: body.newSessionId };
	}

	async listSkills(): Promise<{ skills: Array<{ name: string; description: string }> }> {
		const { status, body } = await this.request<{
			skills?: Array<{ name: string; description: string }>;
		}>("/skills", { method: "GET" });
		if (status >= 400) {
			throw new PiRuntimeError(`listSkills failed: HTTP ${status}`, status);
		}
		return { skills: body?.skills ?? [] };
	}

	/**
	 * 中断会话当前正在跑的 run（前端「停止」按钮走这条）。
	 * 会话保留——用户可接着发新消息；pi-runtime 侧无活跃 run 时 skipped=true。
	 */
	async abortRun(sessionId: string): Promise<{ ok: boolean; skipped: boolean }> {
		const { status, body } = await this.request<{ ok?: boolean; skipped?: boolean }>(
			`/sessions/${encodeURIComponent(sessionId)}/abort`,
			{ method: "POST" },
		);
		if (status >= 400) {
			throw new PiRuntimeError(`abortRun failed: HTTP ${status}`, status);
		}
		return { ok: body?.ok === true, skipped: body?.skipped === true };
	}

	/** B-2：向阻塞中的确认类工具提交用户回答（幂等；未知/已清理 callId 返回 deduped=true）。 */
	async answer(
		sessionId: string,
		body: { callId: string; answers: Record<string, string[]> },
	): Promise<{ ok: boolean; deduped: boolean }> {
		const { status, body: resp } = await this.request<{ ok?: boolean; deduped?: boolean; error?: string }>(
			`/sessions/${encodeURIComponent(sessionId)}/answers`,
			{ method: "POST", body: JSON.stringify(body) },
		);
		if (status >= 400 || resp?.error) {
			throw new PiRuntimeError(resp?.error ?? `answer failed: HTTP ${status}`, status);
		}
		return { ok: resp?.ok === true, deduped: resp?.deduped === true };
	}

	/** B-2：查询会话是否有阻塞中的确认类工具（前端 409 降级恢复用）。 */
	async getPending(sessionId: string): Promise<{ callId: string; toolName: string } | null> {
		const { status, body } = await this.request<{ pending?: { callId: string; toolName: string } | null }>(
			`/sessions/${encodeURIComponent(sessionId)}/pending`,
			{ method: "GET" },
		);
		if (status >= 400) return null; // 查询失败按无 pending（降级路径，不抛错阻断对话）
		return body?.pending ?? null;
	}

	async deleteSession(sessionId: string): Promise<void> {
		const { status } = await this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
		});
		if (status !== 204 && status !== 404) {
			throw new PiRuntimeError(`deleteSession failed: HTTP ${status}`, status);
		}
	}

	/**
	 * 订阅会话事件流（SSE，内置断线重连）。
	 *
	 * 首连语义（P0-A，2026-09-29）：`opts.live = true` → 首连带 `?from=now`，
	 * 只收**未来**事件、不重放历史缓冲。持久会话的 buffer 跨轮累积，若首轮订阅全量重放，
	 * 客户端会先收到上一轮全部事件（含其 `agent_end`）→ 本轮回答被上一轮顶替。
	 * 断线重连仍走 `?lastEventId=`（P0-③），与 live 互不叠加（服务端 lastEventId 优先）。
	 *
	 * 重连语义（P0-③）：
	 *  - 网络错误 / 非 404 HTTP 错误：250ms 起指数退避（封顶 5s），总预算 120s；
	 *  - 重连请求携带 ?lastEventId=<最后收到的 seq>，服务端增量重放（需 pi-runtime ≥ 对应版本）；
	 *  - HTTP 404（会话已删除）：终止并回调 onError（本轮 turn 已结束，属预期）；
	 *  - body clean end（服务端正常关闭）：直接返回，不重连、不回调 onError。
	 *  - 返回的取消函数随时可调；取消后不再重连。
	 */
	streamEvents(
		sessionId: string,
		onEvent: (event: PiRuntimeEvent) => void,
		onError?: (err: unknown) => void,
		opts?: { live?: boolean },
	): () => void {
		const controller = new AbortController();
		const RECONNECT_BUDGET_MS = 120_000;
		void (async () => {
			let lastEventId: string | undefined;
			let backoff = 250;
			// 预算按「连续失败窗口」计（终审修复）：连接成功即清零。若从订阅起点绝对计时，
			// 健康运行 >120s 的长任务断线后将零次重连——恰是本特性最需要覆盖的场景。
			let firstFailureAt: number | undefined;
			while (!controller.signal.aborted) {
				// 首连（P0-A）：live=true → `from=now`（只收未来事件，不重放上一轮缓冲）。
				// 重连：带 lastEventId 断点续传（P0-③），不再叠加 from=now（服务端 lastEventId 优先）。
				const query =
					lastEventId !== undefined
						? `lastEventId=${encodeURIComponent(lastEventId)}`
						: opts?.live
							? "from=now"
							: "";
				const url =
					`${this.options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events` +
					(query ? `?${query}` : "");
				try {
					const res = await this.fetchImpl(url, { signal: controller.signal });
					if (res.status === 404) {
						throw new PiRuntimeError("streamEvents: session not found", 404);
					}
					if (!res.ok || !res.body) {
						throw new PiRuntimeError(`streamEvents failed: HTTP ${res.status}`, res.status);
					}
					backoff = 250; // 连接成功即重置退避与失败窗口
					firstFailureAt = undefined;
					for await (const frame of parseSseFrames(res.body)) {
						if (frame.id !== undefined) lastEventId = frame.id;
						if (frame.event && frame.data !== undefined) {
							try {
								onEvent(frame.data as PiRuntimeEvent);
							} catch (err) {
								// 回调侧异常不可当网络错误重试——重连会重放已处理事件，
								// 导致 Nest 侧 canvasActions/usage 重复累积。终止并上报。
								onError?.(err);
								return;
							}
						}
					}
					return; // body clean end = 会话删除/turn 结束：不重连
				} catch (err) {
					if (controller.signal.aborted) return;
					if (err instanceof PiRuntimeError && err.status === 404) {
						onError?.(err);
						return;
					}
					if (firstFailureAt === undefined) firstFailureAt = Date.now();
					else if (Date.now() - firstFailureAt >= RECONNECT_BUDGET_MS) {
						onError?.(new PiRuntimeError("streamEvents: reconnect budget exhausted", 504));
						return;
					}
					await new Promise((r) => setTimeout(r, backoff));
					backoff = Math.min(backoff * 2, 5_000);
				}
			}
		})();
		return () => controller.abort();
	}
}

interface SseFrame {
	event?: string;
	id?: string;
	data?: unknown;
}

/** 把 SSE 字节流解析为帧序列（async generator，方便 for-await 消费）。 */
export async function* parseSseFrames(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.indexOf("\n\n")) !== -1) {
				const raw = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const frame = parseFrame(raw);
				if (frame) yield frame;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseFrame(raw: string): SseFrame | null {
	let event: string | undefined;
	let id: string | undefined;
	let data: string | undefined;
	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) continue; // heartbeat 注释帧
		if (line.startsWith("event:")) event = line.slice(6).trim();
		if (line.startsWith("id:")) id = line.slice(3).trim();
		if (line.startsWith("data:")) data = line.slice(5).trim();
	}
	if (data === undefined) return null;
	return { event, id, data: JSON.parse(data) as unknown };
}
