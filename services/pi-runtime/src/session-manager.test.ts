import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import type { SessionLlmOverride } from "./model-assembly.js";
import { Metrics } from "./metrics.js";
import { SkillRegistry } from "./skills/registry.js";

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
		const sm = new SessionManager([{ name: "t_probe" } as never], "", undefined, fakeHarnessFactory);
		await sm.create("s1", {
			userId: "u1",
			systemPrompt: "SYS",
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
			mentionedKeys: ["I1"],
			refOrder: ["I1"],
			focusNodeId: "node-1",
		});
		const cfg = captured as { systemPrompt: string; toolContext: Record<string, unknown>; thinkingLevel?: string };
		assert.equal(cfg.systemPrompt, "SYS");
		assert.equal(cfg.thinkingLevel, "medium");
		assert.equal(cfg.toolContext.userId, "u1");
		assert.equal(cfg.toolContext.sessionId, "s1");
		assert.deepEqual(cfg.toolContext.mentionedKeys, ["I1"]);
		assert.equal(cfg.toolContext.focusNodeId, "node-1");
		assert.deepEqual((cfg.toolContext.attachments as unknown[])[0], {
			url: "https://x/a.png",
			mediaType: "image",
		});
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
		});
		await sm.create("s1", {});
		assert.deepEqual(seen, [{ id: "s1", hasHarness: true }]);
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
		});
		await sm.create("s1", {});
		await sm.prompt("s1", "hello");
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(prompts, ["s1"]);
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
		const sm = new SessionManager([{ name: "t_probe" } as never], "", undefined, factory);
		await sm.create("s1", { systemPrompt: "SYS" });
		const cfg = captured as { systemPrompt: string; tools: Array<{ name: string }> };
		assert.equal(cfg.systemPrompt, "SYS");
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
		);
		await sm.create("s1", { systemPrompt: "SYS" });
		const got = captured as { systemPrompt: string; tools: Array<{ name: string }> };
		assert.equal(got.systemPrompt, `SYS\n\n${registry.indexBlock}`);
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
		);
		await sm.create("s1", {});
		const cfg = captured as { systemPrompt: string };
		assert.equal(cfg.systemPrompt, registry.indexBlock);
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
		const sm = new SessionManager([], "", undefined, hangingFactory);
		await sm.create("s-cancel-idle", {});
		assert.equal(sm.abort("s-cancel-idle"), false);
	});

	it("abort 中断正在跑的 run，且会话保留（用户可接着发消息）", async () => {
		const sm = new SessionManager([], "", undefined, hangingFactory);
		await sm.create("s-cancel-run", {});
		await sm.prompt("s-cancel-run", "hi");
		assert.equal(sm.abort("s-cancel-run"), true);
		assert.equal(sm.has("s-cancel-run"), true);
	});

	it("用户取消不派发 error 事件（否则重连补发 buffer 会显示「出错了」的假警报）", async () => {
		const sm = new SessionManager([], "", undefined, hangingFactory);
		await sm.create("s-cancel-noerr", {});
		const seen: string[] = [];
		sm.subscribe("s-cancel-noerr", (e) => seen.push(e.type));
		await sm.prompt("s-cancel-noerr", "hi");
		assert.equal(sm.abort("s-cancel-noerr"), true);
		await new Promise((r) => setTimeout(r, 20)); // 等挂起的 promise reject 被 catch 处理
		assert.deepEqual(seen.filter((t) => t === "error"), []);
	});

	it("未知 session abort 返回 false（不抛）", () => {
		const sm = new SessionManager([], "", undefined, hangingFactory);
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
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory);
		await sm.create("s-seq", {});
		const seen: number[] = [];
		sm.subscribe("s-seq", (e) => seen.push(e.seq));
		for (const t of ["run_start", "run_end"]) handlers.get(t)?.({ lane: "main" });
		assert.deepEqual(seen, [0, 1]);
	});

	it("subscribe 带 afterSeq 时只重放更晚的缓冲事件", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory);
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
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory);
		await sm.create("s-overflow", {});
		// 灌满 buffer（BUFFER_LIMIT=500）再溢出 1 条 → 最旧 seq=0 被淘汰，buffer 最旧 seq=1
		for (let i = 0; i < 501; i++) handlers.get("run_start")?.({ lane: "main" });
		// 重放语义对齐 index.ts 用法：缓冲经返回值补发
		const replay = sm.subscribe("s-overflow", () => {}, 0);
		assert.equal(replay[0]?.seq, 1); // 首条是 seq 1 而非 seq 0
		assert.equal(replay.length, 500);
	});
});
