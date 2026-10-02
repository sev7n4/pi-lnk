import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { SessionManager, toSessionKey, QUEUE_GUIDANCE } from "./session-manager.js";
import type { SessionLlmOverride } from "./model-assembly.js";
import type { RuntimeConfig } from "./runtime-config.js";

/** 长 TTL / 大上限：本文件只测 resume 三分支，回收策略归 session-retention 与 Task 6。 */
function baseConfig(root: string): RuntimeConfig {
	return {
		dataRoot: root,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 记录每次 harness 创建的会话来源（新建 or 恢复），并支持断言 close 调用。 */
function makeHarnessFactory() {
	const seen: Array<{ hadEntries: boolean; toolContextIsFunction: boolean; systemPromptIsFunction: boolean }> = [];
	const closed: number[] = [];
	let n = 0;
	const factory = (async (cfg: {
		session: { findEntries: (q?: unknown, c?: unknown) => Promise<unknown[]> };
		toolContext: unknown;
		systemPrompt: unknown;
	}) => {
		n += 1;
		const entries = await cfg.session.findEntries(undefined, BACKGROUND_CONTEXT).catch(() => []);
		seen.push({
			hadEntries: Array.isArray(entries) && entries.length > 0,
			toolContextIsFunction: typeof cfg.toolContext === "function",
			systemPromptIsFunction: typeof cfg.systemPrompt === "function",
		});
		const id = n;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {
					closed.push(id);
				},
			},
		};
	}) as never;
	return { factory, seen, closed };
}

function withTempDataRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-resume-"));
	return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("SessionManager.create 幂等 resume-or-create", () => {
	it("同键两次 create：harnessFactory 只调用一次，第二次 status=resumed", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, seen } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			const first = await sm.create("s1:t1", { userId: "u1", systemPrompt: "RULES" });
			const second = await sm.create("s1:t1", { userId: "u1", systemPrompt: "RULES" });
			assert.equal(first.status, "created");
			assert.equal(second.status, "resumed");
			assert.equal(seen.length, 1);
			assert.equal(seen[0].toolContextIsFunction, true);
			assert.equal(seen[0].systemPromptIsFunction, true);
		});
	});

	it("不同 userId 同键：抛 ConflictError 且不返回任何会话内容", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1" });
			await assert.rejects(() => sm.create("s1:t1", { userId: "u2" }), /session exists/);
		});
	});

	it("归属用户的会话不接受匿名复用（fail-closed）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1" });
			await assert.rejects(() => sm.create("s1:t1", {}), /session exists/);
		});
	});

	it("身份变更（平台 → BYOK）触发 rebuilt：旧会话被 close，新会话重新建", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, seen, closed } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1" });
			const byok: SessionLlmOverride = {
				model: "gpt-x",
				apiKey: "k",
				baseUrl: "https://example.invalid/v1",
				providerRef: "ch1",
				source: "user",
			};
			const out = await sm.create("s1:t1", { userId: "u1", llm: byok });
			assert.equal(out.status, "rebuilt");
			assert.equal(seen.length, 2);
			assert.deepEqual(closed, [1]);
			assert.ok(out.provider.startsWith("byok-"));
		});
	});

	it("内存无但磁盘有：repo.open 恢复，harness 看到既有条目，status=resumed", async () => {
		await withTempDataRoot(async (root) => {
			// 先用真实 repo 落一份磁盘会话，模拟上一个 Pod 的生命周期。
			// 目录名必须是 toSessionKey 的真实输出（键 sanitize 后带哈希后缀）。
			const key = toSessionKey("s1:t1");
			const cwd = join(root, key);
			const env = new NodeExecutionEnv({ cwd });
			const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
			const session = await repo.create({ cwd }, BACKGROUND_CONTEXT);
			const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
			await branch.appendMessage({ role: "user", content: "上一轮说过的话" } as never, BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
			// 复核 Important #4：归属/身份的磁盘记录（真实 create 流程也会写它）。
			// model 必须与 env 路径的默认身份一致（AGNES_MODEL_ID ?? "agnes-2.5-pro"），
			// 否则身份校验判 rebuilt 正是 fail-closed 的预期行为。
			await writeFile(
				join(cwd, "meta.json"),
				JSON.stringify({ userId: "u1", provider: "agnes", model: process.env.AGNES_MODEL_ID ?? "agnes-2.5-pro" }),
				"utf8",
			);

			const { factory, seen } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			const out = await sm.create("s1:t1", { userId: "u1" });
			assert.equal(out.status, "resumed");
			assert.equal(out.resumedFrom, "disk");
			assert.equal(seen.length, 1);
			assert.equal(seen[0].hadEntries, true);
		});
	});

	it("create 落盘 meta.json（归属 + 身份，磁盘 resume 的 fail-closed 数据源）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1" });
			const raw = await readFile(join(root, toSessionKey("s1:t1"), "meta.json"), "utf8");
			const meta = JSON.parse(raw) as { userId: string | null; provider: string; model: string };
			assert.equal(meta.userId, "u1");
			assert.equal(meta.provider, "agnes");
			assert.equal(typeof meta.model, "string");
		});
	});

	it("TTL 回收内存后同身份同用户：磁盘 resume 成功（resumedFrom=disk）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, seen } = makeHarnessFactory();
			const cfg = baseConfig(root);
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s1:t1", { userId: "u1", systemPrompt: "RULES" });
			await sm.sweepOnce(Date.now() + cfg.sessionTtlMs + 1); // 只回收内存，磁盘保留
			const out = await sm.create("s1:t1", { userId: "u1", systemPrompt: "RULES" });
			assert.equal(out.status, "resumed");
			assert.equal(out.resumedFrom, "disk");
			assert.equal(seen.length, 2);
		});
	});

	it("TTL 回收后另一用户持同键：磁盘路径同样 fail-closed（ConflictError）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory();
			const cfg = baseConfig(root);
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s1:t1", { userId: "u1" });
			await sm.sweepOnce(Date.now() + cfg.sessionTtlMs + 1);
			// threadKey 来自客户端可伪造：磁盘 meta 是唯一归属凭证，缺这层校验等于跨用户读上下文
			await assert.rejects(() => sm.create("s1:t1", { userId: "u2" }), /session exists/);
		});
	});

	it("TTL 回收后身份变更（同渠道换模型）：磁盘路径走 rebuilt，旧目录被替换", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, seen, closed } = makeHarnessFactory();
			const cfg = baseConfig(root);
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, cfg);
			await sm.create("s1:t1", { userId: "u1" });
			await sm.sweepOnce(Date.now() + cfg.sessionTtlMs + 1);
			const byok: SessionLlmOverride = {
				model: "gpt-x",
				apiKey: "k",
				baseUrl: "https://example.invalid/v1",
				providerRef: "ch1",
				source: "user",
			};
			const out = await sm.create("s1:t1", { userId: "u1", llm: byok });
			assert.equal(out.status, "rebuilt");
			assert.equal(out.provider.startsWith("byok-"), true);
			assert.deepEqual(closed, [1]); // TTL sweep 回收内存即释放旧 harness（destroyMemoryOnly 会 close）
			assert.equal(seen.length, 2);
			assert.equal(seen[1].hadEntries, false); // 旧历史不带入新身份
			// meta 被改写为新身份
			const meta = JSON.parse(
				await readFile(join(root, toSessionKey("s1:t1"), "meta.json"), "utf8"),
			) as { provider: string };
			assert.equal(meta.provider.startsWith("byok-"), true);
		});
	});

	it("遗留目录无 meta.json（部署前旧数据）：不恢复历史，按新建处理", async () => {
		await withTempDataRoot(async (root) => {
			const key = toSessionKey("s1:t1");
			const cwd = join(root, key);
			const env = new NodeExecutionEnv({ cwd });
			const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
			const session = await repo.create({ cwd }, BACKGROUND_CONTEXT);
			const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
			await branch.appendMessage({ role: "user", content: "旧构建的历史" } as never, BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
			// 刻意不写 meta.json

			const { factory, seen } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			const out = await sm.create("s1:t1", { userId: "u1" });
			assert.equal(out.status, "created");
			assert.equal(seen[0].hadEntries, false);
		});
	});

	it("并发 create 同键：共享同一次 build（harnessFactory 只跑一次），无句柄泄漏", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, seen } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			const [a, b] = await Promise.all([
				sm.create("s1:t1", { userId: "u1" }),
				sm.create("s1:t1", { userId: "u1" }),
			]);
			assert.equal(seen.length, 1); // 旧实现：两次都 miss → 各自 build → 后者覆盖前者（句柄泄漏）
			assert.equal(a.status, "created");
			assert.equal(b.status, "created");
		});
	});

	it("resume 不重设静态段：第二次传入的 systemPrompt 被忽略", async () => {
		await withTempDataRoot(async (root) => {
			let captured: { systemPrompt: (tc: unknown, ctx?: unknown) => string } | undefined;
			const factory = (async (cfg: unknown) => {
				captured = cfg as typeof captured;
				return {
					harness: {
						events: { on: () => () => {} },
						lane: async () => ({ prompt: async () => ({ ok: true }) }),
						close: async () => {},
					},
				};
			}) as never;
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1", systemPrompt: "RULES" });
			await sm.create("s1:t1", { userId: "u1", systemPrompt: "TAMPERED" });
			// resume 沿用磁盘里的静态段：guidance 是每次拼接的固定尾部，不随 base 变化
			assert.equal(captured?.systemPrompt(undefined), `RULES\n\n${QUEUE_GUIDANCE}`);
		});
	});

	it("activeKeys / hasKey 以会话键为单位（供 TTL 与 LRU 豁免消费）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1" });
			assert.equal(sm.hasKey("s1:t1"), true);
			assert.equal(sm.hasKey("s2:t2"), false);
			assert.deepEqual([...sm.activeKeys()], [toSessionKey("s1:t1")]);
		});
	});
});

describe("会话复用路径的 thinkingLevel 换档（spec §5.5）", () => {
	/** 假 harness：记录 setThinkingLevel 调用（常驻会话下换档不能再靠重建会话）。 */
	function makeLevelHarness(setLevels: string[], fail = false) {
		return (async () => ({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({
					prompt: async () => ({ ok: true }),
					setThinkingLevel: async (level: string) => {
						if (fail) throw new Error("lane setter unavailable");
						setLevels.push(level);
					},
				}),
				close: async () => {},
			},
		})) as never;
	}

	it("身份一致但档位变更：不重建会话，走 lane setter 换档", async () => {
		await withTempDataRoot(async (root) => {
			const setLevels: string[] = [];
			const sm = new SessionManager([], "", undefined, makeLevelHarness(setLevels), undefined, undefined, baseConfig(root));
			const first = await sm.create("s1:t1", { userId: "u1", thinkingLevel: "off" });
			assert.equal(first.status, "created");
			assert.deepEqual(setLevels, []);
			const second = await sm.create("s1:t1", { userId: "u1", thinkingLevel: "high" });
			assert.equal(second.status, "resumed");
			assert.deepEqual(setLevels, ["high"]);
		});
	});

	it("档位未变时不重复调用 setThinkingLevel", async () => {
		await withTempDataRoot(async (root) => {
			const setLevels: string[] = [];
			const sm = new SessionManager([], "", undefined, makeLevelHarness(setLevels), undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1", thinkingLevel: "high" });
			await sm.create("s1:t1", { userId: "u1", thinkingLevel: "high" });
			assert.deepEqual(setLevels, []);
		});
	});

	it("setter 失败降级：返回 resumed 而非报错（本轮沿用旧档位）", async () => {
		await withTempDataRoot(async (root) => {
			const sm = new SessionManager([], "", undefined, makeLevelHarness([], true), undefined, undefined, baseConfig(root));
			await sm.create("s1:t1", { userId: "u1", thinkingLevel: "off" });
			const second = await sm.create("s1:t1", { userId: "u1", thinkingLevel: "high" });
			assert.equal(second.status, "resumed");
		});
	});
});
