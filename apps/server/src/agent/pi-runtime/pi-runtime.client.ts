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

/** #12：/sessions 全量可选字段（pi-runtime 侧原样透传进 toolContext）。 */
export interface CreateSessionOptions {
	systemPrompt?: string;
	userId?: string;
	attachments?: Array<{ url?: string; text?: string; mediaType?: string }>;
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
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
			const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
				...init,
				signal: controller.signal,
				headers: { "content-type": "application/json", ...init?.headers },
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
			}),
		});
		if (status !== 201 || !body || body.error) {
			throw new PiRuntimeError(body?.error ?? `createSession failed: HTTP ${status}`, status);
		}
		return body;
	}

	async prompt(sessionId: string, text: string, lane = "main"): Promise<void> {
		const { status, body } = await this.request<{ error?: string }>(
			`/sessions/${encodeURIComponent(sessionId)}/prompt`,
			{ method: "POST", body: JSON.stringify({ text, lane }) },
		);
		if (status !== 200 || body?.error) {
			throw new PiRuntimeError(body?.error ?? `prompt failed: HTTP ${status}`, status);
		}
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
