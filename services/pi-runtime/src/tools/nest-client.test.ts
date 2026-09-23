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
				["get-node", "error"],
				["get-node", "circuit_open"],
			]);
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
