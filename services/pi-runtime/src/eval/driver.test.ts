import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { runEvalCase } from "./driver.js";

/**
 * HTTP 驱动层测试（不起真 LLM，用假 server 验协议与折叠）。
 *
 * ⭐ 为什么必须测这一层：driver 里有两个「看起来能跑、实际静默失败」的点
 * —— ① 订阅与prompt 的**顺序**（反了会丢首帧，表现为「模型没调工具」）
 * —— SSE 帧解析（空行分帧 / 心跳注释 / 非 JSON 行）
 * 两者都会让评测基线**假绿**，而假绿的评测比没有评测危险。
 */

interface FakeServer {
	url: string;
	/** 收到的请求序列（method + path + body），用于断言顺序。 */
	calls: Array<{ method: string; path: string; body?: unknown }>;
	close: () => Promise<void>;
}

/**
 * 起一个假 pi-runtime。
 *
 * @param opts.agentEndAfterMs 收到 prompt 后延迟多少 ms 再发 agent_end
 * @param opts.omitAgentEnd true = 永不发 agent_end（模拟截断）
 */
async function startFakeRuntime(
	opts: {
		events: string[];
		omitAgentEnd?: boolean;
		subscribeBeforePrompt?: boolean;
		failCreate?: boolean;
	} = { events: [] },
): Promise<FakeServer> {
	const calls: FakeServer["calls"] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const path = req.url ?? "";
			let body: unknown;
			try {
				body = raw ? JSON.parse(raw) : undefined;
			} catch {
				body = raw;
			}
			calls.push({ method: req.method ?? "", path, body });

			if (path.startsWith("/sessions") && req.method === "POST" && !path.includes("/prompt")) {
				if (opts.failCreate) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "boom" }));
					return;
				}
				res.writeHead(201, { "content-type": "application/json" });
				res.end(JSON.stringify({ sessionId: "x", provider: "agnes", model: "m", status: "created" }));
				return;
			}
			if (path.includes("/prompt")) {
				res.writeHead(202, { "content-type": "application/json" });
				res.end("{}");
				return;
			}
			if (path.includes("/events")) {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				// 心跳注释帧：真实 SSE 会发，解析必须容忍
				res.write(":keep-alive\n\n");
				// from=now 只收未来事件 ⇒ 必须等 prompt 到了才发 agent_end
				const send = () => {
					for (const frame of opts.events) res.write(`data: ${frame}\n\n`);
					if (!opts.omitAgentEnd) {
						res.write(
							`data: ${JSON.stringify({ type: "agent_end", data: { status: "completed" } })}\n\n`,
						);
					}
					res.end();
				};
				if (opts.subscribeBeforePrompt === false) {
					// 竞态模拟：订阅建立前就把事件吐光（driver 顺序错了就会漏）
					send();
				} else {
					const started = Date.now();
					const tick = (): void => {
						if (calls.some((c) => c.path.includes("/prompt"))) {
							send();
						} else if (Date.now() - started < 3000) {
							setTimeout(tick, 10);
						} else {
							res.end();
						}
					};
					tick();
				}
				return;
			}
			res.writeHead(404).end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("runEvalCase（pi-runtime HTTP 驱动）", () => {
	it("⭐ 订阅必须早于 prompt（顺序反了会丢首帧 → 假绿）", async () => {
		const fake = await startFakeRuntime({
			events: [
				JSON.stringify({ type: "message_end", data: { text: "画好了" } }),
				JSON.stringify({
					type: "tool_execution_start",
					data: { toolName: "propose_generation", toolCallId: "c1" },
				}),
			],
		});
		try {
			const out = await runEvalCase({ baseUrl: fake.url }, { text: "画一张图" });
			const iSubscribe = fake.calls.findIndex((c) => c.path.includes("/events"));
			const iPrompt = fake.calls.findIndex((c) => c.path.includes("/prompt"));
			assert.ok(iSubscribe >= 0 && iPrompt >= 0, "两个请求都必须发出");
			assert.ok(
				iSubscribe < iPrompt,
				`events 订阅(${iSubscribe}) 必须早于 prompt(${iPrompt})，否则丢首帧`,
			);
			assert.deepEqual(out.transcript.toolNames, ["propose_generation"]);
			assert.equal(out.transcript.completed, true);
		} finally {
			await fake.close();
		}
	});

	it("SSE 帧解析：容忍心跳注释、收集全部事件", async () => {
		const fake = await startFakeRuntime({
			events: [
				JSON.stringify({ type: "message_end", data: { text: "A" } }),
				JSON.stringify({ type: "message_end", data: { text: "AB" } }),
			],
		});
		try {
			const out = await runEvalCase({ baseUrl: fake.url }, { text: "hi" });
			assert.equal(out.events.length >= 2, true, `应收到 ≥2 事件，实际 ${out.events.length}`);
			// 全量重发折叠 ⇒ "AB" 而不是"AAB"
			assert.equal(out.transcript.assistantText, "AB");
		} finally {
			await fake.close();
		}
	});

	it("SSE 提前关闭且从未 agent_end ⇒ errors 有明确信号（不判成功）", async () => {
		const fake = await startFakeRuntime({
			events: [JSON.stringify({ type: "message_end", data: { text: "半句" } })],
			omitAgentEnd: true,
		});
		try {
			const out = await runEvalCase({ baseUrl: fake.url, timeoutMs: 3000 }, { text: "hi" });
			assert.equal(out.transcript.completed, false);
			assert.ok(
				out.errors.some((e) => e.includes("agent_end") || e.includes("timeout")),
				`必须留下「没跑完」的信号，实际 errors=${JSON.stringify(out.errors)}`,
			);
			// 已收到的部分仍要能看到 —— 否则无法区分「没调工具」与「根本没跑起来」
			assert.equal(out.transcript.assistantText, "半句");
		} finally {
			await fake.close();
		}
	});

	it("createSession 500 ⇒ 立即失败且不静默", async () => {
		const fake = await startFakeRuntime({ events: [], failCreate: true });
		try {
			const out = await runEvalCase({ baseUrl: fake.url }, { text: "hi" });
			assert.equal(out.transcript.completed, false);
			assert.ok(out.errors[0]?.includes("HTTP 500"), `实际 ${out.errors[0]}`);
		} finally {
			await fake.close();
		}
	});

	it("timeout 生效（不挂死）", async () => {
		// 起一个什么都不返回的 server：SSE 挂着永不发 agent_end
		const calls: Array<{ method: string; path: string }> = [];
		const server = createServer((req, res) => {
			calls.push({ method: req.method ?? "", path: req.url ?? "" });
			if (req.url?.includes("/events")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				// 永不结束
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		try {
			const out = await runEvalCase({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 600 }, {
				text: "hi",
			});
			assert.equal(out.transcript.completed, false);
			assert.ok(out.errors.some((e) => e.includes("timeout")), `实际 ${JSON.stringify(out.errors)}`);
		} finally {
			// ⚠️ 必须 closeAllConnections：timeout 用例里 SSE 响应**永不结束**，
			// 只 close() 会一直等这些连接 ⇒ 整个测试文件挂死（不是 driver 的问题）。
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});


describe("⭐ streamEvents：见 agent_end 立即收手（不等流结束）", () => {
	/**
	 * ⭐⭐ 这是 2026-10-04 生产实测定位到的根因，锁死它不许退化。
	 *
	 * 现象：真实画布 + 真实规则集下，模型**正确**调了 `get_canvas_summary`
	 * 并**正确作答**，`agent_end` 也到了，但 runner 报「本轮未正常结束」。
	 *
	 * 根因：`/events` 是**长连接**，`agent_end` 之后服务端**不关闭**
	 *（前端要靠它接下一轮）。而 `streamEvents` 只在「流结束」或 abort 时返回
	 * ⇒ 永远等不到 ⇒ 只能等 `timeoutMs` 兜底 ⇒ **每条 case 都超时**。
	 *
	 * ⚠️ 这类缺陷在「假 server 直接 `res.end()`」的单测里**测不出来** ——
	 * 必须模拟真实行为：**发完 agent_end 后保持连接打开**。
	 */
	it("服务端发完 agent_end 但不关流 ⇒ 仍要返回（不挂到超时）", async () => {
		const { createServer } = await import("node:http");
		let releaseStream: (() => void) | undefined;
		const streamHeld = new Promise<void>((r) => {
			releaseStream = r;
		});
		const server = createServer((req, res) => {
			const path = req.url ?? "";
			if (path.includes("/events")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ type: "agent_start", data: {} })}\n\n`);
				res.write(`data: ${JSON.stringify({ type: "agent_end", data: { type: "run_end", status: "completed" } })}\n\n`);
				// ⭐ 关键：**不调 res.end()**，模拟真实长连接（等下一轮）。
				void streamHeld;
				return;
			}
			res.writeHead(201, { "content-type": "application/json" });
			res.end(JSON.stringify({ sessionId: "s", provider: "p", model: "m", status: "created" }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const t0 = Date.now();
		try {
			const { runEvalCase } = await import("./driver.js");
			const r = await runEvalCase(
				{ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 30_000 },
				{ text: "hi", systemPrompt: "sp", userId: "u", canvasSessionId: "c" },
			);
			const elapsed = Date.now() - t0;
			assert.equal(r.transcript.completed, true, `应判completed（实际 ${elapsed}ms）`);
			assert.ok(elapsed < 10_000, `应在 agent_end 到达后立刻返回，实际耗时 ${elapsed}ms（接近 30s 说明在等流结束）`);
		} finally {
			releaseStream?.();
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});

describe("⭐⭐ 订阅『就绪』竞态：`from=now` 会吞掉登记前的所有事件", () => {
	/**
	 * 2026-10-06 生产实测：同构客户端 + 容器内真模型，12 轮里 **3 轮**出现
	 * 「模型确实调了 `tool_search`，但客户端一个 `tool_execution_start` 都没收到」。
	 * 反证：pod 内该 session 的 jsonl 里这次调用的 `toolResult` **确实存在**。
	 *
	 * 根因不是模型：`void streamEvents(...)` 只代表「GET 请求已发出」，
	 * 而服务端要**自己把这条连接挂上事件流**之后，水位线（`from=now`）才生效。
	 * 水位线落在「prompt 已触发本轮」之后就意味着：首批事件（往往是**第一个工具调用**）
	 * 被当成「订阅发生前的旧事件」而**永不投递**。
	 *
	 * 最重的后果在「叙述代替调用」这类行为判据上 —— 会把「搜了」记成「没搜」，
	 * 即**假阳性发生器**（记忆：假绿比没有更危险）。
	 *
	 * ⇒ 契约从「先订阅、后 prompt」收紧为「**订阅就绪（响应头到达）后**再 prompt」。
	 *
	 * ⚠️ 注意：只断言「events 请求早于 prompt 请求」**测不出**这个缺陷
	 *（GET 确实先发出，但登记晚于 prompt）—— 必须让假 server 表达「登记有延迟」。
	 */
	async function startRaceRuntime(opts: { registerDelayMs: number; events: string[] }) {
		const calls: Array<{ method: string; path: string }> = [];
		/** 登记订阅者之前产生的事件：按 from=now 语义不投递，记下来当判据。 */
		const dropped: string[] = [];
		let registered = false;
		let sse: ServerResponse | undefined;
		const server = createServer((req, res) => {
			const path = req.url ?? "";
			calls.push({ method: req.method ?? "", path });
			if (path.includes("/events")) {
				sse = res;
				// ⭐ 登记订阅者要时间；**登记前不写响应头**（客户端 fetch 也拿不到 res）
				const t = setTimeout(() => {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					res.write(":keep-alive\n\n");
					registered = true;
				}, opts.registerDelayMs);
				res.on("close", () => clearTimeout(t));
				return;
			}
			if (path.includes("/prompt")) {
				const emit = (frame: string): void => {
					if (!registered || !sse) {
						dropped.push(frame);
						return;
					}
					sse.write(`data: ${frame}\n\n`);
				};
				for (const f of opts.events) emit(f);
				emit(JSON.stringify({ type: "agent_end", data: { status: "completed" } }));
				res.writeHead(202, { "content-type": "application/json" });
				res.end("{}");
				return;
			}
			res.writeHead(201, { "content-type": "application/json" });
			res.end(JSON.stringify({ sessionId: "x", provider: "p", model: "m", status: "created" }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		return {
			url: `http://127.0.0.1:${port}`,
			calls,
			dropped,
			close: async () => {
				server.closeAllConnections();
				await new Promise<void>((r) => server.close(() => r()));
			},
		};
	}

	it("订阅未就绪就发 prompt ⇒ 首个工具调用被吞（修复前必红）", async () => {
		const fake = await startRaceRuntime({
			registerDelayMs: 120,
			events: [
				JSON.stringify({
					type: "tool_execution_start",
					data: { toolName: "tool_search", toolCallId: "c1" },
				}),
			],
		});
		try {
			const out = await runEvalCase({ baseUrl: fake.url, timeoutMs: 5000 }, { text: "查一下画布" });
			assert.deepEqual(
				fake.dropped,
				[],
				`prompt 触发的事件不该落在订阅登记之前；实际被吞：${JSON.stringify(fake.dropped)}`,
			);
			assert.deepEqual(
				out.transcript.toolNames,
				["tool_search"],
				"首个工具调用必须投递；丢了它 = 把「搜了」记成「没搜」",
			);
			// 顺序是必要条件（非充分）：登记延迟才是本用例的判别式
			const iSub = fake.calls.findIndex((c) => c.path.includes("/events"));
			const iPrompt = fake.calls.findIndex((c) => c.path.includes("/prompt"));
			assert.ok(iSub >= 0 && iSub < iPrompt, `订阅(${iSub}) 必须早于 prompt(${iPrompt})`);
		} finally {
			await fake.close();
		}
	});

	it("订阅请求直接失败 ⇒ 必须放行（否则 `await subscribed` 永挂 / 未处理拒绝）", async () => {
		const server = createServer((req, res) => {
			const path = req.url ?? "";
			if (path.includes("/events")) {
				req.destroy();
				return;
			}
			if (path.includes("/prompt")) {
				res.writeHead(202, { "content-type": "application/json" });
				res.end("{}");
				return;
			}
			res.writeHead(201, { "content-type": "application/json" });
			res.end(JSON.stringify({ sessionId: "x", provider: "p", model: "m", status: "created" }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const t0 = Date.now();
		try {
			const out = await runEvalCase(
				{ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 30_000 },
				{ text: "hi" },
			);
			const elapsed = Date.now() - t0;
			assert.ok(
				elapsed < 5000,
				`订阅失败必须立刻返回，实际 ${elapsed}ms（接近 30s 说明 await subscribed 挂住了）`,
			);
			assert.equal(out.transcript.completed, false);
			assert.ok(out.errors.length > 0, `必须留下错误信号，实际 ${JSON.stringify(out.errors)}`);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});
