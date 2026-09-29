import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { SessionManager, toSessionKey } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

/** 默认 harness：prompt 立即成功。 */
const okFactory = (async () => ({
	harness: {
		events: { on: () => () => {} },
		lane: async () => ({ prompt: async () => ({ ok: true }), setThinkingLevel: async () => {} }),
		close: async () => {},
	},
})) as never;

/** 挂起 harness：prompt 直到 gate 释放（用于 busy 409 用例）。 */
function hangingFactory(gate: Promise<unknown>) {
	return (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({
				prompt: async () => {
					await gate;
					return { ok: true };
				},
				setThinkingLevel: async () => {},
			}),
			close: async () => {},
		},
	})) as never;
}

/** 捕获 harness 配置的工厂：用于断言 create 透传字段。 */
function captureFactory(sink: { cfg?: unknown }) {
	return (async (cfg: unknown) => {
		sink.cfg = cfg;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }), setThinkingLevel: async () => {} }),
				close: async () => {},
			},
		};
	}) as never;
}

function makeApp(root: string, factory: unknown = okFactory) {
	const manager = new SessionManager([], "", undefined, factory as never, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: root,
	});
	const app = buildApp(manager, { metrics: new Metrics(), version: "test" });
	return { app, manager };
}

function withRoot<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), prefix));
	return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("POST /sessions 幂等契约", () => {
	it("首次 201 status=created；同键再次 200 status=resumed", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				const a = await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				assert.equal(a.statusCode, 201);
				assert.equal(a.json().status, "created");
				assert.equal(a.json().sessionId, "s1:t1");
				const b = await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				assert.equal(b.statusCode, 200);
				assert.equal(b.json().status, "resumed");
			} finally {
				await app.close();
			}
		});
	});

	it("缺 sessionId 时生成并回显（不回显 undefined）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				const res = await app.inject({ method: "POST", url: "/sessions", payload: { userId: "u1" } });
				assert.equal(res.statusCode, 201);
				assert.equal(typeof res.json().sessionId, "string");
				assert.ok(res.json().sessionId.length > 0);
			} finally {
				await app.close();
			}
		});
	});

	it("空串 sessionId → 400（客户端错误，不该伪装成 503 下游故障）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				const res = await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "", userId: "u1" } });
				assert.equal(res.statusCode, 400);
			} finally {
				await app.close();
			}
		});
	});

	it("不同 userId 同键 → 409（不泄漏 provider/model）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				const conflict = await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u2" } });
				assert.equal(conflict.statusCode, 409);
				assert.ok(!JSON.stringify(conflict.json()).includes("provider"));
			} finally {
				await app.close();
			}
		});
	});

	it("旧 Nest 兼容：attachments / mentionedKeys / refOrder / focusNodeId 仍写入首轮 toolContext", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const sink: { cfg?: unknown } = {};
			const { app } = makeApp(root, captureFactory(sink));
			try {
				const res = await app.inject({
					method: "POST",
					url: "/sessions",
					payload: {
						sessionId: "s1:t1",
						userId: "u1",
						systemPrompt: "RULES",
						mentionedKeys: ["I1"],
						refOrder: ["n1"],
						focusNodeId: "n1",
						attachments: [{ url: "https://x/a.png", mediaType: "image" }],
					},
				});
				assert.equal(res.statusCode, 201);
				const cfg = sink.cfg as { systemPrompt: (t: unknown) => string; toolContext: (t: unknown) => Record<string, unknown> };
				assert.equal(cfg.systemPrompt(undefined), "RULES");
				const tc = cfg.toolContext(undefined);
				assert.deepEqual(tc.mentionedKeys, ["I1"]);
				assert.deepEqual(tc.refOrder, ["n1"]);
				assert.equal(tc.focusNodeId, "n1");
				assert.deepEqual((tc.attachments as unknown[])[0], { url: "https://x/a.png", mediaType: "image" });
			} finally {
				await app.close();
			}
		});
	});

	/**
	 * 2026-09-29 hotfix：`/sessions` body 的 canvasSessionId 必须落到 toolContext.sessionId
	 * （工具回打 Nest 画布端点用的就是它，不能是 pi 会话键）。
	 */
	it("canvasSessionId 透传：toolContext.sessionId = 画布会话 id，而非 pi 会话键", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const sink: { cfg?: unknown } = {};
			const { app } = makeApp(root, captureFactory(sink));
			try {
				const res = await app.inject({
					method: "POST",
					url: "/sessions",
					payload: { sessionId: "canvas-A:t1", userId: "u1", canvasSessionId: "canvas-A" },
				});
				assert.equal(res.statusCode, 201);
				const cfg = sink.cfg as { toolContext: (t: unknown) => Record<string, unknown> };
				const tc = cfg.toolContext(undefined);
				assert.equal(tc.sessionId, "canvas-A");
				// 反向锁：不得是 pi 会话键（sanitize + 哈希后缀）
				assert.notEqual(tc.sessionId, toSessionKey("canvas-A:t1"));
			} finally {
				await app.close();
			}
		});
	});

	it("旧 Nest 兼容：不传 canvasSessionId 时回落 pi 会话键（行为不新增失败形态）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const sink: { cfg?: unknown } = {};
			const { app } = makeApp(root, captureFactory(sink));
			try {
				const res = await app.inject({
					method: "POST",
					url: "/sessions",
					payload: { sessionId: "canvas-A:t1", userId: "u1" },
				});
				assert.equal(res.statusCode, 201);
				const cfg = sink.cfg as { toolContext: (t: unknown) => Record<string, unknown> };
				assert.equal(cfg.toolContext(undefined).sessionId, toSessionKey("canvas-A:t1"));
			} finally {
				await app.close();
			}
		});
	});

	it("畸形 llm → 400（不静默兜底）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				const res = await app.inject({
					method: "POST",
					url: "/sessions",
					payload: { sessionId: "s1:t1", userId: "u1", llm: { model: "x" } },
				});
				assert.equal(res.statusCode, 400);
			} finally {
				await app.close();
			}
		});
	});
});

describe("POST /sessions/:key/prompt 契约", () => {
	it("turnContext 透传生效并返回 202", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app, manager } = makeApp(root);
			try {
				await app.inject({
					method: "POST",
					url: "/sessions",
					payload: { sessionId: "s1:t1", userId: "u1", systemPrompt: "RULES" },
				});
				const res = await app.inject({
					method: "POST",
					url: "/sessions/s1:t1/prompt",
					payload: { text: "你好", turnContext: { dynamicBlocks: ["当前画布摘要：{}"], mentionedKeys: ["I1"] } },
				});
				assert.equal(res.statusCode, 202);
				assert.equal(res.json().accepted, true);
				assert.equal(manager.resolveSystemPromptForTest("s1:t1"), "RULES\n\n当前画布摘要：{}");
			} finally {
				await app.close();
			}
		});
	});

	it("旧 Nest 请求（无 turnContext）仍可用", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } });
				assert.equal(res.statusCode, 202);
			} finally {
				await app.close();
			}
		});
	});

	it("会话不存在 → 404", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				const res = await app.inject({ method: "POST", url: "/sessions/nope/prompt", payload: { text: "你好" } });
				assert.equal(res.statusCode, 404);
			} finally {
				await app.close();
			}
		});
	});

	it("run 进行中 → 409 session busy", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const { app } = makeApp(root, hangingFactory(gate));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				const first = await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "一" } });
				assert.equal(first.statusCode, 202);
				const second = await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "二" } });
				assert.equal(second.statusCode, 409);
				assert.equal(second.json().error, "session busy");
				release(undefined);
				await new Promise((r) => setTimeout(r, 0));
			} finally {
				await app.close();
			}
		});
	});
});

describe("既有端点保持", () => {
	it("/healthz、/readyz、/metrics、/skills 可用", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				const health = await app.inject({ method: "GET", url: "/healthz" });
				assert.equal(health.statusCode, 200);
				assert.equal(health.json().status, "ok");
				assert.equal(health.json().version, "test");
				assert.equal((await app.inject({ method: "GET", url: "/readyz" })).statusCode, 200);
				const metrics = await app.inject({ method: "GET", url: "/metrics" });
				assert.equal(metrics.statusCode, 200);
				assert.ok(metrics.body.includes('pi_runtime_build_info{version="test"} 1'));
				const skills = await app.inject({ method: "GET", url: "/skills" });
				assert.equal(skills.statusCode, 200);
				assert.deepEqual(skills.json(), { skills: [] });
			} finally {
				await app.close();
			}
		});
	});

	it("GET /sessions/:key/events 未知键 → 404；DELETE 未知键 → 404", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				assert.equal((await app.inject({ method: "GET", url: "/sessions/nope/events" })).statusCode, 404);
				assert.equal((await app.inject({ method: "DELETE", url: "/sessions/nope" })).statusCode, 404);
			} finally {
				await app.close();
			}
		});
	});

	it("DELETE /sessions/:key 删除后 204，再删 404", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				assert.equal((await app.inject({ method: "DELETE", url: "/sessions/s1:t1" })).statusCode, 204);
				assert.equal((await app.inject({ method: "DELETE", url: "/sessions/s1:t1" })).statusCode, 404);
			} finally {
				await app.close();
			}
		});
	});
});
