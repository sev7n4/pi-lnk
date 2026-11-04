import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp, } from "./app.js";
import { SessionManager } from "./session-manager.js";
import { journalPath } from "./events-journal.js";
import { Metrics } from "./metrics.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";
import type { AssembledModel } from "./model-assembly.js";

/**
 * P2 Task 3 · events 端点磁盘尝试重载（`ensureLoaded`）。
 *
 * 验收（计划 Review Focus 5）：
 * 1. 重启窗（内存已逐出、磁盘在）：ensureLoaded → true，subscribe 重放完整（含终态帧）；
 * 2. 伪 id（磁盘无目录）：false，且**不创建目录**（404 语义不变、零副作用）；
 * 3. 身份不匹配（BYOK meta vs env 默认）：false，且**绝不触发 create 的删目录 rebuilt**
 *    （probe 订阅不得有删除副作用）。
 *
 * ⚠️ 纪律（app.test.ts:868-878 实测两次）：**禁止 inject `/events` 建流成功路径**
 * （连接活到测试结束 → ERR_HTTP_HEADERS_SENT 拖死整个文件）。HTTP 层只测立即返回分支。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-p2t3-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));
let cfgSeq = 0;

/** 可编程 modelFactory：默认身份 default-prov/m-default，override 按 providerRef/model 字面复位。 */
function fakeModelFactory(calls: { count: number }) {
	return ((override?: { providerRef?: string; model?: string }) => {
		calls.count++;
		const providerId = override?.providerRef ?? "default-prov";
		const modelId = override?.model ?? "m-default";
		return {
			models: {},
			model: { id: modelId, provider: providerId },
			providerId,
		} as unknown as AssembledModel;
	}) as never;
}

function makeManager(opts?: { modelFactory?: never }) {
	const fakeHarnessFactory = (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {},
		},
	})) as never;
	return new SessionManager(
		[],
		"",
		opts?.modelFactory ?? fakeModelFactory({ count: 0 }),
		fakeHarnessFactory,
		undefined,
		undefined,
		{
			...DEFAULT_RUNTIME_CONFIG,
			dataRoot: join(TEST_ROOT, `m${++cfgSeq}`),
			sessionTtlMs: 10 ** 9,
			sweepIntervalMs: 10 ** 9,
		},
	);
}

type EntryLike = {
	journal?: { append: (r: { seq: number; event: unknown }) => void; close: () => Promise<void> };
	buffer: Array<{ type: string; seq: number }>;
	nextSeq: number;
	identity: { provider: string; model: string };
};

function smInternals(sm: SessionManager) {
	return sm as unknown as {
		sessions: Map<string, EntryLike>;
		destroyMemoryOnly: (k: string) => Promise<void>;
		dispatch: (e: EntryLike, ev: Record<string, unknown>) => void;
		config: { dataRoot: string };
	};
}

describe("P2 ensureLoaded（events 端点磁盘尝试重载）", () => {
	it("重启窗：ensureLoaded → true，subscribe 重放完整（含终态帧）、游标连续", async () => {
		const sm = makeManager();
		const internals = smInternals(sm);
		const key = "probe-main";

		await sm.create(key, { userId: "u1" });
		const sk = internals.sessions.keys().next().value as string;
		const entry = internals.sessions.get(sk)!;
		internals.dispatch(entry, { type: "turn_start", payload: {} });
		internals.dispatch(entry, { type: "tool_execution_start", payload: {} });
		internals.dispatch(entry, { type: "turn_end", payload: {} });
		await entry.journal!.close();

		// 模拟重启
		await internals.destroyMemoryOnly(sk);
		assert.equal(sm.hasKey(key), false, "前置：内存已逐出");

		// lazy reload
		assert.equal(await sm.ensureLoaded(key), true, "磁盘有会话 ⇒ 重载成功");
		assert.equal(sm.hasKey(key), true);

		// subscribe 重放完整（对账 probe 的核心诉求：终态帧必须在）
		// ⚠️ 重放走返回值（seq > afterSeq），listener 只收未来事件。
		const got: Array<{ type: string; seq: number }> = [];
		const replay = sm.subscribe(key, (e) => got.push({ type: e.type, seq: e.seq }), -1);
		assert.deepEqual(
			replay.map((e) => `${e.seq}:${e.type}`),
			["0:turn_start", "1:tool_execution_start", "2:turn_end"],
			"afterSeq=-1 重放必须完整（含终态帧 turn_end）",
		);
		const incremental = sm.subscribe(key, () => {}, 1);
		assert.deepEqual(
			incremental.map((e) => `${e.seq}:${e.type}`),
			["2:turn_end"],
			"lastEventId=1 断点续传只补 2（对账 probe 的真实用法）",
		);
		assert.equal(got.length, 0, "重放不进 listener（未来事件才进）");

		// 游标连续：重载后新事件 seq 接续
		const entry2 = internals.sessions.get(sk)!;
		internals.dispatch(entry2, { type: "agent_start", payload: {} });
		const last = entry2.buffer[entry2.buffer.length - 1];
		assert.equal(last.seq, 3, "重载后首条新事件 seq 必须接续");
		await entry2.journal!.close();
	});

	it("伪 id（磁盘无目录）：false、不创建目录、无会话残留", async () => {
		const sm = makeManager();
		const internals = smInternals(sm);
		const dir = join(internals.config.dataRoot, "nope-does-not-exist");

		assert.equal(await sm.ensureLoaded("nope-does-not-exist"), false, "磁盘无会话 ⇒ false（404 语义不变）");
		assert.equal(existsSync(dir), false, "绝不创建目录（零副作用）");
		assert.equal(sm.hasKey("nope-does-not-exist"), false);
	});

	it("身份不匹配（BYOK meta vs env 默认）：false 且绝不删目录（无 rebuilt 副作用）", async () => {
		const sm = makeManager();
		const internals = smInternals(sm);
		const key = "byok-session";

		// 用字面 override 建会话：meta 记录 provider=byok-x/m-byok
		await sm.create(key, {
			userId: "u1",
			llm: { model: "m-byok", apiKey: "sk-test", baseUrl: "http://x", providerRef: "byok-x", source: "user" },
		} as never);
		const sk = internals.sessions.keys().next().value as string;
		const entry = internals.sessions.get(sk)!;
		assert.equal(entry.identity.provider, "byok-x");
		await entry.journal!.close();

		const dir = join(internals.config.dataRoot, sk);
		await internals.destroyMemoryOnly(sk);
		assert.ok(existsSync(dir), "前置：磁盘目录在");

		// ensureLoaded：默认身份 default-prov ≠ byok-x ⇒ 必须放弃，且不删目录
		assert.equal(await sm.ensureLoaded(key), false, "身份不匹配 ⇒ false（fail-soft 404）");
		assert.ok(existsSync(dir), "⛔ 绝不触发删目录 rebuilt（probe 订阅零删除副作用）");
		assert.ok(existsSync(journalPath(dir)), "journal 同样保留");
		assert.equal(sm.hasKey(key), false);
	});
});

describe("P2 ensureLoaded（HTTP 层立即返回分支）", () => {
	it("GET /sessions/:id/events 未知键仍 404（走 ensureLoaded 后语义不变）", async () => {
		const root = join(TEST_ROOT, `http${++cfgSeq}`);
		const manager = makeManager();
		const app = buildApp(manager, { metrics: new Metrics(), version: "test" });
		try {
			const res = await app.inject({ method: "GET", url: "/sessions/ghost/events?lastEventId=0" });
			assert.equal(res.statusCode, 404);
			assert.deepEqual((res.json() as { error: string }).error, "session not found");
		} finally {
			await app.close();
		}
	});
});
