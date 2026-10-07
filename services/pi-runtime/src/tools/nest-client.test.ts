import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { NestClient, NestToolError, NestCircuitOpenError, loadNestConfig } from "./nest-client.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function withServer(handler: Handler, fn: (base: string, hits: () => number) => Promise<void>) {
	let hits = 0;
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c: Buffer) => (raw += c));
		req.on("end", () => { hits += 1; handler(req, res, raw); });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	try {
		await fn(`http://127.0.0.1:${port}`, () => hits);
	} finally {
		server.close();
	}
}

test("成功包络返回 data 且带上鉴权头与出站 body", async () => {
	await withServer(
		(req, res, body) => {
			assert.equal(req.headers["x-lnkpi-service-token"], "tok");
			assert.deepEqual(JSON.parse(body), { sessionId: "s1" });
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ code: 0, message: "ok", data: { nodes: [] } }));
		},
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "tok" });
			const data = await c.post("/agent/internal/get-canvas-summary", { sessionId: "s1" });
			assert.deepEqual(data, { nodes: [] });
		},
	);
});

test("HTTP 200 但 code!=0 必须抛错且文案含 Nest message", async () => {
	await withServer(
		(_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ code: 4001, message: "canvas not found", data: null }));
		},
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t" });
			await assert.rejects(
				() => c.post("/x", {}),
				(err: unknown) => err instanceof NestToolError && /canvas not found/.test((err as Error).message),
			);
		},
	);
});

test("Nest 挂死时按超时失败，不阻塞", async () => {
	await withServer(
		(_req, _res) => {
			/* 永不响应 */
		},
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t", defaultTimeoutMs: 80 });
			await assert.rejects(() => c.post("/x", {}), NestToolError);
		},
	);
});

test("熔断：连续 5 次失败后 fail fast，冷却后恢复", async () => {
	await withServer(
		(_req, res) => {
			res.statusCode = 500;
			res.end("boom");
		},
		async (base, hits) => {
			const c = new NestClient({ baseUrl: base, token: "t", breakerThreshold: 5, breakerCooldownMs: 60 });
			for (let i = 0; i < 5; i++) {
				await assert.rejects(() => c.post("/x", {}), NestToolError);
			}
			await assert.rejects(() => c.post("/x", {}), NestCircuitOpenError);
			assert.equal(hits(), 5, "开路期间不得真实发请求");
			await new Promise((r) => setTimeout(r, 80));
			await assert.rejects(() => c.post("/x", {}), NestToolError, "冷却后应放行并再次真实请求");
			assert.equal(hits(), 6);
		},
	);
});

test("onCall 钩子记录 ok/error/circuit_open", async () => {
	const seen: Array<[string, string]> = [];
	await withServer(
		(_req, res) => {
			res.statusCode = 500;
			res.end("x");
		},
		async (base) => {
			const c = new NestClient({
				baseUrl: base,
				token: "t",
				breakerThreshold: 1,
				breakerCooldownMs: 10_000,
				onCall: (t, o) => seen.push([t, o]),
			});
			await assert.rejects(() => c.post("/agent/internal/get-node", {}), NestToolError);
			await assert.rejects(() => c.post("/agent/internal/get-node", {}), NestCircuitOpenError);
			assert.deepEqual(seen, [
				["get_node", "error"],
				["get_node", "circuit_open"],
			]);
		},
	);
});

test("③ onCall info：ok 带 resultBytes；4xx/5xx/envelope/timeout 各归其类", async () => {
	const seen: Array<[string, string, { resultBytes?: number; errorKind?: string } | undefined]> = [];
	const respond = (status: number, body: string) => (_req: unknown, res: { statusCode: number; end(b: string): void }) => {
		res.statusCode = status;
		res.end(body);
	};
	// ok：包络 data 序列化字节数
	await withServer(
		respond(200, JSON.stringify({ code: 0, message: "ok", data: { hello: "world" } })),
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t", onCall: (t, o, i) => seen.push([t, o, i]) });
			await c.post("/agent/internal/get-canvas-summary", {});
			assert.equal(seen[0][2]?.resultBytes, Buffer.byteLength(JSON.stringify({ hello: "world" })));
		},
	);
	// 4xx → upstream_4xx
	await withServer(
		respond(400, "bad"),
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t", onCall: (t, o, i) => seen.push([t, o, i]) });
			await assert.rejects(() => c.post("/agent/internal/get-node", {}), NestToolError);
			assert.equal(seen[1][2]?.errorKind, "upstream_4xx");
		},
	);
	// envelope → envelope
	await withServer(
		respond(200, JSON.stringify({ code: 1, message: "biz error" })),
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t", onCall: (t, o, i) => seen.push([t, o, i]) });
			await assert.rejects(() => c.post("/agent/internal/get-node", {}), NestToolError);
			assert.equal(seen[2][2]?.errorKind, "envelope");
		},
	);
	// timeout → timeout
	await withServer(
		() => undefined, // never responds
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t", defaultTimeoutMs: 50, onCall: (t, o, i) => seen.push([t, o, i]) });
			await assert.rejects(() => c.post("/agent/internal/get-node", {}), NestToolError);
			assert.equal(seen[3][2]?.errorKind, "timeout");
		},
	);
});

test("业务错误（4xx/envelope）不计熔断；5xx 计入", async () => {
	let n = 0;
	await withServer(
		(_req, res) => {
			n += 1;
			// 前 3 次 400（业务错误），之后 500（服务端故障）
			res.statusCode = n <= 3 ? 400 : 500;
			res.end("err");
		},
		async (base, hits) => {
			const c = new NestClient({ baseUrl: base, token: "t", breakerThreshold: 2, breakerCooldownMs: 10_000 });
			for (let i = 0; i < 3; i++) {
				await assert.rejects(() => c.post("/x", {}), NestToolError);
			}
			assert.equal(hits(), 3, "4xx 属业务错误，不得触发熔断（若熔断则第 3 次 fail fast，hits 会是 2）");
			for (let i = 0; i < 2; i++) {
				await assert.rejects(() => c.post("/x", {}), NestToolError);
			}
			await assert.rejects(() => c.post("/x", {}), NestCircuitOpenError, "5xx 连续 2 次应开路");
		},
	);
});

test("loadNestConfig：读出熔断 env 覆盖（非法/缺省不注入）", () => {
	const prev = {
		b: process.env.NEST_BASE_URL,
		t: process.env.NEST_SERVICE_TOKEN,
		th: process.env.NEST_BREAKER_THRESHOLD,
		cd: process.env.NEST_BREAKER_COOLDOWN_MS,
	};
	delete process.env.NEST_BREAKER_THRESHOLD;
	delete process.env.NEST_BREAKER_COOLDOWN_MS;
	process.env.NEST_BASE_URL = "http://x";
	process.env.NEST_SERVICE_TOKEN = "tok";
	try {
		assert.deepEqual(loadNestConfig(), { baseUrl: "http://x", token: "tok" }, "未配置时不得带 breaker 字段");
		process.env.NEST_BREAKER_THRESHOLD = "3";
		process.env.NEST_BREAKER_COOLDOWN_MS = "1500";
		assert.deepEqual(loadNestConfig(), {
			baseUrl: "http://x",
			token: "tok",
			breakerThreshold: 3,
			breakerCooldownMs: 1500,
		});
		process.env.NEST_BREAKER_THRESHOLD = "abc";
		delete process.env.NEST_BREAKER_COOLDOWN_MS;
		assert.equal(loadNestConfig()?.breakerThreshold, undefined, "非法值不注入");
	} finally {
		if (prev.b === undefined) delete process.env.NEST_BASE_URL;
		else process.env.NEST_BASE_URL = prev.b;
		if (prev.t === undefined) delete process.env.NEST_SERVICE_TOKEN;
		else process.env.NEST_SERVICE_TOKEN = prev.t;
		if (prev.th === undefined) delete process.env.NEST_BREAKER_THRESHOLD;
		else process.env.NEST_BREAKER_THRESHOLD = prev.th;
		if (prev.cd === undefined) delete process.env.NEST_BREAKER_COOLDOWN_MS;
		else process.env.NEST_BREAKER_COOLDOWN_MS = prev.cd;
	}
});

test("loadNestConfig：env 齐全返回配置，缺任一返回 null", () => {
	const prev = { b: process.env.NEST_BASE_URL, t: process.env.NEST_SERVICE_TOKEN };
	try {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
		assert.equal(loadNestConfig(), null);
		process.env.NEST_BASE_URL = "http://x";
		assert.equal(loadNestConfig(), null);
		process.env.NEST_SERVICE_TOKEN = "tok";
		assert.deepEqual(loadNestConfig(), { baseUrl: "http://x", token: "tok" });
	} finally {
		if (prev.b === undefined) delete process.env.NEST_BASE_URL;
		else process.env.NEST_BASE_URL = prev.b;
		if (prev.t === undefined) delete process.env.NEST_SERVICE_TOKEN;
		else process.env.NEST_SERVICE_TOKEN = prev.t;
	}
});

test("P0-②：post 第三参 opts.signal 透传给 fetch——signal 已 aborted 时不发请求立即 reject", async () => {
		let fetchCalls = 0;
		const client = new NestClient({
			baseUrl: "http://nest",
			token: "tok",
			fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
				if (init?.signal?.aborted) throw new Error("aborted before send");
				fetchCalls++;
				return new Response(JSON.stringify({ code: 0, message: "ok", data: {} }), { status: 200 });
			}) as typeof fetch,
		});
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() => client.post("/agent/internal/run-image-generation", {}, { signal: controller.signal }),
		);
		assert.equal(fetchCalls, 0);
});

test("P0-②：外部 abort 在超时之前生效（AbortSignal.any 叠加而非替换）", async () => {
	const client = new NestClient({
		baseUrl: "http://nest",
		token: "tok",
		defaultTimeoutMs: 60_000,
		fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("external abort fired")),
				);
			})) as typeof fetch,
	});
	const controller = new AbortController();
	const pending = client.post("/agent/internal/run-video-generation", {}, { signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
		await assert.rejects(() => pending, /external abort fired/);
});

test("P0-② 终审修复：用户主动 abort 不计入熔断器（连续取消不熔死 run_*）", async () => {
	let okCalls = 0;
	const client = new NestClient({
		baseUrl: "http://nest",
		token: "tok",
		breakerThreshold: 2,
		breakerCooldownMs: 60_000,
		fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
			if (init?.signal?.aborted) {
				const e = new Error("This operation was aborted");
				e.name = "AbortError";
				throw e;
			}
			okCalls++;
			return new Response(JSON.stringify({ code: 0, message: "ok", data: { ok: true } }), { status: 200 });
		}) as typeof fetch,
	});
	// 连续 3 次用户主动取消（threshold=2：修复前第 2 次就熔断）
	for (let i = 0; i < 3; i++) {
		const c = new AbortController();
		c.abort();
		await assert.rejects(() => client.post("/agent/internal/run-image-generation", {}, { signal: c.signal }));
	}
	// 熔断未开启 → 正常请求可达上游
	await client.post("/agent/internal/run-image-generation", {});
	assert.equal(okCalls, 1);
});

test("熔断时 onCall 必须带 errorKind（否则 kinds 整族查不到熔断）", async () => {
	// 生产取证（2026-10-07）：熔断风暴期间 error_class 侧 8.16 个错误全落 internal，
	// 而 kinds 侧同窗口增长为 0 —— 因为 checkCircuit 的 catch 只报 outcome 不报 errorKind，
	// 熔断在结构化通道里**连 series 都不存在**，两条通道同时失明。
	const seen: Array<{ outcome: string; errorKind?: string }> = [];
	await withServer(
		(_req, res) => {
			res.statusCode = 500;
			res.end("boom");
		},
		async (base) => {
			const c = new NestClient({
				baseUrl: base,
				token: "t",
				breakerThreshold: 1,
				breakerCooldownMs: 10_000,
				onCall: (_t, o, i) => seen.push({ outcome: o, errorKind: i?.errorKind }),
			});
			await assert.rejects(() => c.post("/agent/internal/upsert-media-node", {}), NestToolError);
			await assert.rejects(() => c.post("/agent/internal/upsert-media-node", {}), NestCircuitOpenError);
			assert.deepEqual(seen, [
				{ outcome: "error", errorKind: "upstream_5xx" },
				{ outcome: "circuit_open", errorKind: "circuit_open" },
			]);
		},
	);
});
