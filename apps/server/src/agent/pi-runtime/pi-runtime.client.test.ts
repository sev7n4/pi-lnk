import { describe, expect, it } from "vitest";
import {
	extractTextDelta,
	mapPiEventToUiEvent,
	type PiRuntimeEvent,
} from "./pi-events";
import { parseSseFrames, PiRuntimeClient } from "./pi-runtime.client";

const baseEvent = (type: PiRuntimeEvent["type"], data: unknown): PiRuntimeEvent => ({
	type,
	lane: "main",
	ts: 1_700_000_000_000,
	data,
});

describe("B8 事件映射（11 → 现有 UI 事件，spec §8.5.2 最小集）", () => {
	it("message_update 的文本 delta → text_delta（实测形态：字段 event，类型 text_delta）", () => {
		const evt = baseEvent("message_update", {
			event: { type: "text_delta", delta: "你好" },
		});
		expect(mapPiEventToUiEvent(evt)).toEqual({ type: "text_delta", data: { text: "你好" } });
	});

	it("message_update thinking delta → null（Round 5 决定 UI 事件）", () => {
		const evt = baseEvent("message_update", {
			event: { type: "thinking_delta", delta: "..." },
		});
		expect(extractTextDelta(evt)).toBeNull();
		expect(mapPiEventToUiEvent(evt)).toBeNull();
	});

	it("兼容底层 Agent.subscribe() 字段名 assistantMessageEvent（type: text_delta）", () => {
		const evt = baseEvent("message_update", {
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		});
		expect(extractTextDelta(evt)).toBe("hi");
	});

	it("tool_execution_start → tool_call；end → tool_result（isError 透传）", () => {
		const start = mapPiEventToUiEvent(
			baseEvent("tool_execution_start", { toolCallId: "t1", toolName: "canvas_draft", args: {} }),
		);
		expect(start?.type).toBe("tool_call");
		const end = mapPiEventToUiEvent(
			baseEvent("tool_execution_end", {
				toolCallId: "t1",
				toolName: "canvas_draft",
				result: { ok: true },
				isError: false,
			}),
		);
		expect(end?.type).toBe("tool_result");
		expect((end!.data as { isError: boolean }).isError).toBe(false);
	});

	it("agent_end → done（status 透传）", () => {
		const evt = mapPiEventToUiEvent(baseEvent("agent_end", { status: "completed" }));
		expect(evt?.type).toBe("done");
		expect((evt!.data as { status: string }).status).toBe("completed");
	});

	it("未映射事件 pi_ 前缀透传", () => {
		const evt = mapPiEventToUiEvent(baseEvent("turn_start", { runId: "r1" }));
		expect(evt?.type).toBe("pi_turn_start");
	});
});

describe("B8 SSE 帧解析", () => {
	function sseStream(frames: string[]): ReadableStream<Uint8Array> {
		const enc = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				for (const f of frames) controller.enqueue(enc.encode(f));
				controller.close();
			},
		});
	}

	it("解析 event/data 帧、忽略注释帧、跨 chunk 缓冲", async () => {
		const stream = sseStream([
			"event: agent_start\ndata: {\"type\":\"agent_start\"}\n\n",
			": heartbeat\n\n",
			"event: message_up",
			"date\ndata: {\"type\":\"message_update\"}\n\nevent: agent_end\ndata: {\"type\":\"agent_end\"}\n\n",
		]);
		const out = [];
		for await (const frame of parseSseFrames(stream)) out.push(frame);
		expect(out).toHaveLength(3);
		expect(out[0].event).toBe("agent_start");
		expect(out[1].event).toBe("message_update");
		expect(out[2].event).toBe("agent_end");
	});
});

describe("B8 PiRuntimeClient", () => {
	it("healthz 失败返回 null（不抛错，对齐老 runtime health 语义）", async () => {
		const client = new PiRuntimeClient({
			baseUrl: "http://pi-runtime:8100",
			fetchImpl: (async () => {
				throw new Error("ECONNREFUSED");
			}) as typeof fetch,
		});
		await expect(client.healthz()).resolves.toBeNull();
	});

	it("createSession 201 透传；非 201 抛 PiRuntimeError", async () => {
		const ok = new Response(JSON.stringify({ sessionId: "s1", provider: "agnes", model: "agnes-2.5-pro" }), {
			status: 201,
		});
		const client = new PiRuntimeClient({ baseUrl: "http://x", fetchImpl: (async () => ok) as typeof fetch });
		await expect(client.createSession("s1")).resolves.toMatchObject({ provider: "agnes" });

		const conf = new Response(JSON.stringify({ error: "session exists: s1" }), { status: 409 });
		const client2 = new PiRuntimeClient({ baseUrl: "http://x", fetchImpl: (async () => conf) as typeof fetch });
		await expect(client2.createSession("s1")).rejects.toThrow(/session exists/);
	});

	it("createSession 以 opts 对象透传 systemPrompt/userId/画布上下文", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push({ url, init: init as RequestInit });
				return new Response(JSON.stringify({ sessionId: "s1", provider: "agnes", model: "m" }), {
					status: 201,
				});
			}) as typeof fetch,
		});
		await client.createSession("s1", {
			systemPrompt: "SYS",
			userId: "u1",
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
			mentionedKeys: ["I1"],
			refOrder: ["I1"],
			focusNodeId: "node-1",
		});
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.systemPrompt).toBe("SYS");
		expect(body.userId).toBe("u1");
		expect(body.mentionedKeys).toEqual(["I1"]);
		expect(body.focusNodeId).toBe("node-1");
		expect(body.attachments).toEqual([{ url: "https://x/a.png", mediaType: "image" }]);
	});
});

describe("createSessionReplacingStale（409 竞态修复）", () => {
	/** 上一轮 DELETE 与本轮 create 竞态会撞 409；静默复用旧会话会把上一轮的
	 *  事件缓冲回放给本轮 SSE（2026-09-24 生产实测），必须删除后重建。 */
	it("首次 409 → DELETE 陈旧会话 → 重建成功", async () => {
		const calls: string[] = [];
		let attempt = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push(`${method} ${url}`);
				if (method === "POST") {
					attempt += 1;
					if (attempt === 1) {
						return new Response(JSON.stringify({ error: "session exists: s1" }), { status: 409 });
					}
					return new Response(JSON.stringify({ sessionId: "s1", provider: "agnes", model: "m" }), {
						status: 201,
					});
				}
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		});
		await expect(client.createSessionReplacingStale("s1", { systemPrompt: "SYS" })).resolves.toMatchObject({
			provider: "agnes",
		});
		expect(calls).toEqual(["POST http://x/sessions", "DELETE http://x/sessions/s1", "POST http://x/sessions"]);
	});

	it("非 409 错误直接抛出（不误删会话）", async () => {
		const calls: string[] = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push(`${init?.method ?? "GET"} ${url}`);
				return new Response(JSON.stringify({ error: "missing credentials" }), { status: 503 });
			}) as typeof fetch,
		});
		await expect(client.createSessionReplacingStale("s1")).rejects.toThrow(/missing credentials/);
		expect(calls).toEqual(["POST http://x/sessions"]);
	});

	it("409 清理路径 deleteSession 失败不抛：吞掉重试 create，仍 409 才抛冲突", async () => {
		const calls: string[] = [];
		let attempt = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push(`${method} ${url}`);
				if (method === "DELETE") return new Response(null, { status: 400 });
				attempt += 1;
				if (attempt === 1) {
					return new Response(JSON.stringify({ error: "session exists: s1" }), { status: 409 });
				}
				return new Response(JSON.stringify({ sessionId: "s1", provider: "agnes", model: "m" }), {
					status: 201,
				});
			}) as typeof fetch,
		});
		await expect(client.createSessionReplacingStale("s1")).resolves.toMatchObject({ provider: "agnes" });
		expect(calls).toEqual(["POST http://x/sessions", "DELETE http://x/sessions/s1", "POST http://x/sessions"]);
	});

	it("409 清理后 create 仍 409 → 抛明确冲突错误", async () => {
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
				return new Response(JSON.stringify({ error: "session exists: s1" }), { status: 409 });
			}) as typeof fetch,
		});
		await expect(client.createSessionReplacingStale("s1")).rejects.toThrow(/still conflicts/);
	});

	it("DELETE 不携带 content-type（空 body + json header 会 400）；POST 带", async () => {
		// 生产实测（2026-09-24）：Fastify 对「空 body + application/json」一律 400，
		// 导致 DELETE /sessions/:id 从未成功 → 会话泄漏 → 每轮 create 撞 409。
		const seen: Array<{ method: string; contentType?: string }> = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				seen.push({ method: init?.method ?? "GET", contentType: headers["content-type"] });
				if ((init?.method ?? "") === "DELETE") return new Response(null, { status: 204 });
				return new Response(JSON.stringify({ sessionId: "s1", provider: "agnes", model: "m" }), {
					status: 201,
				});
			}) as typeof fetch,
		});
		await client.deleteSession("s1");
		await client.createSession("s2", { systemPrompt: "SYS" });
		expect(seen[0]).toEqual({ method: "DELETE", contentType: undefined });
		expect(seen[1]).toEqual({ method: "POST", contentType: "application/json" });
	});
});
