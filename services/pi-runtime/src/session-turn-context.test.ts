import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BusyError, SessionManager, toSessionKey } from "./session-manager.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

function makeManager(root: string) {
	let captured: {
		systemPrompt: (tc?: unknown) => string;
		toolContext: (tc?: unknown) => Record<string, unknown>;
	} = { systemPrompt: () => "", toolContext: () => ({}) };
	const factory = (async (cfg: typeof captured & { session: unknown }) => {
		captured = cfg;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		};
	}) as never;
	const sm = new SessionManager([], "STATIC", undefined, factory, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: root,
	});
	return { sm, captured: () => captured };
}

describe("setTurnContext", () => {
	it("更新后 systemPrompt 函数返回最新动态块，且静态段在前", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm, captured } = makeManager(root);
			await sm.create("s1:t1", {});
			assert.equal(captured().systemPrompt(), "STATIC");
			const changed = sm.setTurnContext("s1:t1", { dynamicBlocks: ["当前画布摘要：{}"], mentionedKeys: ["I1"] });
			assert.equal(changed, true);
			assert.equal(captured().systemPrompt(), "STATIC\n\n当前画布摘要：{}");
			assert.deepEqual(captured().toolContext().mentionedKeys, ["I1"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("相同 turnContext 返回 false（不触发无谓刷新）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm } = makeManager(root);
			await sm.create("s1:t1", {});
			const turn = { dynamicBlocks: ["A"], mentionedKeys: ["I1"] };
			assert.equal(sm.setTurnContext("s1:t1", turn), true);
			assert.equal(sm.setTurnContext("s1:t1", { dynamicBlocks: ["A"], mentionedKeys: ["I1"] }), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("空动态块被清空：动态段消失、静态段仍在", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm, captured } = makeManager(root);
			await sm.create("s1:t1", {});
			sm.setTurnContext("s1:t1", { dynamicBlocks: ["A"] });
			assert.equal(captured().systemPrompt(), "STATIC\n\nA");
			assert.equal(sm.setTurnContext("s1:t1", { dynamicBlocks: [] }), true);
			assert.equal(captured().systemPrompt(), "STATIC");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("未创建会话时抛 NotFoundError", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		const { sm } = makeManager(root);
		assert.throws(() => sm.setTurnContext("nope", {}), /session not found/);
		rmSync(root, { recursive: true, force: true });
	});

	it("resolveSystemPromptForTest 与 harness 求值同一组合函数", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm, captured } = makeManager(root);
			await sm.create("s1:t1", {});
			sm.setTurnContext("s1:t1", { dynamicBlocks: ["A", "B"] });
			assert.equal(sm.resolveSystemPromptForTest("s1:t1"), captured().systemPrompt());
			assert.equal(sm.resolveSystemPromptForTest("s1:t1"), `STATIC\n\nA\n\nB`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("会话键归一：用合法键查询已 sanitize 的会话（防止嵌套转换）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm } = makeManager(root);
			await sm.create("s1:t1", {});
			assert.equal(sm.hasKey("s1:t1"), true);
			assert.equal(sm.setTurnContext("s1:t1", { focusNodeId: "n1" }), true);
			assert.equal(sm.activeKeys().has(toSessionKey("s1:t1")), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("prompt 并发守卫", () => {
	it("run 进行中再次 prompt 抛 BusyError；run 结束后可再 prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-busy-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const factory = (async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({
						prompt: async () => {
							await gate;
							return { ok: true };
						},
					}),
					close: async () => {},
				},
			})) as never;
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { ...DEFAULT_RUNTIME_CONFIG, dataRoot: root });
			await sm.create("s1:t1", {});
			await sm.prompt("s1:t1", "第一条");
			await assert.rejects(() => sm.prompt("s1:t1", "第二条"), (err: Error) => err instanceof BusyError);
			release(undefined);
			await new Promise((r) => setTimeout(r, 0));
			await sm.prompt("s1:t1", "第三条");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("busy 被拒的 prompt 不推进用户轮计数（onPrompt 不调用）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-busy-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const prompts: string[] = [];
			const factory = (async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({
						prompt: async () => {
							await gate;
							return { ok: true };
						},
					}),
					close: async () => {},
				},
			})) as never;
			const sm = new SessionManager([], "", undefined, factory, {
				onPrompt(id) {
					prompts.push(id);
				},
			}, undefined, { ...DEFAULT_RUNTIME_CONFIG, dataRoot: root });
			await sm.create("s1:t1", {});
			await sm.prompt("s1:t1", "第一条");
			await assert.rejects(() => sm.prompt("s1:t1", "第二条"), (err: Error) => err instanceof BusyError);
			assert.equal(prompts.length, 1);
			release(undefined);
			await new Promise((r) => setTimeout(r, 0));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
