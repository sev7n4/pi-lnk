import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
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
