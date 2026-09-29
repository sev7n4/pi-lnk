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

	async deleteSession(sessionId: string): Promise<void> {
		const { status } = await this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
		});
		if (status !== 204 && status !== 404) {
			throw new PiRuntimeError(`deleteSession failed: HTTP ${status}`, status);
		}
	}

	/**
	 * 订阅会话事件流（SSE）。
	 * @returns 取消函数：断开 HTTP 连接但不影响服务端会话
	 */
	/**
	 * 订阅会话事件流（SSE，内置断线重连）。
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
				const url =
					`${this.options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events` +
					(lastEventId !== undefined ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "");
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
