import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	SessionManager,
	BusyError,
	NotFoundError,
	toSessionKey,
	appendPromptBlocks,
} from "./session-manager.js";
import type { SessionLlmOverride } from "./model-assembly.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { COMPACTION_RETENTION_INSTRUCTIONS } from "./compaction-summary.js";
import { SkillRegistry } from "./skills/registry.js";
import { Closed } from "@earendil-works/pi-agent-core";

/**
 * 每个用例独立的 dataRoot。
 * Task 4 起 create 会从磁盘恢复：共用根目录会让后一个用例意外命中前一个用例写的会话文件，
 * 走 resume 短路（不调 harnessFactory）→ 捕获为空而假失败。
 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-sm-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));
let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `c${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		// 既有断言按「全量常驻」legacy 语义书写；tiering-on 的接线行为在下方
		// 「tiering-on 接线（评审 finding 3）」专组覆盖。
		toolTiering: false,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 建一个含 1 个合法 skill 的临时目录，测试结束自动清理。 */
function makeTempSkillDir(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-skills-test-"));
	mkdirSync(join(root, "demo-skill"));
	writeFileSync(
		join(root, "demo-skill", "SKILL.md"),
		"---\nname: demo-skill\ndescription: demo skill for tests\n---\nBody of demo skill.\n",
	);
	return root;
}

/**
 * ⚠️ 2026-10-02：system prompt 里那段「运行中插话须先复述再动工具」的约定段（`QUEUE_GUIDANCE`）
 * 已取消 —— 常驻 context 换概率行为不划算，且「用户看得到它接住了」有一半是确定性可解的前端问题。
 * 插话显化改走消息层 kind 标签（Nest `pi-runtime.client.ts` 的 `queue()`）。
 *
 * 因此下面这组断言**恢复「base 段逐字节相等」的严格语义**：systemPrompt 就是 base，不多不少。
 * 「base 段原样保留 / 无 skills 时不额外拼块」仍靠这里锁住；任何再想往静默认态里塞东西的人
 * 都得先改这里 —— 以前那版被塞段改碎过 5 处断言，那是本应保留的可见度。
 */
const SYS_BASE = "SYS";

describe("SessionManager harnessFactory 注入缝", () => {
	it("create() 把 tools/toolContext/systemPrompt 原样传给 harnessFactory", async () => {
		let captured: unknown = null;
		const fakeHarnessFactory = async (cfg: unknown) => {
			captured = cfg;
			return {
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			} as never;
		};
		const sm = new SessionManager([{ name: "t_probe" } as never], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		await sm.create("s1", {
			userId: "u1",
			systemPrompt: "SYS",
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
			mentionedKeys: ["I1"],
			refOrder: ["I1"],
			focusNodeId: "node-1",
		});
		const cfg = captured as {
			systemPrompt: (tc: unknown) => string;
			toolContext: (tc: unknown) => Record<string, unknown>;
			thinkingLevel?: string;
		};
		assert.equal(cfg.systemPrompt(undefined), SYS_BASE);
		assert.equal(cfg.thinkingLevel, "medium");
		const tc = cfg.toolContext(undefined);
		assert.equal(tc.userId, "u1");
		assert.equal(tc.sessionId, toSessionKey("s1"));
		assert.deepEqual(tc.mentionedKeys, ["I1"]);
		assert.equal(tc.focusNodeId, "node-1");
		assert.deepEqual((tc.attachments as unknown[])[0], {
			url: "https://x/a.png",
			mediaType: "image",
		});
	});
});

/**
 * 2026-09-29 hotfix 回归锁：`toolContext.sessionId` 必须等于**画布会话 id**，
 * 不能是 pi 会话键（`toSessionKey(threadKey)`）。
 *
 * 事故：Nest 的 `/agent/internal/*` 拿 `toolContext.sessionId` 去
 * `prisma.session.findUnique({id})` 查画布会话；#70 把该字段的值换成了 pi 会话键
 * （前端 threadId 恒为 `${sessionId}:${后缀}`，故键永远带后缀）→ 全部画布工具 404。
 * 详见 docs/superpowers/specs/2026-09-29-agent-tool-canvas-sessionid-hotfix-design.md。
 */
describe("toolContext.sessionId = 画布会话 id（hotfix 回归锁）", () => {
	/** 建一个只捕获 harness 配置的最小 Manager。 */
	function makeManager(captured: { cfg?: unknown }) {
		const fakeHarnessFactory = async (cfg: unknown) => {
			captured.cfg = cfg;
			return {
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			} as never;
		};
		return new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			fakeHarnessFactory,
			undefined,
			undefined,
			testConfig(),
		);
	}
	const readTc = (captured: { cfg?: unknown }) => {
		const cfg = captured.cfg as { toolContext: () => Record<string, unknown> };
		return cfg.toolContext();
	};

	// 复合 threadId：前端 createAgentThreadId = `${sessionId}:${后缀}`
	const THREAD_KEY = "canvas-A:0a7fea56-a015-4f16-a38f-1edd2c5bab1c";

	it("传 canvasSessionId → toolContext.sessionId 用它；pi 会话键不被污染", async () => {
		const captured: { cfg?: unknown } = {};
		const sm = makeManager(captured);
		await sm.create(THREAD_KEY, { userId: "u1", canvasSessionId: "canvas-A" });

		assert.equal(readTc(captured).sessionId, "canvas-A");
		// sessions map 键仍是 sanitize 后的 pi 会话键（会话身份与画布身份两分）
		assert.deepEqual([...sm.activeKeys()], [toSessionKey(THREAD_KEY)]);
		assert.notEqual(toSessionKey(THREAD_KEY), "canvas-A");
	});

	it("未传 canvasSessionId → 回落 pi 会话键（旧 Nest 兼容，不产生新失败形态）", async () => {
		const captured: { cfg?: unknown } = {};
		const sm = makeManager(captured);
		await sm.create(THREAD_KEY, { userId: "u1" });

		assert.equal(readTc(captured).sessionId, toSessionKey(THREAD_KEY));
	});

	it("内存 resume 时刷新 canvasSessionId（每轮自愈，消除滚动升级残留）", async () => {
		const captured: { cfg?: unknown } = {};
		const sm = makeManager(captured);
		// 第 1 轮：旧 Nest 未传 → 残留错值
		await sm.create(THREAD_KEY, { userId: "u1" });
		assert.equal(readTc(captured).sessionId, toSessionKey(THREAD_KEY));
		// 第 2 轮：新 Nest 传了 → 同一 harness 实例，但 toolContext 立即反映正确值
		const again = await sm.create(THREAD_KEY, { userId: "u1", canvasSessionId: "canvas-A" });
		assert.equal(again.status, "resumed");
		assert.equal(again.resumedFrom, "memory");
		assert.equal(readTc(captured).sessionId, "canvas-A");
	});
});

describe("SessionManager SessionHooks（B-5 Gate 接线缝）", () => {
	it("create 后调用 onSessionCreated（带 sessionId 与 harness）", async () => {
		const seen: Array<{ id: string; hasHarness: boolean }> = [];
		const fakeHarnessFactory = async () => ({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		}) as never;
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, {
			onSessionCreated(id, harness) {
				seen.push({ id, hasHarness: !!harness });
			},
		}, undefined, testConfig());
		await sm.create("s1", {});
		assert.deepEqual(seen, [{ id: toSessionKey("s1"), hasHarness: true }]);
	});

	it("prompt 入口调用 onPrompt", async () => {
		const prompts: string[] = [];
		const fakeHarnessFactory = async () => ({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		}) as never;
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, {
			onPrompt(id) {
				prompts.push(id);
			},
		}, undefined, testConfig());
		await sm.create("s1", {});
		await sm.prompt("s1", "hello");
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(prompts, [toSessionKey("s1")]);
	});
});

describe("SessionManager skills 注入（D-η' Task 4）", () => {
	it("no skills means prompt unchanged (byte-identical to base)", async () => {
		let captured: unknown = null;
		const factory = async (cfg: unknown) => {
			captured = cfg;
			return {
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			} as never;
		};
		const sm = new SessionManager([{ name: "t_probe" } as never], "", undefined, factory, undefined, undefined, testConfig());
		await sm.create("s1", { systemPrompt: "SYS" });
		const cfg = captured as { systemPrompt: (tc: unknown) => string; tools: Array<{ name: string }> };
		assert.equal(cfg.systemPrompt(undefined), SYS_BASE);
		assert.ok(!cfg.tools.some((t) => t.name === "load_skill"));
	});

	it("appends skill index block to systemPrompt", async () => {
		const root = makeTempSkillDir();
		after(() => rmSync(root, { recursive: true, force: true }));
		const registry = new SkillRegistry(root, new Metrics());
		let captured: unknown = null;
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			async (cfg: unknown) => {
				captured = cfg;
				return {
					harness: {
						events: { on: () => () => {} },
						lane: async () => ({ prompt: async () => ({ ok: true }) }),
						close: async () => {},
					},
				} as never;
			},
			undefined,
			registry,
			testConfig(),
		);
		await sm.create("s1", { systemPrompt: "SYS" });
		const got = captured as { systemPrompt: (tc: unknown) => string; tools: Array<{ name: string }> };
		assert.equal(got.systemPrompt(undefined), `SYS\n\n${registry.indexBlock}`);
		const toolNames = got.tools.map((t) => t.name);
		assert.ok(toolNames.includes("load_skill"));
		assert.equal(toolNames.indexOf("load_skill"), toolNames.length - 1); // 尾部
	});

	it("appends index even with empty base prompt", async () => {
		const root = makeTempSkillDir();
		after(() => rmSync(root, { recursive: true, force: true }));
		const registry = new SkillRegistry(root, new Metrics());
		let captured: unknown = null;
		const sm = new SessionManager(
			[],
			"",
			undefined,
			async (cfg: unknown) => {
				captured = cfg;
				return {
					harness: {
						events: { on: () => () => {} },
						lane: async () => ({ prompt: async () => ({ ok: true }) }),
						close: async () => {},
					},
				} as never;
			},
			undefined,
			registry,
			testConfig(),
		);
		await sm.create("s1", {});
		const cfg = captured as { systemPrompt: (tc: unknown) => string };
		assert.equal(cfg.systemPrompt(undefined), `${registry.indexBlock}`);
	});
});

describe("SessionManager BYOK override 透传（K-1）", () => {
	const OVERRIDE: SessionLlmOverride = {
		model: "deepseek-flash",
		apiKey: "sk-SECRET-DO-NOT-LEAK",
		baseUrl: "https://api.deepseek.com/",
		providerRef: "cmrrxageh000bql01xg1y6kjn::deepseek-flash",
		source: "user",
	};

	/** 假 modelFactory：捕获 override 并按它装配一个占位 model（不依赖 env 凭据）。 */
	function fakeModelFactory(onOverride: (override: SessionLlmOverride | undefined) => void) {
		return ((override?: SessionLlmOverride) => {
			onOverride(override);
			return {
				models: {},
				model: { id: override?.model ?? "env-model", provider: override ? "byok" : "agnes" },
				providerId: override ? "byok-hash" : "agnes",
			};
		}) as never;
	}

	/** 假 harnessFactory：捕获传入给 harness 的配置。 */
	function fakeHarnessFactory(onCfg: (cfg: unknown) => void) {
		return (async (cfg: unknown) => {
			onCfg(cfg);
			return {
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			} as never;
		}) as never;
	}

	it("create() 带 llm 时把 override 原样传给 modelFactory", async () => {
		let capturedOverride: SessionLlmOverride | undefined;
		const sm = new SessionManager(
			[],
			"",
			fakeModelFactory((o) => {
				capturedOverride = o;
			}),
			fakeHarnessFactory(() => {}),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s-byok", { llm: OVERRIDE });
		assert.deepEqual(capturedOverride, OVERRIDE);
	});

	it("create() 不带 llm 时 modelFactory 收到 undefined（env 装配）", async () => {
		let capturedOverride: SessionLlmOverride | undefined = OVERRIDE;
		const sm = new SessionManager(
			[],
			"",
			fakeModelFactory((o) => {
				capturedOverride = o;
			}),
			fakeHarnessFactory(() => {}),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s-env", {});
		assert.equal(capturedOverride, undefined);
	});

	it("harness 拿到的 model 是 override 装配结果（id = 渠道模型名）", async () => {
		let capturedCfg: unknown = null;
		const sm = new SessionManager(
			[],
			"",
			fakeModelFactory(() => {}),
			fakeHarnessFactory((cfg) => {
				capturedCfg = cfg;
			}),
			undefined,
			undefined,
			testConfig(),
		);
		const result = await sm.create("s-byok-2", { llm: OVERRIDE });
		const cfg = capturedCfg as { model: { id: string } };
		assert.equal(cfg.model.id, "deepseek-flash");
		assert.equal(result.provider, "byok-hash");
		assert.equal(result.model, "deepseek-flash");
	});
});

describe("SessionManager 用户取消 run（前端「停止」按钮）", () => {
	/**
	 * stub：prompt 一直挂起，直到传入 context 的 abortSignal 触发才 reject
	 * ——模拟 vendored pi 的真实取消语义（中断入口是 context 而非 prompt 参数）。
	 */
	const hangingFactory = async () =>
		({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({
					prompt: async (_text: string, _images: unknown, ctx: { abortSignal?: AbortSignal }) =>
						new Promise((_resolve, reject) => {
							ctx?.abortSignal?.addEventListener(
								"abort",
								() => reject(new Error("aborted")),
								{ once: true },
							);
						}),
				}),
				close: async () => {},
			},
		}) as never;

	it("无活跃 run 时 abort 返回 false（前端按 skipped 提示「已断开回复」）", async () => {
		const sm = new SessionManager([], "", undefined, hangingFactory, undefined, undefined, testConfig());
		await sm.create("s-cancel-idle", {});
		assert.equal(sm.abort("s-cancel-idle"), false);
	});

	it("abort 中断正在跑的 run，且会话保留（用户可接着发消息）", async () => {
		const sm = new SessionManager([], "", undefined, hangingFactory, undefined, undefined, testConfig());
		await sm.create("s-cancel-run", {});
		await sm.prompt("s-cancel-run", "hi");
		assert.equal(sm.abort("s-cancel-run"), true);
		assert.equal(sm.hasKey("s-cancel-run"), true);
	});

	it("用户取消不派发 error 事件（否则重连补发 buffer 会显示「出错了」的假警报）", async () => {
		const sm = new SessionManager([], "", undefined, hangingFactory, undefined, undefined, testConfig());
		await sm.create("s-cancel-noerr", {});
		const seen: string[] = [];
		sm.subscribe("s-cancel-noerr", (e) => seen.push(e.type));
		await sm.prompt("s-cancel-noerr", "hi");
		assert.equal(sm.abort("s-cancel-noerr"), true);
		await new Promise((r) => setTimeout(r, 20)); // 等挂起的 promise reject 被 catch 处理
		assert.deepEqual(seen.filter((t) => t === "error"), []);
	});

	it("未知 session abort 返回 false（不抛）", () => {
		const sm = new SessionManager([], "", undefined, hangingFactory, undefined, undefined, testConfig());
		assert.equal(sm.abort("nope"), false);
	});
});

describe("SessionManager 事件 seq 与增量重放（P0-③）", () => {
	/** 构造可手动派发 harness 事件的 fake harness。 */
	function makeEmittableHarnessFactory() {
		const handlers = new Map<string, (evt: { lane?: string }) => void>();
		const fakeHarnessFactory = async () => ({
			harness: {
				events: {
					on: (type: string, handler: (evt: { lane?: string }) => void) => {
						handlers.set(String(type), handler);
						return () => {};
					},
				},
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		}) as never;
		return { handlers, fakeHarnessFactory };
	}

	it("dispatch 为事件分配单调递增 seq", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		await sm.create("s-seq", {});
		const seen: number[] = [];
		sm.subscribe("s-seq", (e) => seen.push(e.seq));
		for (const t of ["run_start", "run_end"]) handlers.get(t)?.({ lane: "main" });
		assert.deepEqual(seen, [0, 1]);
	});

	it("subscribe 带 afterSeq 时只重放更晚的缓冲事件", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		await sm.create("s-replay", {});
		handlers.get("run_start")?.({ lane: "main" }); // seq 0
		handlers.get("run_end")?.({ lane: "main" }); // seq 1
		const live: number[] = [];
		// 重放语义对齐 index.ts 用法：缓冲经返回值补发，listener 只收实时事件
		const replay = sm.subscribe("s-replay", (e) => live.push(e.seq), 0);
		assert.deepEqual(replay.map((e) => e.seq), [1]); // seq 0 被跳过
		handlers.get("turn_start")?.({ lane: "main" }); // 实时事件 seq 2 照常送达
		assert.deepEqual(live, [2]);
	});

	it("afterSeq 早于 buffer 最旧 seq 时 best-effort 返回全部 buffered", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		await sm.create("s-overflow", {});
		// 灌满 buffer（BUFFER_LIMIT=500）再溢出 1 条 → 最旧 seq=0 被淘汰，buffer 最旧 seq=1
		for (let i = 0; i < 501; i++) handlers.get("run_start")?.({ lane: "main" });
		// 重放语义对齐 index.ts 用法：缓冲经返回值补发
		const replay = sm.subscribe("s-overflow", () => {}, 0);
		assert.equal(replay[0]?.seq, 1); // 首条是 seq 1 而非 seq 0
		assert.equal(replay.length, 500);
	});

	it("subscribeLive 不重放缓冲、只收未来事件（P0-A 跨轮重放回归锁）", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		await sm.create("s-live", {});
		// 模拟上一轮已产生的事件（buffer 跨轮残留）
		handlers.get("run_start")?.({ lane: "main" }); // seq 0
		handlers.get("run_end")?.({ lane: "main" }); // seq 1
		const seen: number[] = [];
		sm.subscribeLive("s-live", (e) => seen.push(e.seq));
		// 关键断言：缓冲里的 seq 0/1 绝不重放（否则上一轮 agent_end 会顶替本轮回答）
		assert.deepEqual(seen, []);
		handlers.get("turn_start")?.({ lane: "main" }); // 本轮新事件 seq 2 照常送达
		assert.deepEqual(seen, [2]);
	});

	it("subscribeLive 对未知键同样 fail-closed 抛 NotFoundError", async () => {
		const { fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		assert.throws(() => sm.subscribeLive("ghost", () => {}), NotFoundError);
	});
});

/**
 * 阻塞等待可见化（2026-10-01 生产事故修复）：等待**开始**就要把 `waiting_user` 送到前端。
 * 反例：等 tool_result 再反推「等待中」——阻塞模式下 result 要等等待结束才发，
 * 前端整段等待期只能显示「生成回复中 · Ns」（= 用户看到的卡死）。
 */
describe("SessionManager.dispatchWaitingUser（阻塞等待广播）", () => {
	/** 建会话用的最小 fake harness（沿用 P0-③ 用例的同款替身）。 */
	function smWithSession(canvasSessionId?: string) {
		const fakeHarnessFactory = async () =>
			({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			}) as never;
		return new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
	}

	it("按画布会话 id 命中会话并派发 waiting 事件（含 nodeId/timeoutMs）", async () => {
		const sm = smWithSession();
		await sm.create("thread-1", { canvasSessionId: "canvas-9" });
		const seen: Array<{ type: string; data: unknown }> = [];
		sm.subscribe("thread-1", (e) => seen.push({ type: e.type, data: e.data }));
		const hits = sm.dispatchWaitingUser("canvas-9", {
			status: "waiting",
			toolName: "propose_generation",
			callId: "c1",
			timeoutMs: 300_000,
			nodeId: "node-7",
		});
		assert.equal(hits, 1);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.type, "waiting_user");
		assert.deepEqual(seen[0]?.data, {
			status: "waiting",
			toolName: "propose_generation",
			callId: "c1",
			timeoutMs: 300_000,
			nodeId: "node-7",
		});
	});

	it("resolved 同样广播（前端据此收口等待态）", async () => {
		const sm = smWithSession();
		await sm.create("thread-2", { canvasSessionId: "canvas-9" });
		const seen: string[] = [];
		sm.subscribe("thread-2", (e) => seen.push(e.type));
		sm.dispatchWaitingUser("canvas-9", {
			status: "resolved",
			toolName: "ask_user",
			callId: "c2",
			reason: "answered",
		});
		assert.deepEqual(seen, ["waiting_user"]);
	});

	it("未建 canvasSessionId 时回落 pi 会话键；无匹配会话静默返回 0（不抛错）", async () => {
		const sm = smWithSession();
		await sm.create("thread-3", {}); // 无 canvasSessionId → 键回落 pi 会话键（= entry.id，哈希后的键）
		// 与工具域 / abort 联动同一条取键路径：sessions 的键是 toSessionKey 后的值，不是原始 threadKey
		const fallbackKey = sm.getCanvasSessionId(toSessionKey("thread-3"));
		assert.equal(
			sm.dispatchWaitingUser(fallbackKey, { status: "waiting", toolName: "ask_user", callId: "c3" }),
			1,
		);
		assert.equal(
			sm.dispatchWaitingUser("ghost-session", { status: "waiting", toolName: "ask_user", callId: "c4" }),
			0,
		); // 会话在别的实例 / 已被 sweeper 回收：不是错误
	});
});

describe("SessionManager contextWindow 入会话条目（压缩阈值基准 · 诊断 F-01）", () => {
	/** 假 modelFactory：返回带指定 contextWindow 的 model（不依赖 env 凭据）。 */
	function modelFactoryWithWindow(contextWindow: number) {
		return (() => ({
			models: {},
			model: { id: "probe-model", contextWindow },
			providerId: "probe",
		})) as never;
	}

	const probeHarnessFactory = async () =>
		({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		}) as never;

	const windowOf = (sm: SessionManager, key: string): number | undefined =>
		(sm as unknown as { sessions: Map<string, { contextWindow?: number }> })
			.sessions.get(toSessionKey(key))?.contextWindow;

	it("create 时把 model.contextWindow 记入会话条目", async () => {
		const sm = new SessionManager(
			[],
			"",
			modelFactoryWithWindow(128_000),
			probeHarnessFactory,
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s-win", {});
		assert.equal(windowOf(sm, "s-win"), 128_000);
	});

	it("config.compactionContextWindow 优先于 model 声明值（绕过 agnes 的 100 万）", async () => {
		// Review Focus #1：没有这条覆盖时，阈值 = 1_000_000 - reserveTokens 永不触及，
		// 触发链路接好了也一次都不会压缩，且极易被误判为「已修好」。
		const sm = new SessionManager(
			[],
			"",
			modelFactoryWithWindow(1_000_000),
			probeHarnessFactory,
			undefined,
			undefined,
			{ ...testConfig(), compactionContextWindow: 128_000 },
		);
		await sm.create("s-win-override", {});
		assert.equal(windowOf(sm, "s-win-override"), 128_000);
	});

	it("model 未声明 contextWindow 时为 undefined（fail-safe：判定走 no_window 不压缩）", async () => {
		const sm = new SessionManager(
			[],
			"",
			(() => ({ models: {}, model: { id: "probe-model" }, providerId: "probe" })) as never,
			probeHarnessFactory,
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s-win-none", {});
		assert.equal(windowOf(sm, "s-win-none"), undefined);
	});
});

describe("SessionManager run 后压缩触发（诊断 F-01 · 补上缺失的触发者）", () => {
	/** 带 usage 的 assistant message entry（vendor Entry 的最小形状）。 */
	function usageEntry(totalTokens: number) {
		return {
			type: "message",
			message: { role: "assistant", stopReason: "stop", usage: { totalTokens } },
		} as never;
	}

	/**
	 * 假 lane。`gate` 给定时 prompt 会挂起——用于构造「取消先于 then 回调执行」的时序，
	 * 否则 then 会在 `await mgr.prompt()` 的让出中先跑完，abort 就追不上它了。
	 */
	function makeLane(calls: string[], totalTokens: number, gate?: Promise<unknown>, opts?: unknown[]) {
		return {
			prompt: async () => {
				if (gate) await gate;
				return { ok: true, value: {} };
			},
			findEntries: async () => [usageEntry(totalTokens)],
			compact: async (options: unknown) => {
				calls.push("compact");
				opts?.push(options);
				return { ok: true, value: {} };
			},
		};
	}

	/** contextWindow=128_000 + reserveTokens=16_384 → 阈值 111_616。 */
	function managerWithLane(lane: unknown, metrics?: Metrics, extra?: Partial<RuntimeConfig>) {
		return new SessionManager(
			[],
			"",
			(() => ({
				models: {},
				model: { id: "probe-model", contextWindow: 128_000 },
				providerId: "probe",
			})) as never,
			(async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => lane,
					close: async () => {},
				},
			})) as never,
			undefined,
			undefined,
			{
				...testConfig(),
				compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
				...extra,
			},
			undefined,
			metrics,
		);
	}

	// maybeCompact 内部有 await 链；setImmediate 排到下一个宏任务，其前的所有微任务已跑完。
	const drain = () => new Promise<void>((r) => setImmediate(r));

	it("超阈值时在 run 结束后触发一次压缩", async () => {
		const calls: string[] = [];
		const mgr = managerWithLane(makeLane(calls, 120_000));
		await mgr.create("s-compact", {});
		await mgr.prompt("s-compact", "hi");
		await drain();
		assert.deepEqual(calls, ["compact"]);
	});

	it("压缩时把中文保留段传给 lane.compact（Round2 W2① / 首轮 P2-1）", async () => {
		const calls: string[] = [];
		const opts: unknown[] = [];
		const mgr = managerWithLane(makeLane(calls, 120_000, undefined, opts));
		await mgr.create("s-retention", {});
		await mgr.prompt("s-retention", "hi");
		await drain();
		assert.deepEqual(calls, ["compact"]);
		// vendor `lane.ts:1204` 只在 options?.customInstructions !== undefined 时透传，
		// compaction.ts:567 拼成 "\n\nAdditional focus: <段>" 追加进摘要 prompt。
		//
		// ⚠️ 2026-10-04：这里从「逐字节等于静态常量」放宽为「以静态常量开头 + 含动态段」。
		// 起因是 PR #142 补了 Nest 侧真实状态（画布里`pending_confirm` 的节点 id），
		// 保留段变成**两层**：静态清单（说「要保留哪几类」）+ 动态状态（说「是哪个节点」）。
		// 静态清单单独存在时说不出具体节点 id，动态状态单独存在时说不出还应保留哪几类，
		// 少任何一层都不完整。逐字节断言在两层合并后必然失败，故改为语义断言。
		const first = opts[0] as { customInstructions?: string };
		assert.equal(typeof first.customInstructions, "string");
		assert.ok(
			first.customInstructions?.startsWith(COMPACTION_RETENTION_INSTRUCTIONS),
			"必须以静态清单开头（#141 的内容不能在合并中丢掉）",
		);
		assert.ok(
			first.customInstructions?.includes("必须跨压缩保留"),
			"必须含动态保留段（#142 的buildRetentionInstructions 输出）",
		);
	});

	it("compactionRetention=false：lane.compact 收到 undefined（与本改动前逐字节一致）", async () => {
		const calls: string[] = [];
		const opts: unknown[] = [];
		const mgr = managerWithLane(makeLane(calls, 120_000, undefined, opts), undefined, {
			compactionRetention: false,
		});
		await mgr.create("s-retention-off", {});
		await mgr.prompt("s-retention-off", "hi");
		await drain();
		assert.deepEqual(calls, ["compact"]);
		assert.equal(opts[0], undefined);
	});

	it("用户取消的那一轮不触发压缩（不偷偷发起摘要 LLM 调用）", async () => {
		const calls: string[] = [];
		let release!: (v: unknown) => void;
		const gate = new Promise((r) => {
			release = r;
		});
		const mgr = managerWithLane(makeLane(calls, 120_000, gate));
		await mgr.create("s-compact-abort", {});
		await mgr.prompt("s-compact-abort", "hi");
		assert.equal(mgr.abort("s-compact-abort"), true);
		release(undefined);
		await drain();
		assert.deepEqual(calls, []);
	});

	it("连续两轮都超阈值 → 每轮各触发一次，而非某一轮重复触发", async () => {
		const calls: string[] = [];
		const mgr = managerWithLane(makeLane(calls, 120_000));
		await mgr.create("s-compact-twice", {});
		await mgr.prompt("s-compact-twice", "一轮");
		await drain();
		await mgr.prompt("s-compact-twice", "二轮");
		await drain();
		assert.deepEqual(calls, ["compact", "compact"]);
	});

	it("低于阈值时不触发压缩", async () => {
		const calls: string[] = [];
		const mgr = managerWithLane(makeLane(calls, 1_000));
		await mgr.create("s-compact-low", {});
		await mgr.prompt("s-compact-low", "hi");
		await drain();
		assert.deepEqual(calls, []);
	});

	it("compact 成功时不计 skip（ok 由 compaction_end 事件计，钩子再计一次会翻倍）", async () => {
		// Review Focus #4 的真正落地点：metrics 本身的测试证明不了「调用方有没有多计一次」。
		const metrics = new Metrics();
		const calls: string[] = [];
		const mgr = managerWithLane(makeLane(calls, 120_000), metrics);
		await mgr.create("s-compact-ok", {});
		await mgr.prompt("s-compact-ok", "hi");
		await drain();
		assert.deepEqual(calls, ["compact"]);
		assert.ok(!metrics.render(0, "test").includes("pi_runtime_compaction_skips_total{"));
	});

	it("低于阈值时计 below_threshold 而非静默（证明判定链路真的在跑）", async () => {
		const metrics = new Metrics();
		const mgr = managerWithLane(makeLane([], 1_000), metrics);
		await mgr.create("s-compact-skip", {});
		await mgr.prompt("s-compact-skip", "hi");
		await drain();
		assert.match(metrics.render(0, "test"), /pi_runtime_compaction_skips_total\{reason="below_threshold"\} 1/);
	});

	it("compact 失败时按错误类计 skip（Closed = TTL 争抢，可容忍跳过）", async () => {
		// Review Focus #5：压缩是异步的，sweeper 在途释放句柄会以 Closed 失败；
		// 这必须归为「可容忍跳过」，不能混进 compressions_total 的 error。
		const metrics = new Metrics();
		const lane = {
			prompt: async () => ({ ok: true, value: {} }),
			findEntries: async () => [usageEntry(120_000)],
			compact: async () => ({ ok: false, error: new Closed({ message: "swept" }) }),
		};
		const mgr = managerWithLane(lane, metrics);
		await mgr.create("s-compact-closed", {});
		await mgr.prompt("s-compact-closed", "hi");
		await drain();
		assert.match(metrics.render(0, "test"), /pi_runtime_compaction_skips_total\{reason="closed"\} 1/);
	});

	it("lane 缺 findEntries 时计 lane_unavailable，而不是被静默吞成「一切正常」", async () => {
		// 与 F-01 同构的「假修好」风险：`.catch(() => [])` 会把 TypeError（替身缺失 /
		// 未来 vendor 改名）吞成空条目 → 判定 below_threshold，指标全绿而压缩从不触发。
		// 缺方法时必须是**显式 skip 理由**，让运营能从指标上看出链路断了。
		const metrics = new Metrics();
		const calls: string[] = [];
		const lane = {
			prompt: async () => ({ ok: true, value: {} }),
			compact: async () => {
				calls.push("compact");
				return { ok: true, value: {} };
			},
		};
		const mgr = managerWithLane(lane, metrics);
		await mgr.create("s-compact-nofind", {});
		await mgr.prompt("s-compact-nofind", "hi");
		await drain();
		assert.deepEqual(calls, []);
		assert.match(metrics.render(0, "test"), /pi_runtime_compaction_skips_total\{reason="lane_unavailable"\} 1/);
	});

	it("扫条目失败计 entries_unavailable，不得伪装成 below_threshold", async () => {
		// IO 失败与「用了还没到阈值」是两件事：混成一个 label 会让低于阈值的那个
		// label 永远不可信（无法判断到底有没有读到 usage）。
		const metrics = new Metrics();
		const calls: string[] = [];
		const lane = {
			prompt: async () => ({ ok: true, value: {} }),
			findEntries: async () => {
				throw new Error("disk read failed");
			},
			compact: async () => {
				calls.push("compact");
				return { ok: true, value: {} };
			},
		};
		const mgr = managerWithLane(lane, metrics);
		await mgr.create("s-compact-scanfail", {});
		await mgr.prompt("s-compact-scanfail", "hi");
		await drain();
		assert.deepEqual(calls, []);
		const text = metrics.render(0, "test");
		assert.match(text, /pi_runtime_compaction_skips_total\{reason="entries_unavailable"\} 1/);
		assert.ok(!text.includes('reason="below_threshold"'));
	});
});

describe("SessionManager 压缩 × 后续请求的竞争（reviewer Critical #1）", () => {
	/** 手写哨兵：断言点到为止，避免引入断言库之外的依赖。 */
	function usageEntry(totalTokens: number) {
		return {
			type: "message",
			message: { role: "assistant", stopReason: "stop", usage: { totalTokens } },
		} as never;
	}

	/**
	 * 忠实替身 lane：实现 vendor Lane 的「同一时刻只允许一个 active operation」不变式
	 * （vendor lane.ts:575 `state.operation !== null → LaneBusy`）。
	 *
	 * 之前所有假 lane 都没有这条不变式（compact 立即 resolve），因此那个竞争窗口
	 * 在测试里被构造掉了——这正是这类缺陷此前测试不到的原因。
	 */
	function busyAwareLane(release: Promise<void>) {
		let operation: string | null = null;
		return {
			prompt: async () => {
				if (operation !== null) return { ok: false, error: new Error("LaneBusy: active operation") };
				return { ok: true, value: {} };
			},
			findEntries: async () => [usageEntry(120_000)],
			compact: async () => {
				operation = "compaction";
				await release;
				operation = null;
				return { ok: true, value: {} };
			},
		};
	}

	function managerWithBusyLane(lane: unknown) {
		return new SessionManager(
			[],
			"",
			(() => ({
				models: {},
				model: { id: "probe-model", contextWindow: 128_000 },
				providerId: "probe",
			})) as never,
			(async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => lane,
					close: async () => {},
				},
			})) as never,
			undefined,
			undefined,
			{ ...testConfig(), compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
		);
	}

	const drain = () => new Promise<void>((r) => setImmediate(r));

	it("压缩在途时新的 prompt 走 BusyError，而不是跑进 run 里让用户收一个无回答的 error", async () => {
		let _resolve!: () => void;
		const release = new Promise<void>((r) => {
			_resolve = r;
		});
		const mgr = managerWithBusyLane(busyAwareLane(release));
		mgr.compactionMaxWaitMs = 50; // 本用例故意不让 compact 返回，缩短 deadline 以免拖长进程退出
		await mgr.create("s-busy-compact", {});
		await mgr.prompt("s-busy-compact", "第一轮");
		await drain(); // 压缩已发起且仍在途（release 未 resolve）

		const events: string[] = [];
		mgr.subscribe("s-busy-compact", (e) => events.push(e.type));
		// 修复前：这里返回 {accepted:true}，用户随后只收到一个 error 事件、拿不到任何回答
		await assert.rejects(() => mgr.prompt("s-busy-compact", "第二轮"), BusyError);
		await drain();
		assert.deepEqual(events.filter((t) => t === "error"), []);
	});

	it("判定阶段（findEntries 尚未返回）也不放行新 prompt —— 置位必须早于第一个 await", async () => {
		// Critical #2（C2）：置位若排在 await findEntries 之后，run 的 .finally 已经清了
		// prompting，而 compressing 还没置上 —— 这中间会话对外完全空闲，请求会溜进去。
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const lane = {
			prompt: async () => ({ ok: true, value: {} }),
			findEntries: async () => {
				await gate;
				return [usageEntry(120_000)];
			},
			compact: async () => ({ ok: true, value: {} }),
		};
		const mgr = managerWithBusyLane(lane);
		await mgr.create("s-busy-decide", {});
		await mgr.prompt("s-busy-decide", "第一轮");
		await drain(); // findEntries 仍挂起，压缩既未置位也未发起
		await assert.rejects(() => mgr.prompt("s-busy-decide", "第二轮"), BusyError);
		release();
	});
});

describe("SessionManager 压缩 × 条目顺序（vendor findEntries 缺省倒序）", () => {
	/**
	 * vendor 的 `getLastAssistantUsage` 从 `entries[length-1]` 往前扫（**末元素视为最新**），
	 * 而 `lane.findEntries` 的缺省 order 是 `newestFirst`（**首元素最新**，vendor lane.ts:1906）。
	 * 两者方向相反 —— vendor 自己先 `.reverse()` 后才喂给 prepareCompaction（lane.ts:703-709）。原样透传会让多轮会话取到**第一轮**的 usage：contextTokens 恒为几千，
	 * 压缩永不触发，而 skips_total{below_threshold} 照常累加（典型的「假修好」）。
	 */
	function usageEntry(totalTokens: number) {
		return {
			type: "message",
			message: { role: "assistant", stopReason: "stop", usage: { totalTokens } },
		} as never;
	}

	function managerWithBusyLane(lane: unknown) {
		return new SessionManager(
			[],
			"",
			(() => ({
				models: {},
				model: { id: "probe-model", contextWindow: 128_000 },
				providerId: "probe",
			})) as never,
			(async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => lane,
					close: async () => {},
				},
			})) as never,
			undefined,
			undefined,
			{ ...testConfig(), compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
		);
	}

	it("多轮会话取到的是最近一轮的 usage（压缩确实触发）", async () => {
		const calls: string[] = [];
		// 按真实语义构造：oldestFirst → [旧, 新]；newestFirst → [新, 旧]。
		// 若调用方忘了显式声明 order，这里就会返回倒序数组，等价于线上那个缺陷。
		const chronological = [usageEntry(1_000), usageEntry(120_000)];
		const mgr = managerWithBusyLane({
			prompt: async () => ({ ok: true, value: {} }),
			findEntries: async (q: { order?: string }) =>
				q?.order === "oldestFirst" ? chronological : [...chronological].reverse(),
			compact: async () => {
				calls.push("compact");
				return { ok: true, value: {} };
			},
		});
		await mgr.create("s-order-multi", {});
		await mgr.prompt("s-order-multi", "hi");
		await new Promise<void>((r) => setImmediate(r));
		// 修复前：取到的是倒序后的末元素 1_000 → below_threshold → 空数组
		assert.deepEqual(calls, ["compact"]);
	});

	it("findEntries 查询形状：oldestFirst + stopAtType=compaction（与 vendor 同构）", async () => {
		const queries: unknown[] = [];
		const mgr = managerWithBusyLane({
			prompt: async () => ({ ok: true, value: {} }),
			findEntries: async (q: unknown) => {
				queries.push(q);
				return [usageEntry(1_000)];
			},
			compact: async () => ({ ok: true, value: {} }),
		});
		await mgr.create("s-order-query", {});
		await mgr.prompt("s-order-query", "hi");
		await new Promise<void>((r) => setImmediate(r));
		assert.deepEqual(queries, [{ order: "oldestFirst", stopAtType: "compaction" }]);
	});
});

describe("SessionManager 压缩 deadline（Important #2：会话不得被永久卡死）", () => {
	function usageEntry(totalTokens: number) {
		return {
			type: "message",
			message: { role: "assistant", stopReason: "stop", usage: { totalTokens } },
		} as never;
	}

	function managerWithLane(lane: unknown, metrics?: Metrics) {
		return new SessionManager(
			[],
			"",
			(() => ({
				models: {},
				model: { id: "probe-model", contextWindow: 128_000 },
				providerId: "probe",
			})) as never,
			(async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => lane,
					close: async () => {},
				},
			})) as never,
			undefined,
			undefined,
			{ ...testConfig(), compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
			undefined,
			metrics,
		);
	}

	it("摘要调用挂死时 deadline 兜底：compacting 归位 + 计 timeout skip", async () => {
		const metrics = new Metrics();
		// 忠实替身：只有 context 被 abort 才会 reject（模拟「上游连着但不返回」）
		const lane = {
			prompt: async () => ({ ok: true, value: {} }),
			findEntries: async () => [usageEntry(120_000)],
			compact: (_target: unknown, ctx: { abortSignal?: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					ctx?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
		};
		const mgr = managerWithLane(lane, metrics);
		mgr.compactionMaxWaitMs = 30; // 仅测试注入
		await mgr.create("s-compact-hang", {});
		await mgr.prompt("s-compact-hang", "hi");

		await new Promise<void>((r) => setTimeout(r, 120));
		// ① 指标：挂死的摘要被记为 timeout，而不是就此消失
		assert.match(metrics.render(0, "test"), /pi_runtime_compaction_skips_total\{reason="timeout"\} 1/);
		// ② 关键：会话没有被永久锁死，用户还能继续用
		await assert.doesNotReject(() => mgr.prompt("s-compact-hang", "再来一轮"));
	});
});

/**
 * 审计 #6/#7：compaction_end(completed) 后读最新 compaction entry——
 * 摘要缺段计 metrics（观测告警），摘要全文经回调上报（Nest 落 ContextSnapshot）。
 * fail-soft：lane 缺失/扫盘失败绝不影响会话主链路。
 */
describe("SessionManager 压缩摘要审计（compaction-summary）", () => {
	const drain = () => new Promise<void>((r) => setImmediate(r));
	/** 只含 Goal 一段（缺 7 段）的假 compaction entry。 */
	const gapEntry = {
		type: "compaction",
		summary: "## Goal\n做成画布\n\n## Next Steps\nn\n",
		tokensBefore: 12345,
	};

	function auditManager(metrics: Metrics, onSnapshot?: (p: unknown) => void) {
		const handlers = new Map<string, (evt: { status?: string }) => void>();
		const factory = (async () =>
			({
				harness: {
					events: {
						on: (type: string, cb: (evt: { status?: string }) => void) => {
							handlers.set(type, cb);
							return () => {};
						},
					},
					lane: async () => ({
						prompt: async () => ({ ok: true }),
						findEntries: async () => [gapEntry],
					}),
					close: async () => {},
				},
			})) as never;
		const sm = new SessionManager(
			[],
			"",
			undefined,
			factory,
			undefined,
			undefined,
			testConfig(),
			undefined,
			metrics,
			onSnapshot ? { onSnapshot } : undefined,
		);
		return { sm, handlers };
	}

	it("compaction_end(completed)：缺段计 metrics + snapshot 回调收到全文与 token 数", async () => {
		const metrics = new Metrics();
		const snapshots: Array<Record<string, unknown>> = [];
		const { sm, handlers } = auditManager(metrics, (p) => snapshots.push(p as Record<string, unknown>));
		await sm.create("s-csum:t1", {});
		handlers.get("compaction_end")?.({ status: "completed" });
		await drain();
		await drain();
		// Goal / Next Steps 在位，其余 6 段缺失（含 Progress 的 3 个 H3）
		const text = metrics.render(0, "test");
		assert.match(text, /pi_runtime_compaction_summary_missing_total\{section="### In Progress"\} 1/);
		assert.match(text, /pi_runtime_compaction_summary_missing_total\{section="## Critical Context"\} 1/);
		assert.ok(!text.includes('section="## Goal"'));
		assert.equal(snapshots.length, 1);
		assert.equal(snapshots[0].stage, "compaction");
		assert.equal(snapshots[0].planSummary, gapEntry.summary);
		assert.equal(snapshots[0].messageCount, 12345);
		assert.equal(snapshots[0].threadId, toSessionKey("s-csum:t1"));
	});

	it("declined/failed 不触发审计；lane 扫盘失败静默（fail-soft）", async () => {
		const metrics = new Metrics();
		const snapshots: unknown[] = [];
		const { sm, handlers } = auditManager(metrics, (p) => snapshots.push(p));
		await sm.create("s-csum2:t1", {});
		handlers.get("compaction_end")?.({ status: "declined" });
		await drain();
		await drain();
		assert.equal(snapshots.length, 0);
		assert.ok(!metrics.render(0, "test").includes("pi_runtime_compaction_summary_missing_total{"));
	});
});

/**
 * 「正在做什么」可见化（决策 8）：工具**起手**那一刻就广播 `activity`，
 * 状态行不必等 tool_end 落地才换词 —— 长工具期间停在上一句正是用户说的「卡住」。
 * 载荷只给英文工具名 + 步号，中文由客户端目录翻译（决策 7：agent 只声明意图）。
 */
describe("SessionManager activity 广播（决策 8 · 正在做什么）", () => {
	/** 可 emit 的替换 harness（与 seq 用例同款，作用域内自持，不依赖其它 describe 的局部 helper）。 */
	function activityHarness() {
		const handlers = new Map<
			string,
			(evt: { lane?: string; toolName?: string; toolCallId?: string; status?: string }) => void
		>();
		const fakeHarnessFactory = async () =>
			({
				harness: {
					events: {
						on: (
							type: string,
							handler: (evt: { lane?: string; toolName?: string; toolCallId?: string; status?: string }) => void,
						) => {
							handlers.set(String(type), handler);
							return () => {};
						},
					},
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			}) as never;
		return { handlers, fakeHarnessFactory };
	}

	function smWithActivitySession() {
		const { handlers, fakeHarnessFactory } = activityHarness();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		return { sm, handlers };
	}

	it("tool_start 紧跟一条 activity，排在 tool_execution_start 之前（同帧）", async () => {
		const { sm, handlers } = smWithActivitySession();
		await sm.create("a-1", {});
		const seen: Array<{ type: string; data: unknown }> = [];
		sm.subscribe("a-1", (e) => seen.push({ type: e.type, data: e.data }));

		handlers.get("tool_start")?.({ lane: "main", toolName: "upsert_media_node", toolCallId: "c1" });

		assert.deepEqual(seen.map((e) => e.type), ["activity", "tool_execution_start"]);
		assert.deepEqual(seen[0]?.data, { toolName: "upsert_media_node", done: 1 });
	});

	it("连续工具 done 递增；turn_start 归零（跨轮不累计成假进度）", async () => {
		const { sm, handlers } = smWithActivitySession();
		await sm.create("a-2", {});
		const seen: Array<{ type: string; data: unknown }> = [];
		sm.subscribe("a-2", (e) => seen.push({ type: e.type, data: e.data }));

		handlers.get("tool_start")?.({ lane: "main", toolName: "get_canvas_summary" }); // done 1
		handlers.get("tool_start")?.({ lane: "main", toolName: "web_search" }); // done 2
		handlers.get("turn_start")?.({ lane: "main" }); // 步数归零，但本身不发 activity
		handlers.get("tool_start")?.({ lane: "main", toolName: "propose_generation" }); // done 1

		assert.deepEqual(
			seen.filter((e) => e.type === "activity").map((e) => e.data),
			[
				{ toolName: "get_canvas_summary", done: 1 },
				{ toolName: "web_search", done: 2 },
				{ toolName: "propose_generation", done: 1 },
			],
		);
	});

	it("activity 载荷不含中文 label：翻译责任在客户端目录（决策 7）", async () => {
		const { sm, handlers } = smWithActivitySession();
		await sm.create("a-3", {});
		const seen: Array<{ type: string; data: unknown }> = [];
		sm.subscribe("a-3", (e) => seen.push({ type: e.type, data: e.data }));

		handlers.get("tool_start")?.({ lane: "main", toolName: "upsert_media_node" });

		assert.deepEqual(Object.keys((seen[0]?.data ?? {}) as object).sort(), ["done", "toolName"]);
	});

	it("activity 进 buffer：重连回放能补回等待期的「正在做什么」（P0-③ 增量重放语义）", async () => {
		const { sm, handlers } = smWithActivitySession();
		await sm.create("a-4", {});
		handlers.get("tool_start")?.({ lane: "main", toolName: "arrange_nodes" });
		// 重连补发 = 用 afterSeq=-1（无历史 seq）取全部 buffer，activity 应已在补发列表里
		const reconnected = sm.subscribe("a-4", () => {}, -1);
		const types = reconnected.map((e) => e.type);
		assert.deepEqual(types, ["activity", "tool_execution_start"]); // 补发含 activity，重连后状态行不会空着
	});
});

describe("usage 事件 → metrics（审计 P0-③）", () => {
	/** 本地可派发 fake（与上方 seq 组的实现同构，作用域独立）。 */
	function makeEmittableHarnessFactory() {
		const handlers = new Map<string, (evt: { lane?: string }) => void>();
		const fakeHarnessFactory = async () => ({
			harness: {
				events: {
					on: (type: string, handler: (evt: { lane?: string }) => void) => {
						handlers.set(String(type), handler);
						return () => {};
					},
				},
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		}) as never;
		return { handlers, fakeHarnessFactory };
	}

	const USAGE = {
		input: 100,
		output: 50,
		cacheRead: 10,
		cacheWrite: 5,
		totalTokens: 165,
		cost: { input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0 },
	};

	it("harness 发 usage 事件时进 metrics 累计", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const metrics = new Metrics();
		const sm = new SessionManager(
			[],
			"",
			undefined,
			fakeHarnessFactory,
			undefined,
			undefined,
			testConfig(),
			undefined,
			metrics,
		);
		await sm.create("s-usage-metrics", {});
		handlers.get("usage")?.({ lane: "main", row: { usage: USAGE } } as never);
		const out = metrics.render(0, "test");
		assert.match(out, /pi_runtime_usage_tokens_total\{kind="input"\} 100/);
		assert.match(out, /pi_runtime_usage_cost_total\{kind="output"\} 0\.5/);
	});

	it("usage 事件不进 SSE/事件缓冲（Nest 未知事件类型防御）", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
		await sm.create("s-usage-sse", {});
		const seen: string[] = [];
		sm.subscribe("s-usage-sse", (e) => seen.push(e.type));
		handlers.get("usage")?.({ lane: "main", row: { usage: USAGE } } as never);
		assert.deepEqual(seen, []);
	});
});

describe("tiering-on 接线（评审 finding 3：集成缝必须有钉）", () => {
	function makeEmittableHarnessFactory2() {
		let captured: Record<string, unknown> | undefined;
		const fakeHarnessFactory = async (cfg: unknown) => {
			captured = cfg as Record<string, unknown>;
			return {
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			} as never;
		};
		return {
			get captured() {
				return captured;
			},
			fakeHarnessFactory,
		};
	}
	const tieringConfig = () => ({ ...testConfig(), toolTiering: true });

	it("tiering-on：全量注册（含延迟工具），activeToolNames 收窄为常驻 + tool_search", async () => {
		const h = makeEmittableHarnessFactory2();
		const sm = new SessionManager(
			[{ name: "t_probe" } as never, { name: "get_canvas_summary" } as never],
			"",
			undefined,
			h.fakeHarnessFactory as never,
			undefined,
			undefined,
			tieringConfig(),
		);
		await sm.create("s-tiering", { systemPrompt: "BASE" });
		const toolNames = (h.captured!.tools as Array<{ name: string }>).map((t) => t.name);
		// 官方模式：延迟工具也注册进 config.tools（generation 只下发 active 的 schema）
		assert.deepEqual(toolNames.sort(), ["get_canvas_summary", "t_probe", "tool_search"]);
		const active = (h.captured!.activeToolNames as string[]).slice().sort();
		// 初始激活只含常驻 + loader；t_probe 要靠 tool_search 的 addedToolNames 激活
		assert.deepEqual(active, ["get_canvas_summary", "tool_search"]);
	});

	it("tiering-on：staticPrompt 不含延迟工具索引块（官方模式不给名单，发现靠 tool_search 搜索）", async () => {
		const h = makeEmittableHarnessFactory2();
		const sm = new SessionManager(
			[{ name: "t_probe" } as never],
			"",
			undefined,
			h.fakeHarnessFactory as never,
			undefined,
			undefined,
			tieringConfig(),
		);
		await sm.create("s-tiering-once", { systemPrompt: "BASE" });
		const prompt = await (h.captured!.systemPrompt as (tc: unknown) => Promise<string> | string)({});
		assert.equal(String(prompt).match(/以下工具未加载完整定义/g)?.length ?? 0, 0);
	});
});

describe("appendPromptBlocks 幂等（评审 finding 1：fork 重复拼块）", () => {
	it("base 已含块时不重复追加", () => {
		const block = "以下工具未加载完整定义（省上下文）";
		const base = `BASE\n\n${block}\n- t_probe：x`;
		const out = appendPromptBlocks(base, [block]);
		assert.equal((out.match(/以下工具未加载完整定义/g) ?? []).length, 1);
	});
	it("base 未含块时正常追加（\\n\\n 连接，空块跳过）", () => {
		const out = appendPromptBlocks("BASE", ["B1", "", "B2"]);
		assert.equal(out, "BASE\n\nB1\n\nB2");
	});
	it("base 为空时只返回非空块", () => {
		assert.equal(appendPromptBlocks("", ["B1"]), "B1");
	});
});
