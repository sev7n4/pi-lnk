/**
 * B8：Nest ↔ pi-runtime RPC 客户端（spec §6.2.0 B8）
 *
 * 轻量 fetch 封装（无 SDK 依赖），SSE 解析为手工帧处理：
 *   `event: <type>\n` + `data: <json>\n\n`，`: heartbeat` 注释帧忽略。
 *
 * D-ζ' 回退语义：老 agent-runtime（:8000）与 pi-runtime（:8100）迁移期共存，
 * 本客户端不持有全局状态，调用方（B4 Nest L6 入口）按开关选择 runtime。
 */
import type { PiRuntimeEvent } from "./pi-events";

export interface PiRuntimeClientOptions {
	baseUrl: string;
	fetchImpl?: typeof fetch;
	/** 请求超时（ms），默认 10s；SSE 流式请求不受此限制 */
	timeoutMs?: number;
}

export interface CreateSessionResult {
	sessionId: string;
	provider: string;
	model: string;
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
			}),
		});
		if (status !== 201 || !body || body.error) {
			throw new PiRuntimeError(body?.error ?? `createSession failed: HTTP ${status}`, status);
		}
		return body;
	}

	/**
	 * 创建会话；若已存在（409，通常是上一轮 DELETE 未生效的竞态）则
	 * **删除陈旧会话后重建**，而非静默复用。
	 *
	 * 复用旧会话有两个实测危害（2026-09-24 生产 e2e 定位）：
	 *  ① systemPrompt 陈旧（本轮画布上下文/规则不生效）；
	 *  ② pi-runtime 订阅语义会把旧会话的**事件缓冲回放**给新订阅者 →
	 *     本轮 SSE 收到上一轮的事件流（模型表现为"复述上一轮"）。
	 *
	 * 409 清理路径的 deleteSession 失败不直接抛——吞掉后重试 create，仍 409
	 * 才抛明确冲突。非 409 错误直接抛出，不误删会话。
	 */
	async createSessionReplacingStale(
		sessionId: string,
		opts: CreateSessionOptions = {},
	): Promise<CreateSessionResult> {
		try {
			return await this.createSession(sessionId, opts);
		} catch (err) {
			if (!(err instanceof PiRuntimeError) || err.status !== 409) throw err;
			await this.deleteSession(sessionId).catch(() => {});
			try {
				return await this.createSession(sessionId, opts);
			} catch (retryErr) {
				if (retryErr instanceof PiRuntimeError && retryErr.status === 409) {
					throw new PiRuntimeError(
						`session ${sessionId} still conflicts after stale cleanup`,
						409,
					);
				}
				throw retryErr;
			}
		}
	}

	async prompt(
		sessionId: string,
		text: string,
		lane = "main",
		opts?: { forceSkills?: string[] },
	): Promise<void> {
		const { status, body } = await this.request<{ error?: string }>(
			`/sessions/${encodeURIComponent(sessionId)}/prompt`,
			{
				method: "POST",
				body: JSON.stringify({
					text,
					lane,
					...(opts?.forceSkills?.length ? { forceSkills: opts.forceSkills } : {}),
				}),
			},
		);
		if (status !== 200 || body?.error) {
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
	streamEvents(
		sessionId: string,
		onEvent: (event: PiRuntimeEvent) => void,
		onError?: (err: unknown) => void,
	): () => void {
		const controller = new AbortController();
		void (async () => {
			try {
				const res = await this.fetchImpl(
					`${this.options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`,
					{ signal: controller.signal },
				);
				if (!res.ok || !res.body) {
					throw new PiRuntimeError(`streamEvents failed: HTTP ${res.status}`, res.status);
				}
				for await (const frame of parseSseFrames(res.body)) {
					if (frame.event && frame.data !== undefined) {
						onEvent({ ...(frame.data as Omit<PiRuntimeEvent, never>) });
					}
				}
			} catch (err) {
				if (!controller.signal.aborted) onError?.(err);
			}
		})();
		return () => controller.abort();
	}
}

interface SseFrame {
	event?: string;
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
	let data: string | undefined;
	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) continue; // heartbeat 注释帧
		if (line.startsWith("event:")) event = line.slice(6).trim();
		if (line.startsWith("data:")) data = line.slice(5).trim();
	}
	if (data === undefined) return null;
	return { event, data: JSON.parse(data) as unknown };
}
