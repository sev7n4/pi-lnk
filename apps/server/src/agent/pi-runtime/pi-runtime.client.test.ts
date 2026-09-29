import { describe, expect, it, vi } from "vitest";
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
		// K-1：不带 llm 时 body 里不应出现该键（旧 pi-runtime 忽略未知字段，但保持干净）
		expect(body.llm).toBeUndefined();
	});

	it("hotfix：createSession 透传 canvasSessionId（画布会话 id 与 pi 会话键解耦）", async () => {
		// 回归锁（2026-09-29）：pi 会话键（第一个参数）可能是 `${画布id}:${后缀}` 的复合键，
		// 而工具要拿**画布** id 回查 Nest /agent/internal/*。必须单独透传，否则全部画布工具 404。
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push({ url, init: init as RequestInit });
				return new Response(JSON.stringify({ sessionId: "s1:t1", provider: "agnes", model: "m" }), {
					status: 201,
				});
			}) as typeof fetch,
		});
		await client.createSession("s1:t1", { canvasSessionId: "s1" });
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.sessionId).toBe("s1:t1");
		expect(body.canvasSessionId).toBe("s1");
	});

	it("hotfix：未传 canvasSessionId 时不发该字段（旧调用方 / 旧 runtime 兼容）", async () => {
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
		await client.createSession("s1", { systemPrompt: "SYS" });
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.canvasSessionId).toBeUndefined();
	});

	it("K-1：createSession 带 llm 时整体透传（含能力字段）", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push({ url, init: init as RequestInit });
				return new Response(JSON.stringify({ sessionId: "s1", provider: "byok-abc", model: "m" }), {
					status: 201,
				});
			}) as typeof fetch,
		});
		await client.createSession("s1", {
			llm: {
				model: "deepseek-flash",
				apiKey: "sk-SECRET",
				baseUrl: "https://api.deepseek.com/",
				providerRef: "ch_1::deepseek-flash",
				source: "user",
				reasoning: false,
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		});
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.llm).toEqual({
			model: "deepseek-flash",
			apiKey: "sk-SECRET",
			baseUrl: "https://api.deepseek.com/",
			providerRef: "ch_1::deepseek-flash",
			source: "user",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
	});

	it("红线⑤：createSession 失败时异常消息不含请求体（apiKey 不进日志）", async () => {
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as typeof fetch,
		});
		await expect(
			client.createSession("s1", {
				llm: {
					model: "deepseek-flash",
					apiKey: "sk-SECRET-DO-NOT-LEAK",
					baseUrl: "https://api.deepseek.com/",
					providerRef: "ch_1::deepseek-flash",
					source: "user",
				},
			}),
		).rejects.toThrow(/boom/);
		await expect(
			client.createSession("s1", {
				llm: {
					model: "deepseek-flash",
					apiKey: "sk-SECRET-DO-NOT-LEAK",
					baseUrl: "https://api.deepseek.com/",
					providerRef: "ch_1::deepseek-flash",
					source: "user",
				},
			}),
		).rejects.not.toThrow(/sk-SECRET-DO-NOT-LEAK/);
	});
});

describe("createSession 幂等契约（P0-①）", () => {
	it("201 status=created 与 200 status=resumed 都原样返回", async () => {
		const responses = [
			new Response(JSON.stringify({ sessionId: "s1:t1", provider: "agnes", model: "m", status: "created" }), {
				status: 201,
			}),
			new Response(
				JSON.stringify({ sessionId: "s1:t1", provider: "agnes", model: "m", status: "resumed", resumedFrom: "disk" }),
				{ status: 200 },
			),
		];
		let i = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async () => responses[i++]) as typeof fetch,
		});
		expect((await client.createSession("s1:t1")).status).toBe("created");
		expect((await client.createSession("s1:t1")).status).toBe("resumed");
	});

	it("rebuilt 原样返回（BYOK 身份变更重建）", async () => {
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ sessionId: "s1:t1", provider: "byok-abc", model: "m", status: "rebuilt" }), {
					status: 200,
				})) as typeof fetch,
		});
		expect((await client.createSession("s1:t1")).status).toBe("rebuilt");
	});

	it("旧 runtime 响应缺 status 时按 created 容错（灰度期不抛）", async () => {
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ sessionId: "s1:t1", provider: "agnes", model: "m" }), {
					status: 201,
				})) as typeof fetch,
		});
		expect((await client.createSession("s1:t1")).status).toBe("created");
	});

	it("4xx/5xx 仍抛 PiRuntimeError（含 409）", async () => {
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "session exists: s1:t1" }), { status: 409 })) as typeof fetch,
		});
		await expect(client.createSession("s1:t1")).rejects.toThrow(/session exists/);
	});

	it("已删除 createSessionReplacingStale（负例锁：不再有「删了重建」路径）", () => {
		const client = new PiRuntimeClient({ baseUrl: "http://x", fetchImpl: (async () => new Response()) as typeof fetch });
		expect((client as unknown as Record<string, unknown>).createSessionReplacingStale).toBeUndefined();
	});
});

describe("B8 pi-runtime client 杂项", () => {
	it("prompt 携带 forceSkills；listSkills 走 GET /skills", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push({ url, init: init as RequestInit });
				if ((init?.method ?? "GET") === "GET") {
					return new Response(
						JSON.stringify({ skills: [{ name: "x", description: "X skill" }] }),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({}), { status: 200 });
			}) as typeof fetch,
		});
		await client.prompt("s1", "hello", "main", { forceSkills: ["x"] });
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String(calls[0].init.body));
		expect(body).toEqual({ text: "hello", lane: "main", forceSkills: ["x"] });

		const skills = await client.listSkills();
		expect(calls).toHaveLength(2);
		expect(calls[1].init.method).toBe("GET");
		expect(calls[1].url).toMatch(/\/skills$/);
		expect(skills).toEqual({ skills: [{ name: "x", description: "X skill" }] });
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

describe("prompt 透传 turnContext（P0-①）", () => {
	it("body 带 turnContext；未传 forceSkills 时不发该字段", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push({ url, init: init as RequestInit });
				return new Response(JSON.stringify({ accepted: true }), { status: 202 });
			}) as typeof fetch,
		});
		await client.prompt("s1:t1", "你好", "main", {
			turnContext: { dynamicBlocks: ["CANVAS"], mentionedKeys: ["I1"] },
		});
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.turnContext.dynamicBlocks).toEqual(["CANVAS"]);
		expect(body.forceSkills).toBeUndefined();
	});

	it("未传 turnContext 时不发该字段（旧调用方兼容）", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push({ url, init: init as RequestInit });
				return new Response(JSON.stringify({ accepted: true }), { status: 202 });
			}) as typeof fetch,
		});
		await client.prompt("s1:t1", "你好");
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.turnContext).toBeUndefined();
		expect(body).toEqual({ text: "你好", lane: "main" });
	});

	it("202 视为成功；409 抛 PiRuntimeError（busy 可被上层识别）", async () => {
		const client = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async () => new Response(JSON.stringify({ accepted: true }), { status: 202 })) as typeof fetch,
		});
		await expect(client.prompt("s1:t1", "你好")).resolves.toBeUndefined();

		const busy = new PiRuntimeClient({
			baseUrl: "http://x",
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "session busy" }), { status: 409 })) as typeof fetch,
		});
		await expect(busy.prompt("s1:t1", "你好")).rejects.toThrow(/session busy/);
	});
});

describe("P0-③ streamEvents 断线重连", () => {
	const enc = new TextEncoder();
	/** 正常 SSE 响应：逐帧 enqueue 后正常关闭（clean end）。 */
	function sseResponse(frames: string[], status = 200): Response {
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const f of frames) controller.enqueue(enc.encode(f));
					controller.close();
				},
			}),
			{ status },
		);
	}
	/** 中途断流的 SSE 响应：先发帧，10ms 后断流（模拟已投递帧随后网络中断；error 与 enqueue 同步时 undici 会丢弃缓冲帧）。 */
	function brokenStreamResponse(frames: string[]): Response {
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const f of frames) controller.enqueue(enc.encode(f));
					setTimeout(() => controller.error(new TypeError("stream broken")), 10);
				},
			}),
			{ status: 200 },
		);
	}
	/** 对齐 pi-runtime /events 真实 wire format：NormalizedEvent = {type,lane,ts,seq,data}。 */
	const mkFrame = (id: number, type: string) =>
		`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({
			type,
			ts: 1,
			seq: id,
			data: { seq: id },
		})}\n\n`;

	it("断线后携带 lastEventId 重连，事件不丢不重", async () => {
		const calls: string[] = [];
		let attempt = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async (url: string) => {
				calls.push(url);
				attempt++;
				if (attempt === 1) return brokenStreamResponse([mkFrame(0, "agent_start")]);
				return sseResponse([mkFrame(1, "agent_end")]);
			}) as typeof fetch,
		});
		const seen: Array<{ seq?: number; type: string }> = [];
		const errors: unknown[] = [];
		const cancel = client.streamEvents(
			"s1",
			(e) => seen.push({ seq: e.seq, type: e.type }),
			(e) => errors.push(e),
		);
		await new Promise((r) => setTimeout(r, 400)); // 首次退避 250ms
		cancel();
		expect(seen.map((s) => s.type)).toEqual(["agent_start", "agent_end"]);
		expect(seen.map((s) => s.seq)).toEqual([0, 1]); // 顶层 seq（NormalizedEvent.seq）
		expect(errors).toHaveLength(0);
		expect(calls[1]).toMatch(/\/events\?lastEventId=0$/);
	});

	it("404 终止不重连（会话已删除属预期终态）", async () => {
		let calls = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async () => {
				calls++;
				return new Response("not found", { status: 404 });
			}) as typeof fetch,
		});
		const errors: unknown[] = [];
		const cancel = client.streamEvents("s1", () => {}, (e) => errors.push(e));
		await new Promise((r) => setTimeout(r, 50));
		cancel();
		expect(calls).toBe(1);
		expect(errors).toHaveLength(1);
	});

	it("body clean end 直接返回，不重连、不触发 onError（turn 结束语义）", async () => {
		let calls = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async () => {
				calls++;
				return sseResponse([mkFrame(0, "agent_start"), mkFrame(1, "agent_end")]);
			}) as typeof fetch,
		});
		const seen: string[] = [];
		const errors: unknown[] = [];
		const cancel = client.streamEvents(
			"s1",
			(e) => seen.push(e.type),
			(e) => errors.push(e),
		);
		await new Promise((r) => setTimeout(r, 100));
		cancel();
		expect(seen).toEqual(["agent_start", "agent_end"]);
		expect(errors).toHaveLength(0);
		expect(calls).toBe(1);
	});

	it("onEvent 回调异常不重试（重连会重放已处理事件 → 状态重复累积），终止并上报", async () => {
		let calls = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async () => {
				calls++;
				return sseResponse([mkFrame(0, "agent_start"), mkFrame(1, "agent_end")]);
			}) as typeof fetch,
		});
		const errors: unknown[] = [];
		const cancel = client.streamEvents(
			"s1",
			() => {
				throw new Error("consumer bug");
			},
			(e) => errors.push(e),
		);
		await new Promise((r) => setTimeout(r, 100));
		cancel();
		expect(calls).toBe(1); // 不重连
		expect(errors).toHaveLength(1); // 异常上报
	});

	it("parseSseFrames 捕获 id 字段（增量重连 offset 的数据源）", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode(mkFrame(5, "agent_start")));
				controller.close();
			},
		});
		const out: Array<{ id?: string }> = [];
		for await (const f of parseSseFrames(stream)) out.push(f as { id?: string });
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("5");
	});
});

describe("P0-③ 终审修复：重连预算按「连续失败窗口」计", () => {
	const enc = new TextEncoder();

	it("健康运行 130s 后断流仍重连（预算不从订阅起点计时）", async () => {
		vi.useFakeTimers();
		try {
			const calls: string[] = [];
			const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
			const enc2 = enc;
			const client = new PiRuntimeClient({
				baseUrl: "http://pi",
				fetchImpl: (async () => {
					calls.push("connect");
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controllers.push(controller);
								controller.enqueue(enc2.encode('id: 0\nevent: agent_start\ndata: {"type":"agent_start","ts":1,"seq":0}\n\n'));
								// 保持打开：模拟长任务期间连接一直健康
							},
						}),
						{ status: 200 },
					);
				}) as typeof fetch,
			});
			const errors: unknown[] = [];
			const cancel = client.streamEvents("s1", () => {}, (e) => errors.push(e));
			// 健康运行 130s（超过 120s 预算）
			await vi.advanceTimersByTimeAsync(130_000);
			expect(calls.length).toBe(1);
			// 断流 → 必须重连（修复前：deadline 已过 → 直接 504 终止）
			controllers[0]!.error(new TypeError("stream broken"));
			await vi.advanceTimersByTimeAsync(300); // 退避 250ms
			expect(calls.length).toBe(2);
			expect(errors).toHaveLength(0);
			cancel();
		} finally {
			vi.useRealTimers();
		}
	});

	it("持续网络失败 120s → 预算耗尽 onError(504) 终止（Review Focus 3）", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const client = new PiRuntimeClient({
				baseUrl: "http://pi",
				fetchImpl: (async () => {
					calls++;
					throw new TypeError("network down");
				}) as typeof fetch,
			});
			const errors: unknown[] = [];
			const cancel = client.streamEvents("s1", () => {}, (e) => errors.push(e));
			// 连续失败 120s+：退避 250ms→5s 封顶，有限次重试后 504
			await vi.advanceTimersByTimeAsync(130_000);
			expect(errors).toHaveLength(1);
			expect((errors[0] as { status?: number }).status).toBe(504);
			expect(calls).toBeGreaterThan(1);
			expect(calls).toBeLessThan(30); // 退避封顶保证有限次
			cancel();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("P0-A streamEvents live 订阅（跨轮重放修复）", () => {
	const enc = new TextEncoder();
	function sseResponse(frames: string[], status = 200): Response {
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const f of frames) controller.enqueue(enc.encode(f));
					controller.close();
				},
			}),
			{ status },
		);
	}
	const mkFrame = (id: number, type: string) =>
		`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ts: 1, seq: id, data: { seq: id } })}\n\n`;
	function urlsOf(framesFor: (attempt: number) => Response, count = 2): Promise<string[]> {
		return (async () => {
			const calls: string[] = [];
			let attempt = 0;
			const client = new PiRuntimeClient({
				baseUrl: "http://pi",
				fetchImpl: (async (url: string) => {
					calls.push(url);
					return framesFor(++attempt);
				}) as typeof fetch,
			});
			const cancel = client.streamEvents("s1", () => {}, () => {}, { live: true });
			await new Promise((r) => setTimeout(r, 400));
			cancel();
			return calls.slice(0, count);
		})();
	}

	it("live=true 首连带 ?from=now（只收未来事件，不重放上一轮缓冲）", async () => {
		const calls = await urlsOf(() => sseResponse([]), 1);
		expect(calls[0]).toBe("http://pi/sessions/s1/events?from=now");
	});

	it("live=true 断线重连改带 lastEventId，且不再叠加 from=now", async () => {
		// 必须用「断流」触发重连：clean close 会被视为 turn 结束而不重连（P0-③ 语义）
		const calls: string[] = [];
		let attempt = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async (url: string) => {
				calls.push(url);
				if (++attempt === 1) {
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(enc.encode(mkFrame(0, "agent_start")));
								setTimeout(() => controller.error(new TypeError("stream broken")), 10);
							},
						}),
						{ status: 200 },
					);
				}
				return sseResponse([mkFrame(1, "agent_end")]);
			}) as typeof fetch,
		});
		const cancel = client.streamEvents("s1", () => {}, () => {}, { live: true });
		await new Promise((r) => setTimeout(r, 400)); // 首次退避 250ms
		cancel();
		expect(calls[0]).toBe("http://pi/sessions/s1/events?from=now");
		expect(calls[1]).toBe("http://pi/sessions/s1/events?lastEventId=0");
	});

	it("live 缺省（旧调用方）首连不带 query，行为不变", async () => {
		const calls: string[] = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async (url: string) => {
				calls.push(url);
				return sseResponse([]);
			}) as typeof fetch,
		});
		const cancel = client.streamEvents("s1", () => {});
		await new Promise((r) => setTimeout(r, 80));
		cancel();
		expect(calls[0]).toBe("http://pi/sessions/s1/events");
	});
});
