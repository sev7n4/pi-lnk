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
