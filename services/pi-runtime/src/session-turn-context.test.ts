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

describe("轮次覆盖语义（复核 Important #1：spec §5.4「整体覆盖」）", () => {
	it("第 2 轮缺省的字段被清空，不残留上一轮附件/焦点/mentionedKeys", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm, captured } = makeManager(root);
			await sm.create("s1:t1", {
				attachments: [{ url: "https://x/a.png", mediaType: "image" }],
				mentionedKeys: ["I1"],
				focusNodeId: "n1",
			});
			const firstTurn = captured().toolContext() as Record<string, unknown>;
			assert.equal((firstTurn.attachments as unknown[] | undefined)?.length, 1);
			assert.deepEqual(firstTurn.mentionedKeys, ["I1"]);
			// 第 2 轮：用户没带任何素材——合并语义会把第 1 轮的附件泄漏进本轮 toolContext
			sm.setTurnContext("s1:t1", {});
			const secondTurn = captured().toolContext() as Record<string, unknown>;
			assert.deepEqual(secondTurn.attachments, []);
			assert.deepEqual(secondTurn.mentionedKeys, []);
			assert.deepEqual(secondTurn.refOrder, []);
			assert.equal(secondTurn.focusNodeId, undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prompt 直接接收 turnContext（busy 检查之后应用）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm, captured } = makeManager(root);
			await sm.create("s1:t1", {});
			await sm.prompt("s1:t1", "你好", "main", { turnContext: { dynamicBlocks: ["画布摘要：A"] } });
			assert.equal(captured().systemPrompt(), "STATIC\n\n画布摘要：A");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("busy 守卫（复核 Important #2/#5：TOCTOU 与被拒请求不污染在跑轮）", () => {
	/** lane() 返回挂起 promise 的工厂：暴露「检查 prompting 与置位之间隔着 await」的窗口。 */
	function makeGatedFactory(gate: Promise<unknown>) {
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
		return factory;
	}

	it("lane 解析挂起期间并发 prompt 必 409（置位先于 await，TOCTOU 消失）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-busy-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const sm = new SessionManager([], "", undefined, makeGatedFactory(gate), undefined, undefined, {
				...DEFAULT_RUNTIME_CONFIG,
				dataRoot: root,
			});
			await sm.create("s1:t1", {});
			// 关键：两个 prompt 同拍发起，都不 await——旧实现里第二个会在第一个置位前通过检查
			const first = sm.prompt("s1:t1", "第一条");
			await assert.rejects(() => sm.prompt("s1:t1", "第二条"), (err: Error) => err instanceof BusyError);
			release(undefined);
			await first;
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("被 409 拒绝的请求不污染在跑 run 的 turnContext", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-busy-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const { sm, captured } = (() => {
				let cap: { systemPrompt: (tc?: unknown) => string } = { systemPrompt: () => "" };
				const factory = (async (cfg: { systemPrompt: (tc?: unknown) => string }) => {
					cap = cfg;
					return {
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
					};
				}) as never;
				const mgr = new SessionManager([], "STATIC", undefined, factory, undefined, undefined, {
					...DEFAULT_RUNTIME_CONFIG,
					dataRoot: root,
				});
				return { sm: mgr, captured: () => cap };
			})();
			await sm.create("s1:t1", {});
			await sm.prompt("s1:t1", "第一条", "main", { turnContext: { dynamicBlocks: ["画布快照：第一轮"] } });
			await assert.rejects(
				() => sm.prompt("s1:t1", "第二条", "main", { turnContext: { dynamicBlocks: ["画布快照：第二轮"] } }),
				(err: Error) => err instanceof BusyError,
			);
			// 在跑 run 的下一次 LLM 调用仍读第一轮的快照，绝不能看到被拒请求的
			assert.equal(captured().systemPrompt(), "STATIC\n\n画布快照：第一轮");
			release(undefined);
			await new Promise((r) => setTimeout(r, 0));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lane 解析失败时 prompting 复位，下一轮可正常 prompt（不永久卡死）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-busy-"));
		try {
			const factory = (async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => {
						throw new Error("lane unavailable");
					},
					close: async () => {},
				},
			})) as never;
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, {
				...DEFAULT_RUNTIME_CONFIG,
				dataRoot: root,
			});
			await sm.create("s1:t1", {});
			await assert.rejects(() => sm.prompt("s1:t1", "第一条"), /lane unavailable/);
			// 复位后可再 prompt（此处 lane 仍会抛，但错误必须是 lane 的，而不是 BusyError）
			await assert.rejects(() => sm.prompt("s1:t1", "第二条"), (err: Error) => !(err instanceof BusyError));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("身份变更的 rebuilt 不抽走在跑 run 的 harness（改抛 BusyError）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-busy-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const sm = new SessionManager([], "", undefined, makeGatedFactory(gate), undefined, undefined, {
				...DEFAULT_RUNTIME_CONFIG,
				dataRoot: root,
			});
			await sm.create("s1:t1", { userId: "u1" });
			await sm.prompt("s1:t1", "第一条");
			await assert.rejects(
				() =>
					sm.create("s1:t1", {
						userId: "u1",
						llm: { model: "gpt-x", apiKey: "k", baseUrl: "https://example.invalid/v1", providerRef: "ch1", source: "user" },
					}),
				(err: Error) => err instanceof BusyError,
			);
			release(undefined);
			await new Promise((r) => setTimeout(r, 0));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("prompt 并发守卫（既有语义回归）", () => {
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
