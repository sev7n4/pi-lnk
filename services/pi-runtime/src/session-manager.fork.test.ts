import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import {
	ForkTargetUnknownError,
	NotFoundError,
	SessionManager,
} from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";

/**
 * ③ 重跑（后端线程截断）：fork 契约测试。
 *
 * 覆盖边界：
 *   - 缺 atEntryId        → 400（客户端参数错误）
 *   - 会话不存在          → 404
 *   - 切点 entry 不存在   → 400 ForkTargetUnknownError（**不静默兜底**，否则会
 *     变成「以为截断了其实整条重跑」，正是本特性要避免的失败形态）
 *
 * ⚠️ happy path（真实 fork 出截断分支、新 jsonl 带 parentSessionId 且无旧尾）依赖
 * 真实 AgentHarness 把 main lane 配置进会话；本文件 harnessFactory 是假的，会话里
 * 根本没有 main lane（fork 会报 "Unknown source branch"），故不在单元层覆盖 ——
 * 由 K3s 生产复现验收。
 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-fork-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let seq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `c${++seq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 假 harness：prompt 立即成功（本文件只测 fork 的参数/存在性校验）。 */
const okFactory = (async () => ({
	harness: {
		events: { on: () => () => {} },
		lane: async () => ({
			prompt: async () => ({ ok: true }),
			setThinkingLevel: async () => {},
		}),
		close: async () => {},
	},
})) as never;

function makeApp() {
	const manager = new SessionManager(
		[],
		"",
		undefined,
		okFactory,
		undefined,
		undefined,
		testConfig(),
	);
	const app = buildApp(manager, { metrics: new Metrics(), version: "test" });
	return { app, manager };
}

describe("③ 重跑：POST /sessions/:sessionId/fork", () => {
	it("缺少 atEntryId → 400", async () => {
		const { app } = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/sessions/s1/fork",
			payload: {},
		});
		assert.equal(res.statusCode, 400);
		assert.match(String(res.json().error), /atEntryId/);
	});

	it("会话不存在 → 404", async () => {
		const { app } = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/sessions/nope/fork",
			payload: { atEntryId: "entry-1" },
		});
		assert.equal(res.statusCode, 404);
	});

	it("切点 entry 不存在 → 400（不静默退化为整条重跑）", async () => {
		const { app } = makeApp();
		await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1" } });
		const res = await app.inject({
			method: "POST",
			url: "/sessions/s1/fork",
			payload: { atEntryId: "no-such-entry" },
		});
		assert.equal(res.statusCode, 400);
		assert.match(String(res.json().error), /fork target entry/);
	});

	it("manager.fork 的错误类型契约：未知 entry→ForkTargetUnknownError，未知会话→NotFoundError", async () => {
		const { manager } = makeApp();
		await manager.create("s1", {});
		await assert.rejects(
			() => manager.fork("s1", "bogus-entry"),
			(err: unknown) => err instanceof ForkTargetUnknownError,
		);
		await assert.rejects(
			() => manager.fork("missing-session", "x"),
			(err: unknown) => err instanceof NotFoundError,
		);
	});
});
