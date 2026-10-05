import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";

/**
 * `canvasSessionId` 的落盘回归（生产取证 2026-10-05）。
 *
 * ## 生产事实
 *
 * pod 内 `/data/sessions` 下 200 个会话的 `meta.json` **全无** `canvasSessionId`
 * （抽样目录名已含画布 id 的那些也一样没有）⇒ 字段**从来没被写进磁盘**。
 *
 * ## 为什么这个字段丢了就全盘 404
 *
 * `toolContext.sessionId = entry.canvasSessionId ?? key`。
 * 字段缺失 ⇒ 回落到 `key`，而 `entry.id` 的真实形态是
 * `cmuptk4wz001bkz01gca02mv8_muptk4zj-gewga212k-aecc1e57`（`<画布id>_<pi键>-<hash>-<random>`）
 * ⇒ **整个复合串被当 sessionId 传给 Nest** ⇒ `prisma.session.findUnique({id})` 查不到
 * ⇒ `{"message":"会话不存在"}` 404 ⇒ 全部画布工具失败
 * （实测 `get_canvas_layout` 15/19、`get_canvas_summary` 15/17 失败）。
 *
 * 与 `types.ts` 里记载的 #70 hotfix 属**同一类**问题复发。
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

type CreateOpts = Parameters<SessionManager["create"]>[1];

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

function newManager(cfg: RuntimeConfig) {
	return new SessionManager([], "", undefined, makeHarnessFactory(), undefined, undefined, cfg, undefined, undefined);
}

/** 递归找出某会话目录下的 meta.json。 */
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
			let isDir = false;
			let isFile = false;
			try {
				const st = statSync(p);
				isDir = st.isDirectory();
				isFile = st.isFile();
			} catch {
				continue;
			}
			if (isFile && n === "meta.json" && p.includes(needle)) return p;
			if (isDir) stack.push(p);
		}
	}
	return null;
}

test("🔴 写盘侧：canvasSessionId 必须进 meta.json（缺它 ⇒ 画布工具全 404）", async () => {
	const cfg = testConfig();
	// 用真实的复合键形态（含画布 id 前缀），别用纯 UUID —— 否则测不到线上那个场景
	const CANVAS = "cmuptk4wz001bkz01gca02mv8";
	const KEY = `${CANVAS}_muptk4zj-gewga212k-aecc1e57`;

	const m1 = newManager(cfg);
	await m1.create(KEY, { userId: "u1", canvasSessionId: CANVAS } as CreateOpts);
	m1.stopSweeper();

	const metaPath = findMetaPath(cfg.dataRoot, CANVAS);
	assert.ok(metaPath, `应能找到 meta.json（目录名含 ${CANVAS}）`);
	const raw = readFileSync(metaPath, "utf8");
	assert.ok(
		raw.includes(CANVAS),
		`meta.json 缺 canvasSessionId ⇒ 恢复后回落成复合键 ⇒ 画布工具 404。实际内容：${raw.slice(0, 200)}`,
	);
});

test("存量会话（meta 无该字段）必须仍能 resume，且不报错", async () => {
	const cfg = testConfig();
	const KEY = "legacy-key-1";

	const m1 = newManager(cfg);
	await m1.create(KEY, { userId: "u1" } as CreateOpts);
	m1.stopSweeper();

	// 改成历史形态：没有 canvasSessionId
	const metaPath = findMetaPath(cfg.dataRoot, "legacy-key-1");
	assert.ok(metaPath, "应找到 meta.json");
	writeFileSync(
		metaPath,
		JSON.stringify({ userId: "u1", provider: "agnes", model: "agnes-2.5-flash" }),
		"utf8",
	);

	// 关键：不得抛异常 —— 存量会话必须仍能 resume
	const m2 = newManager(cfg);
	const r = await m2.create(KEY, { userId: "u1" } as CreateOpts);
	// CreateResult 的真实形状是 { provider, model, status, resumedFrom? }，
	// **没有 created 字段**（status ∈ "created" | "resumed" | "rebuilt"）
	assert.notEqual(r.status, "error", "缺字段的存量会话仍应能 resume");
	m2.stopSweeper();
});

test("读盘侧补全：写进 meta 的 canvasSessionId 会被 readSessionMeta 读出（无行为影响，仅一致性）", async () => {
	const cfg = testConfig();
	const CANVAS = "cmuptk4wz001bkz01gca02mv8";

	const m1 = newManager(cfg);
	await m1.create(CANVAS, { userId: "u1", canvasSessionId: CANVAS } as CreateOpts);
	m1.stopSweeper();

	const metaPath = findMetaPath(cfg.dataRoot, CANVAS);
	assert.ok(metaPath, "应找到 meta.json");
	const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
	assert.equal(parsed.canvasSessionId, CANVAS, "写盘侧应含该字段");

	// ⚠️ **本用例刻意不断言 readSessionMeta 的读出值**，因为断言不了（变异验证实测得出）。
	//
	// 撤掉 `readSessionMeta` 里的这个字段后，测试仍然全绿 —— 复查代码确认原因是：
	// `readSessionMeta` 返回的 meta **只用于 userId / identity 校验**，
	// 而 `entry.canvasSessionId` 来自 `build()` 读的 **opts**，**不取自 meta**。
	// ⇒ 读侧补不补这个字段，对 `getCanvasSessionId` / `toolContext.sessionId` **均无行为影响**。
	//
	// 那为何仍要补？「写进去却读不出来」语义上残缺：`meta.json` 是归属与身份在磁盘上的
	// 唯一 record，将来若有人拿它做画布 id 兜底，漏字段会成为隐藏坑。
	// ⇒ 明确标注为**防御性补全**，不冒充 bug 修复。
	// 真正的 bug 修复是**写盘侧**，那条已被上面的用例钉住（变异验证 1/1 杀）。
});
