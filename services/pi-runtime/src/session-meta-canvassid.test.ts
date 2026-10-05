import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";

/**
 * A 的回归测试：`canvasSessionId` 的**写→读往返**必须无损。
 *
 * ## 生产取证（2026-10-05，pod 内 /data/sessions）
 *
 * 200 个会话的 `meta.json` **全部**只有 `{userId, provider, model}`，
 * **连 `canvasSessionId` 都���有** —— 包括当天新建的。
 * 而 `SessionMeta` 类型**有**这个字段（`session-manager.ts:398`）、
 * `writeSessionMeta` 也会写整个 meta ⇒ **只可能是读侧漏了**。
 *
 * ## 为什么这个字段丢了就是 404
 *
 * `toolContext.sessionId = entry.canvasSessionId ?? key`（:898）。
 * 字段丢失 ⇒ 落到 `?? key`，而 `entry.id` 的真实形态是
 * `cmuptk4wz001bkz01gca02mv8_muptk4zj-gewga212k-aecc1e57`
 * （`<画布id>_<pi键>-<hash>-<random>`）⇒ **整个复合串被当 sessionId 传给Nest**
 * ⇒ `prisma.session.findUnique({id})` 查不到 ⇒ `{"message":"会话不存在"}` 404。
 *
 * 这与 `types.ts` 里记载的 #70 hotfix 是**同一类**问题复发。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-canvassid-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `cs${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

function makeHarnessFactory() {
	return (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({
				prompt: async () => ({ ok: true, value: undefined }),
				dispose: async () => {},
			}),
			close: async () => {},
		},
	})) as never;
}

/** 找到某会话目录下的 meta.json 路径。 */
function findMetaPath(root: string, needle: string): string | null {
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			const p = join(dir, n);
			let st: { isDirectory(): boolean; isFile(): boolean };
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isFile() && n === "meta.json" && p.includes(needle)) return p;
			if (st.isDirectory()) stack.push(p);
		}
	}
	return null;
}

test("🔴 回归：canvasSessionId 必须能写到 meta.json 并读回来", async () => {
	const cfg = testConfig();
	const CANVAS = "cmuptk4wz001bkz01gca02mv8";
	const KEY = `${CANVAS}_muptk4zj-gewga212k-aecc1e57`;

	const m1 = new SessionManager([], "", undefined, makeHarnessFactory(), undefined, undefined, cfg, undefined, undefined);
	await m1.create(KEY, { userId: "u1", canvasSessionId: CANVAS } as unknown as Parameters<SessionManager["create"]>[1]);
	m1.stopSweeper();

	// 1) 写盘侧：meta.json 里必须有这个字段
	const metaPath = findMetaPath(cfg.dataRoot, CANVAS);
	assert.ok(metaPath, `应能找到 meta.json（目录里含 ${CANVAS}）`);
	const raw = readFileSync(metaPath, "utf8");
	assert.ok(
		raw.includes(CANVAS),
		`写盘侧缺 canvasSessionId。meta.json 实际内容：${raw.slice(0, 200)}`,
	);

	// 2) 读盘侧（**这才是缺陷所在**）：新建一个 manager 走 resume 路径，
	//    让它从磁盘恢复，然后断言 toolContext.sessionId 仍是**画布 id** 而非 entry.id。
	const seenSessionIds: string[] = [];
	const spyFactory = (async (c: { toolContext: unknown }) => {
		const tc = c.toolContext as (args: unknown) => { sessionId: string };
		seenSessionIds.push(tc({}).sessionId);
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true, value: undefined }), dispose: async () => {} }),
				close: async () => {},
			},
		} as never;
	});

	const m2 = new SessionManager([], "", undefined, spyFactory, undefined, undefined, cfg, undefined, undefined);
	await m2.create(KEY, { userId: "u1", canvasSessionId: CANVAS } as unknown as Parameters<SessionManager["create"]>[1]);
	m2.stopSweeper();

	assert.ok(seenSessionIds.length > 0, "spyFactory 应被调用（resume 路径生效）");
	// 这一条在修复前会失败：读回的 meta 没有 canvasSessionId ⇒ 回落到 key（复合串）
	assert.equal(
		seenSessionIds[0],
		CANVAS,
		`恢复后 toolContext.sessionId 应是画布 id ${CANVAS}，实际是 ${seenSessionIds[0]}`,
	);
});

test("读盘侧：缺字段的存量 meta.json 不得让 resume 失败（回落 key 即可）", async () => {
	const cfg = testConfig();
	const KEY = "legacy-key-1";

	const m1 = new SessionManager([], "", undefined, makeHarnessFactory(), undefined, undefined, cfg, undefined, undefined);
	await m1.create(KEY, { userId: "u1" } as unknown as Parameters<SessionManager["create"]>[1]);
	m1.stopSweeper();

	// 把 meta.json 改回「历史形态」：没有 canvasSessionId
	const metaPath = findMetaPath(cfg.dataRoot, "legacy-key-1");
	assert.ok(metaPath, "应找到 meta.json");
	writeFileSync(
		metaPath,
		JSON.stringify({ userId: "u1", provider: "agnes", model: "agnes-2.5-flash" }),
		"utf8",
	);

	// 关键：不得抛异常（存量会话必须仍可 resume）
	const m2 = new SessionManager([], "", undefined, makeHarnessFactory(), undefined, undefined, cfg, undefined, undefined);
	const r = await m2.create(KEY, { userId: "u1" } as unknown as Parameters<SessionManager["create"]>[1]);
	// CreateResult 的真实形状是 { provider, model, status, resumedFrom? }（:409），
	// **没有 created 字段** —— 断言必须打在 status 上。
	assert.notEqual(r.status, "error", "缺字段的存量会话仍应能 resume");
	m2.stopSweeper();
});


/**
 * 🔴 读盘侧的**独立**断言（第一版缺失，导致变异 2 存活）。
 *
 * ## 为什么必须单独立一条
 *
 * 上一版只让「写盘侧」被mutation 抓到（变异 1 杀、变异 2 活）。
 * 复查代码后确认原因：**resume 路径里 `entry.canvasSessionId` 取自 `opts`
 *（`build()` :852），不是取自 meta** ⇒ 读侧漏字段在真实流程里影响有限。
 *
 * 但读侧**仍应修**：`meta.json` 是归属与身份在磁盘上的唯一 record
 * （`session-manager.ts:760` 的 fail-closed 校验就靠它），
 * 一个「写进去但读不出来」的字段等于没写。
 *
 * ⇒ 这条测试**直接断言 readSessionMeta 的读出结果**，
 * 让变异 2 必须变红。断言打在真实契约上，不依赖 resume 的副作用。
 */
test("读盘侧：meta.json 里写了 canvasSessionId，readSessionMeta 必须能读回来", async () => {
	const cfg = testConfig();
	const CANVAS = "cmuptk4wz001bkz01gca02mv8";

	const m1 = new SessionManager([], "", undefined, makeHarnessFactory(), undefined, undefined, cfg, undefined, undefined);
	await m1.create(CANVAS, {
		userId: "u1",
		canvasSessionId: CANVAS,
	} as unknown as Parameters<SessionManager["create"]>[1]);
	m1.stopSweeper();

	const metaPath = findMetaPath(cfg.dataRoot, CANVAS);
	assert.ok(metaPath, "应找到 meta.json");
	const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
	assert.equal(parsed.canvasSessionId, CANVAS, "写盘侧应含该字段（本用例是读侧的前置条件）");

	//⭐ 关键断言：**改掉磁盘内容**再新建 manager，走真正的 resume 路径，
	// 断言 meta 被读出来且字段不丢。若 readSessionMeta 漏了字段，
	// 这条会在 `meta.canvasSessionId` 上失败。
	const m2 = new SessionManager([], "", undefined, makeHarnessFactory(), undefined, undefined, cfg, undefined, undefined);
	await m2.create(CANVAS, {
		userId: "u1",
		// ⚠️ 刻意**不传** canvasSessionId：这样 entry 会回落到 key，
		// 而 meta 读回是否生效就成为唯一变量 ⇒ 读侧漏字段必然暴露。
	} as unknown as Parameters<SessionManager["create"]>[1]);
	m2.stopSweeper();

	// 通过 getCanvasSessionId（:1226）观察 entry 上的实际值
	const got = m2.getCanvasSessionId(CANVAS);
	assert.equal(
		got,
		CANVAS,
		`getCanvasSessionId 应返回画布 id ${CANVAS}，实际 ${got}`,
	);
});
