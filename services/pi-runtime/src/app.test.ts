import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp, resolveEventsSubscribeMode } from "./app.js";
import { SessionManager, toSessionKey, isReplayComplete } from "./session-manager.js";
import { isSuppressed } from "./tools/memory.js";
import { Metrics } from "./metrics.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";
import { PendingToolRegistry } from "./pending-registry.js";

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

function makeApp(root: string, factory: unknown = okFactory, registry?: PendingToolRegistry) {
	const manager = new SessionManager([], "", undefined, factory as never, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: root,
	});
	const metrics = new Metrics();
	const app = buildApp(manager, { metrics, version: "test", registry });
	return { app, manager, metrics };
}

/**
 * `lane()` 直接抛指定错误的工厂：驱动 `POST /sessions/:key/prompt` 的
 * **入口早拒路径**（`session-manager.prompt` 的 try段内抛 ⇒ 复位守卫位后 rethrow
 * ⇒路由 catch 的兜底分支⇒ 503）。
 *
 * 为什么用 `lane()` 而不是 `lane.prompt()`：`lane.prompt` 的失败被 `.catch()` 吞成
 * SSE `error` 事件，**不会**冒泡到路由 catch —— 只有 `lane()` 解析失败（凭据缺失 /
 * 上游不可达，即真实的「上游错误」语义）才走得到本任务的埋点。
 */
function failingLaneFactory(message: string) {
	return (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => {
				throw new Error(message);
			},
			close: async () => {},
		},
	})) as never;
}

/** 从 /metrics 正文里取某个指标的全部样本行（找不到返回空数组）。 */
function metricLines(body: string, metric: string): string[] {
	return body.split("\n").filter((l) => l.startsWith(`${metric}{`) || l.startsWith(`${metric} `));
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
				// systemPrompt = RULES 逐字节（2026-10-02 起取消了插话约定段 QUEUE_GUIDANCE，
				// 见 session-manager.ts 顶部说明）。
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

	it("GET /sessions/:key/events?from=now 未知键 → 404（live 路径同样 fail-closed）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				assert.equal(
					(await app.inject({ method: "GET", url: "/sessions/nope/events?from=now" })).statusCode,
					404,
				);
			} finally {
				await app.close();
			}		});
	});
});

describe("resolveEventsSubscribeMode 订阅起点裁决（P0-A 跨轮重放回归锁）", () => {
	it("lastEventId（合法非负整数）最高优先 → 增量续传（P0-③ 不变）", () => {
		assert.deepEqual(resolveEventsSubscribeMode({ lastEventId: "7" }), { mode: "replay", afterSeq: 7 });
		assert.deepEqual(resolveEventsSubscribeMode({ lastEventId: "7", from: "now" }), {
			mode: "replay",
			afterSeq: 7,
		});
	});

	it("无 lastEventId 且 from=now → live（不重放缓冲）", () => {
		assert.deepEqual(resolveEventsSubscribeMode({ from: "now" }), { mode: "live" });
		assert.deepEqual(resolveEventsSubscribeMode({ lastEventId: "abc", from: "now" }), { mode: "live" });
		assert.deepEqual(resolveEventsSubscribeMode({ lastEventId: "-1", from: "now" }), { mode: "live" });
	});

	it("无参 / 畸形参数 → 全量重放（旧客户端兼容，行为不变）", () => {
		assert.deepEqual(resolveEventsSubscribeMode(undefined), { mode: "replay", afterSeq: -1 });
		assert.deepEqual(resolveEventsSubscribeMode({}), { mode: "replay", afterSeq: -1 });
		assert.deepEqual(resolveEventsSubscribeMode({ lastEventId: "abc" }), { mode: "replay", afterSeq: -1 });
		assert.deepEqual(resolveEventsSubscribeMode({ lastEventId: "-3" }), { mode: "replay", afterSeq: -1 });
		assert.deepEqual(resolveEventsSubscribeMode({ from: "earlier" }), { mode: "replay", afterSeq: -1 });
	});
});

/**
 * ask_user 阻塞链路 HTTP 面（2026-09-30-ask-user-blocking Task 3）。
 * registry 键 = 画布会话 id（工具域，toolContext.sessionId），路由参数 = threadKey；
 * 端点内部经 getCanvasSessionId 换算——用真 SessionManager 走完整 create 链路验证。
 */
describe("POST /sessions/:key/answers（幂等 resolve，Review Focus 1）", () => {
	it("正常 resolve → 200 {ok:true,deduped:false}，阻塞中的 waitForUser 以 answered 交还", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1", canvasSessionId: "canvas-1" } });
				const wait = registry.waitForUser("canvas-1", "c1", "ask_user", 60_000);
				// 请求 URL 是 pi 会话键（threadKey），registry 注册键是画布 id——覆盖键换算
				const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/answers", payload: { callId: "c1", answers: { q: ["a"] } } });
				assert.equal(res.statusCode, 200);
				assert.deepEqual(res.json(), { ok: true, deduped: false });
				assert.deepEqual(await wait, { status: "answered", answers: { q: ["a"] } });
			} finally {
				registry.abortAll("canvas-1"); // 未 settle 收尾兜底，防 node:test 白等
				await app.close();
			}
		});
	});

	it("decision=decline → registry 以 aborted 交还（用户显式取消，无需 answers）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1", canvasSessionId: "canvas-1" } });
				const wait = registry.waitForUser("canvas-1", "c9", "propose_generation", 60_000);
				const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/answers", payload: { callId: "c9", decision: "decline" } });
				assert.equal(res.statusCode, 200);
				assert.deepEqual(res.json(), { ok: true, deduped: false });
				assert.deepEqual(await wait, { status: "aborted" });
			} finally {
				registry.abortAll("canvas-1");
				await app.close();
			}
		});
	});

	it("decision 缺省 = answer（老前端不传也走作答语义，向后兼容）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1", canvasSessionId: "canvas-1" } });
				const wait = registry.waitForUser("canvas-1", "c10", "ask_user", 60_000);
				const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/answers", payload: { callId: "c10", answers: { q: ["a"] } } });
				assert.equal(res.statusCode, 200);
				assert.deepEqual(await wait, { status: "answered", answers: { q: ["a"] } });
			} finally {
				registry.abortAll("canvas-1");
				await app.close();
			}
		});
	});

	it("未知 callId（已超时清理 / 从未注册）→ 仍 200 {ok:true,deduped:true}，业务路径不 404/500", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1", canvasSessionId: "canvas-1" } });
				const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/answers", payload: { callId: "ghost", answers: {} } });
				assert.equal(res.statusCode, 200);
				assert.deepEqual(res.json(), { ok: true, deduped: true });
			} finally {
				await app.close();
			}
		});
	});

	it("会话不存在 → 仍 200 deduped:true（getCanvasSessionId 回落键本身，registry 查不到无副作用）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				const res = await app.inject({ method: "POST", url: "/sessions/nope/answers", payload: { callId: "c1", answers: {} } });
				assert.equal(res.statusCode, 200);
				assert.deepEqual(res.json(), { ok: true, deduped: true });
			} finally {
				await app.close();
			}
		});
	});

	it("缺 callId 或 answers 非对象 → 400（客户端错误）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				const noCallId = await app.inject({ method: "POST", url: "/sessions/s1:t1/answers", payload: { answers: {} } });
				assert.equal(noCallId.statusCode, 400);
				const badAnswers = await app.inject({ method: "POST", url: "/sessions/s1:t1/answers", payload: { callId: "c1", answers: "x" } });
				assert.equal(badAnswers.statusCode, 400);
			} finally {
				await app.close();
			}
		});
	});

	it("registry 未装配 → 503（配置缺失，非业务路径）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/answers", payload: { callId: "c1", answers: {} } });
				assert.equal(res.statusCode, 503);
			} finally {
				await app.close();
			}
		});
	});
});

describe("GET /sessions/:key/pending", () => {
	it("有 pending → {pending:{callId,toolName}}；resolve 后 → {pending:null}", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1", canvasSessionId: "canvas-1" } });
				const wait = registry.waitForUser("canvas-1", "c1", "ask_user", 60_000);
				assert.deepEqual((await app.inject({ method: "GET", url: "/sessions/s1:t1/pending" })).json(), {
					pending: { callId: "c1", toolName: "ask_user" },
				});
				registry.answer("canvas-1", "c1", {});
				await wait;
				assert.deepEqual((await app.inject({ method: "GET", url: "/sessions/s1:t1/pending" })).json(), { pending: null });
			} finally {
				registry.abortAll("canvas-1");
				await app.close();
			}
		});
	});

	it("会话不存在 → {pending:null}（不给探测面）；registry 未装配 → 同样 {pending:null}", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const registry = new PendingToolRegistry();
			const { app } = makeApp(root, okFactory, registry);
			try {
				assert.deepEqual((await app.inject({ method: "GET", url: "/sessions/thread-x/pending" })).json(), { pending: null });
				const { app: bare } = makeApp(root);
				try {
					assert.deepEqual((await bare.inject({ method: "GET", url: "/sessions/s1:t1/pending" })).json(), { pending: null });
				} finally {
					await bare.close();
				}
			} finally {
				registry.abortAll("canvas-1");
				await app.close();
			}
		});
	});
});

describe("POST /sessions/:key/prompt 直通 images（T1）", () => {
	// 记录每次 lane.prompt 调用（run 后的 drain/compaction 会以 ("", undefined, ctx) 再调，
	// 单槽覆盖会误判——以「存在一次目标调用」为准。
	function imageCaptureFactory(sink: { calls: { text: string; images: unknown }[] }) {
		return (async () => ({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({
					prompt: async (text: string, images: unknown) => {
						sink.calls.push({ text, images });
						return { ok: true };
					},
					setThinkingLevel: async () => {},
				}),
				close: async () => {},
			},
		})) as never;
	}

	it("body.images 透传为 lane.prompt 第二参 ImageContent[]", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const sink: { calls: { text: string; images: unknown }[] } = { calls: [] };
			const { app } = makeApp(root, imageCaptureFactory(sink));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				const res = await app.inject({
					method: "POST",
					url: "/sessions/s1:t1/prompt",
					payload: { text: "描述这张图", images: [{ name: "a.png", mimeType: "image/png", data: "QUJD" }] },
				});
				assert.equal(res.statusCode, 202);
				const withImages = sink.calls.filter((c) => c.images !== undefined);
				assert.equal(withImages.length, 1);
				assert.deepEqual(withImages[0].images, [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
				assert.equal(withImages[0].text, "描述这张图");
			} finally {
				await app.close();
			}
		});
	});

	it("无 images / 空 data → 第二参 undefined（不发空数组，Review Focus 1）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const sink: { calls: { text: string; images: unknown }[] } = { calls: [] };
			const { app } = makeApp(root, imageCaptureFactory(sink));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "纯文本" } });
				await app.inject({
					method: "POST",
					url: "/sessions/s1:t1/prompt",
					payload: { text: "空图", images: [{ name: "a.png", mimeType: "image/png", data: "" }] },
				});
				// 允许事件循环里 drain/compaction 的补充调用，但绝不允许任何一次携带 images。
				assert.equal(sink.calls.filter((c) => c.images !== undefined).length, 0);
			} finally {
				await app.close();
			}
		});
	});
});

/**
 * 上游错误改走 `error_class` 闭集分类（spec §4.4）。
 *
 * ⚠️ **本组用例全部走 `app.inject()` 真实 HTTP 入口**，不直接调 `observeLlmError`。
 * 前几轮踩过的坑：测试直接调被测方法 ⇒ 绕过接线 ⇒ 把 `app.ts` 里的埋点整段注释掉
 * 测试依然全绿（假绿）。断言的对象是 `/metrics` **渲染出的文本行**，即
 * 「HTTP 503 → 分类 → 结算 → 渲染」整条链路的终点，中间任何一环断掉都会红。
 */
describe("LLM 上游错误：error_class 闭集分类（真实 HTTP 接线）", () => {
	it("入口早拒仍返 503，且按 error_class/channel/model 上报（不止 2 值）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root, failingLaneFactory("upstream returned 503 service unavailable"));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } });
				// 契约不变：入口早拒仍 503。
				assert.equal(res.statusCode, 503);

				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				const lines = metricLines(body, "pi_runtime_llm_errors_total");
				assert.equal(lines.length, 1, `期望恰好 1 条llm_errors_total样本，实际：${JSON.stringify(lines)}`);
				// stage=main_turn（入口早拒路径）；channel/model 取会话定型身份。
				// 断言 error_class=upstream_5xx —— 这是旧2 值正则给不出的结论
				// （`/429|rate/i`不匹配该文本，旧指标只会记upstream_error）。
				assert.match(lines[0], /stage="main_turn"/);
				assert.match(lines[0], /error_class="upstream_5xx"/);
				assert.match(lines[0], /channel="agnes"/);
				assert.match(lines[0], /model="agnes-2\.5-pro"/);
				assert.match(lines[0], / 1$/);
			} finally {
				await app.close();
			}
		});
	});

	it("旧指标 pi_runtime_llm_prompt_errors_total 仍上报（保留一个发布周期，不断告警档）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root, failingLaneFactory("HTTP 429 rate limit exceeded"));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				assert.equal(
					(await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } })).statusCode,
					503,
				);
				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				// 旧指标仍在，且 429 仍落它自己的 2 值域（不因新分类而改口径）。
				assert.deepEqual(metricLines(body, "pi_runtime_llm_prompt_errors_total"), [
					'pi_runtime_llm_prompt_errors_total{reason="upstream_rate_limited"} 1',
				]);
				// 新指标同一次错误也上报，且分类是闭集里的 upstream_4xx。
				assert.deepEqual(metricLines(body, "pi_runtime_llm_errors_total"), [
					'pi_runtime_llm_errors_total{stage="main_turn",error_class="upstream_4xx",channel="agnes",model="agnes-2.5-pro"} 1',
				]);
			} finally {
				await app.close();
			}
		});
	});

	it("新指标结论 ≠ 旧 2 值正则（证明分类真下沉，而非旧正则换皮）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			// 同一文本 "HTTP 429 Too Many Requests"：旧 2 值正则判 upstream_rate_limited（碰巧一致），
			// 故另取一条旧正则判 upstream_error、闭集分类器判 upstream_4xx 的文本，才能证明两者不同。
			const { app } = makeApp(root, failingLaneFactory("Too Many Requests: 429"));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } });
				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				// 旧正则：文本含 "429" ⇒upstream_rate_limited。
				assert.deepEqual(metricLines(body, "pi_runtime_llm_prompt_errors_total"), [
					'pi_runtime_llm_prompt_errors_total{reason="upstream_rate_limited"} 1',
				]);
				// 新分类器：同一文本落闭集里的 upstream_4xx。若新指标只是旧正则换皮，
				// 这里会是 upstream_rate_limited / upstream_error 之一 ⇒ 本断言红。
				assert.match(metricLines(body, "pi_runtime_llm_errors_total")[0], /error_class="upstream_4xx"/);
			} finally {
				await app.close();
			}
		});
	});

	it("旧 2 值正则塌成 upstream_error 的错误，新指标能区分出network（排障可归因）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			// "fetch failed" 不含 429/rate ⇒ 旧正则判 upstream_error（网络不可达与上游 5xx 混成一类）；
			// 闭集分类器判 network。这条差异是本任务的核心价值。
			const { app } = makeApp(root, failingLaneFactory("fetch failed"));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } });
				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.deepEqual(metricLines(body, "pi_runtime_llm_prompt_errors_total"), [
					'pi_runtime_llm_prompt_errors_total{reason="upstream_error"} 1',
				]);
				assert.match(metricLines(body, "pi_runtime_llm_errors_total")[0], /error_class="network"/);
			} finally {
				await app.close();
			}
		});
	});

	it("无法判定的错误落internal（绝不静默丢弃，也不把原文当 label）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const secret = "sk-live-abcdef123456";
			const { app } = makeApp(root, failingLaneFactory(`玄妙失败 ${secret}`));
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				assert.equal(
					(await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } })).statusCode,
					503,
				);
				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.deepEqual(metricLines(body, "pi_runtime_llm_errors_total"), [
					'pi_runtime_llm_errors_total{stage="main_turn",error_class="internal",channel="agnes",model="agnes-2.5-pro"} 1',
				]);
				// label 基数红线：错误原文（含密钥）不得出现在任何 label 里。
				assert.equal(body.includes(secret), false, "错误原文泄漏进了指标 label");
			} finally {
				await app.close();
			}
		});
	});

	it("BYOK 会话按 byok-* 渠道上报（channel 取 LlmIdentity，不透传请求体）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root, failingLaneFactory("fetch failed"));
			try {
				const created = await app.inject({
					method: "POST",
					url: "/sessions",
					payload: {
						sessionId: "s1:t1",
						userId: "u1",
						llm: {
							model: "my-model-x",
							apiKey: "sk-test-byok",
							baseUrl: "https://example.invalid/v1",
							providerRef: "ref-1",
							source: "user",
						},
					},
				});
				assert.equal(created.statusCode, 201);
				//渠道 id 是 `byok-<12位hex>`（providerRef 哈希），不是请求体里的 providerRef 原文。
				assert.match(created.json().provider, /^byok-[0-9a-f]{12}$/);
				assert.equal(created.json().provider.includes("ref-1"), false, "providerRef 原文泄漏进了 channel");

				assert.equal(
					(await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } })).statusCode,
					503,
				);
				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.deepEqual(metricLines(body, "pi_runtime_llm_errors_total"), [
					`pi_runtime_llm_errors_total{stage="main_turn",error_class="network",channel="${created.json().provider}",model="my-model-x"} 1`,
				]);
			} finally {
				await app.close();
			}
		});
	});

	it("非上游错误路径不污染 llm_errors_total：404 / 409 均不记账", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const { app } = makeApp(root, hangingFactory(gate));
			try {
				// 404：会话不存在。
				assert.equal(
					(await app.inject({ method: "POST", url: "/sessions/nope/prompt", payload: { text: "x" } })).statusCode,
					404,
				);
				// 409：run 在跑。
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				assert.equal(
					(await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "一" } })).statusCode,
					202,
				);
				assert.equal(
					(await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "二" } })).statusCode,
					409,
				);
				release(undefined);
				await new Promise((r) => setTimeout(r, 0));

				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.deepEqual(metricLines(body, "pi_runtime_llm_errors_total"), [], "404/409 被误记成 LLM 错误");
				assert.deepEqual(metricLines(body, "pi_runtime_llm_prompt_errors_total"), []);
			} finally {
				await app.close();
			}
		});
	});
});

/**
 * T1：SSE 重连遇「重放窗口已过期」必须显式报 409，不能装作正常。
 *
 * 缺陷背景：`dispatch` 溢出时 `buffer.shift()` 丢最旧事件，而 `message_update`
 * 是每 token 一个事件 ⇒ 一段几百字回答单轮就能破 500，溢出是**常规路径**。
 * 改前客户端带 `lastEventId=0` 重连会拿到 200 + 断头流，前端渲染出「答了一半」
 * 的界面且**无任何报错**（与 degraded 静默降级同型：失败被降级成成功）。
 *
 * 改后：残缺时在**写响应头之前**回 409 + 结构化原因，客户端据此改走全量重建。
 *
 * 为什么能在测试里造出溢出：`makeApp` 返回真实 `SessionManager`，
 * 用 `dispatchWaitingUser`（公开方法）把 buffer 灌到超过 BUFFER_LIMIT=500。
 */
describe("T1 SSE 重连：溢出可判读，且客户端行为零变更", () => {
	/**
	 * 用公开方法把某会话的 buffer 灌到溢出（每条一个 waiting_user 广播）。
	 *
	 * ⚠️ **必须传 `canvasSessionId`**：`dispatchWaitingUser` 的匹配键是
	 * `entry.canvasSessionId ?? entry.id`，而 `entry.id` 是 `toSessionKey(...)`
	 * 的结果（`:` → `_` + 8 位 hash，如 `s1_t1-a1b2c3d4`）。
	 * 只传 `sessionId` 而不传 `canvasSessionId` ⇒ `entry.canvasSessionId` 为 undefined
	 * ⇒ 拿 `s1_t1-<hash>` 去比 `"s1:t1"` ⇒ **永远不匹配、hits=0、buffer 根本没灌满**。
	 * 于是 `droppedFromSeq` 恒为 0 ⇒ 判定「完整」⇒ 走 SSE 长连接 ⇒ inject 永不 resolve
	 * ⇒ 整个测试文件卡死（2026-10-04 实测 CI 跑 11-13 分钟未结束）。
	 *
	 * 断言命中数 > 0 是这个前置条件的护栏：静默不匹配会让「造溢出」变成空操作。
	 */
	async function overflowBuffer(manager: SessionManager, key: string): Promise<void> {
		// 先验证「打得到这个会话」，再灌——否则造溢出是个静默的空操作。
		assert.ok(
			manager.dispatchWaitingUser(key, { toolName: "probe", status: "waiting" } as never) > 0,
			`前置条件：dispatchWaitingUser 必须命中会话 ${key}（检查 canvasSessionId 是否传入）`,
		);
		for (let i = 0; i < 501; i++) {
			manager.dispatchWaitingUser(key, { toolName: `t${i}`, status: "waiting" } as never);
		}
	}

	/**
	 * 本组**不测「200 + SSE 流」**。
	 *
	 * ⚠️ 2026-10-04 实测两次：一旦真的 inject `/events` 走建流成功路径，
	 * handler 会活到连接关闭，node --test 报
	 * `generated asynchronous activity after the test ended` + `ERR_HTTP_HEADERS_SENT`，
	 * 拖死整个文件（CI 跑 14 分钟未结束）。
	 * ⇒ 「客户端可见行为不变」用**源码层证据**断言（`git grep` 确认无 409 分支），
	 * app 层只测**能立即返回的分支**。
	 *
	 * 本组要钉的判据是**存储层**：`droppedFromSeq` 可读 + `isReplayComplete` 能判残缺。
	 * 那是本 PR 的实际交付物（可观测），不碰 I/O 最稳。
	 */
	it("溢出后 droppedFromSeq 可读，且能判定重放残缺", async () => {
		await withRoot("pi-runtime-t1-", async (root) => {
			const { app, manager } = makeApp(root);
			try {
				// ⚠️ `canvasSessionId` 必须传，否则 overflowBuffer 命中不到（见其注释）
				await app.inject({
					method: "POST",
					url: "/sessions",
					payload: { sessionId: "s1:t1", userId: "u1", canvasSessionId: "s1:t1" },
				});
				await overflowBuffer(manager, "s1:t1");

				// 溢出后重放 ⇒ 报告丢弃起点
				const probe = manager.subscribe("s1:t1", () => {}, 0);
				assert.ok(probe.droppedFromSeq > 0, "溢出后必须报告丢弃起点");
				assert.equal(isReplayComplete(probe, 0), false, "afterSeq=0 早于水位 ⇒ 判为残缺");

				// HTTP 层：残缺 ⇒ 409（**立即返回**，可测；不同于「建流成功」那条会挂死）
			const res = await app.inject({
				method: "GET",
				url: "/sessions/s1:t1/events?lastEventId=0",
			});
			assert.equal(res.statusCode, 409, "残缺重放必须 409，不能发200 + 断头流");
			const body = res.json() as {
				error: string;
				droppedFromSeq: number;
				afterSeq: number;
				recovery: string;
			};
			assert.equal(body.error, "replay window expired");
			assert.equal(body.afterSeq, 0);
			assert.ok(
				body.droppedFromSeq > body.afterSeq,
				`droppedFromSeq(${body.droppedFromSeq}) 必须大于 afterSeq(${body.afterSeq})，否则客户端无法判断残缺`,
			);
			assert.equal(body.recovery, "rebuild full timeline", "必须告诉客户端怎么恢复");

			// afterSeq 恰好等于水位 ⇒ 判为完整（防「每次重连都误报残缺」）
				const atBoundary = manager.subscribe("s1:t1", () => {}, probe.droppedFromSeq);
				assert.equal(
					isReplayComplete(atBoundary, probe.droppedFromSeq),
					true,
					"afterSeq 等于水位时不该判残缺",
				);
			} finally {
				await app.close();
			}
		});
	});

	it("正常 prompt 不产生任何 llm_errors_total 样本", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				assert.equal(
					(await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } })).statusCode,
					202,
				);
				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.deepEqual(metricLines(body, "pi_runtime_llm_errors_total"), []);
			} finally {
				await app.close();
			}
		});
	});
});

// ── M6b：POST /internal/memory-suppress（spec 2026-10-06-memory-promotion-m6b-design.md §2.2）──

describe("POST /internal/memory-suppress", () => {
	/** 模块级抑制表不复位（与 memory.test.ts 同约定）：每条用例独立 id。 */
	const uid = () => "mem-rt-" + Math.random().toString(36).slice(2, 10);

	it("标记后 isSuppressed 命中（recall_memory 剔除的数据源就绪）", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			const id = uid();
			try {
				const res = await app.inject({
					method: "POST",
					url: "/internal/memory-suppress",
					payload: { memoryId: id, reason: "反复把跨画布记忆当当前画布观察" },
				});
				assert.equal(res.statusCode, 200);
				assert.equal(isSuppressed(id), true);
			} finally {
				await app.close();
			}
		});
	});

	it("缺 memoryId / 空 memoryId → 400，不写入", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			try {
				assert.equal((await app.inject({ method: "POST", url: "/internal/memory-suppress", payload: { reason: "x" } })).statusCode, 400);
				assert.equal((await app.inject({ method: "POST", url: "/internal/memory-suppress", payload: { memoryId: "  " } })).statusCode, 400);
			} finally {
				await app.close();
			}
		});
	});

	it("指标：首次标记 +1、重复标记幂等不重复计数", async () => {
		await withRoot("pi-runtime-app-", async (root) => {
			const { app } = makeApp(root);
			const id = uid();
			try {
				await app.inject({ method: "POST", url: "/internal/memory-suppress", payload: { memoryId: id, reason: "a" } });
				await app.inject({ method: "POST", url: "/internal/memory-suppress", payload: { memoryId: id, reason: "a" } });
				const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.match(body, /pi_runtime_memory_suppressed_total 1\n/);
				await app.inject({ method: "POST", url: "/internal/memory-suppress", payload: { memoryId: uid(), reason: "b" } });
				const body2 = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.match(body2, /pi_runtime_memory_suppressed_total 2\n/);
			} finally {
				await app.close();
			}
		});
	});
});
