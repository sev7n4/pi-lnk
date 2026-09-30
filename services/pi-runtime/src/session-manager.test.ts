import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, BusyError, NotFoundError, toSessionKey } from "./session-manager.js";
import type { SessionLlmOverride } from "./model-assembly.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";
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
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
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
		assert.equal(cfg.systemPrompt(undefined), "SYS");
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
		assert.equal(cfg.systemPrompt(undefined), "SYS");
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
		assert.equal(cfg.systemPrompt(undefined), registry.indexBlock);
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
	function makeLane(calls: string[], totalTokens: number, gate?: Promise<unknown>) {
		return {
			prompt: async () => {
				if (gate) await gate;
				return { ok: true, value: {} };
			},
			findEntries: async () => [usageEntry(totalTokens)],
			compact: async () => {
				calls.push("compact");
				return { ok: true, value: {} };
			},
		};
	}

	/** contextWindow=128_000 + reserveTokens=16_384 → 阈值 111_616。 */
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
