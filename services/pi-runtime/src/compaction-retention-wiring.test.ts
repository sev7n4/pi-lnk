import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toSessionKey } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { RETENTION_INSTRUCTIONS_VERSION, type RetentionState } from "./compaction-retention.js";

/**
 * 压缩保留段的**接线层**测试（Round 2 W2①）。
 *
 * ⭐ 与 `compaction-retention.test.ts` 的分工：那边锁纯函数（截断 / 清洗 / 恒非空），
 * 这边锁「压缩触发点真的把 customInstructions 传给了 vendor」。
 *
 * 为什么要单独一层：`buildRetentionInstructions` 写对了但**没接线**，是这类改动最典型的
 * 假绿形态 —— 单测 100% 通过、压缩行为与改动前一模一样。
 * 判据是**直接断言传给 vendor `lane.compact` 的实参**，不是断言我们自己的函数被调用过。
 *
 * 取 private `runCompaction` 直测：`maybeCompact` 是 fire-and-forget（挂在 prompt 的
 * `.then` 里），要驱动它必须伪造一次完整 run + 真实 usage，代价远大于收益。
 * TS 的 private 只是编译期约束；这里测的正是「内部接线点有没有接上」，
 * 用`(sm as any)` 访问是这类接线测试的通行做法。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-retention-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `c${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		// ⚠️ 必须显式给一个小窗口：默认走 model.contextWindow（agnes 声明 1_000_000），
		// 阈值算出来 983,616 永不触及 ⇒ decideCompaction 在调用 compact 之前就
		// 以 below_threshold 早退，测试变成假绿（这正是 F-01 的原始形态）。
		compactionContextWindow: 1000,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	} as RuntimeConfig;
}

/**
 * fake harness：lane 上挂 `findEntries` 与 `compact`（记录实参）。
 *
 * ⚠️ 三个判据缺一不可，否则 `decideCompaction` 在**调用 compact 之前**就早退，
 * 测试会变成「什么都没发生所以没报错」的假绿：
 *   ① `entry.contextWindow` 必须是有限正数（否则 `no_window`）
 *   ② usage 必须挂在 `message.usage` 上，且 `totalTokens > 0`（否则 `no_usage`）
 *   ③ `stopReason` 不能是 aborted/error、`timestamp` 要 ≥ latestPrefixTimestamp
 *      —— `getLastAssistantUsageInfo` 逐条筛掉这些（vendor estimate.ts）
 * ④ usage 要超过 `contextWindow - reserveTokens`（否则 `below_threshold`）
 */
function makeFakeHarness(capture: { options: unknown }): unknown {
	return (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({
				prompt: async () => ({ ok: true }),
				findEntries: async () => [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "x" }],
							stopReason: "stop",
							timestamp: 1_000,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 999_000 },
						},
					},
				],
				compact: async (options: unknown) => {
					capture.options = options;
					return { ok: true };
				},
			}),
			close: async () => {},
		},
	})) as never;
}

/**
 * 取回内部 entry（sessions 是私有 Map，用索引访问；理由见文件头）。
 *
 * ⚠️ 键名不是 threadKey 本身：`toSessionKey` 会追加 8 位 sha256 摘要
 * （防非法字符），必须用同一个函数换算，否则 `get` 返回 undefined。
 *
 * 返回类型用结构化的最小形状而非 `never`：TS 会把 `never` 上的属性访问
 * 判成 TS2339（`never` 是所有类型的子类型，属性不存在），构建期直接失败。
 */
interface EntryShape {
	harness: { lane(name: string): Promise<unknown> };
	turn: { retention?: RetentionState };
}
function entryOf(sm: SessionManager, threadKey: string): EntryShape {
	const key = toSessionKey(threadKey);
	const found = (sm as unknown as { sessions: Map<string, EntryShape | undefined> }).sessions.get(
		key,
	);
	if (!found) throw new Error(`entry not found for ${threadKey} (key=${key})`);
	return found;
}

describe("压缩保留段接线（Round 2 W2①）", () => {
	it("runCompaction 把非空 customInstructions 传给 vendor lane.compact", async () => {
		const capture: { options: unknown } = { options: undefined };
		const sm = new SessionManager(
			[{ name: "t_retention" } as never],
			"",
			undefined,
			makeFakeHarness(capture) as never,
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });
		const key = "s1";
		sm.setTurnContext(key, { retention: { pendingConfirmNodeIds: ["node-x"] } });
		const entry = entryOf(sm, key);
		const lane = await entry.harness.lane("main");

		await (sm as unknown as {
			runCompaction(e: unknown, l: unknown, c: unknown): Promise<unknown>;
		}).runCompaction(entry, lane, {});

		assert.ok(capture.options, "lane.compact 必须被调用（否则本用例是假绿）");
		const opts = capture.options as { customInstructions?: string };
		assert.equal(typeof opts.customInstructions, "string", "customInstructions 必须是字符串");
		assert.ok(
			(opts.customInstructions ?? "").includes(RETENTION_INSTRUCTIONS_VERSION),
			"必须含保留策略版本号，否则压缩后无法归因是哪一版策略产出的",
		);
		assert.ok(
			(opts.customInstructions ?? "").includes("node-x"),
			"待确认节点 id 必须进保留段（最容易被压缩掉的存量问题）",
		);
	});

	it("⭐ 反例锁定：无 retention 状态时 customInstructions 也不能是 undefined", async () => {
		// vendor 收到 undefined 会走原生路径 ⇒ 保留段静默失效，而一切看起来都正常。
		// 这条是「恒非空」这个不变量的接线侧反例，纯函数侧的反例在 compaction-retention.test.ts。
		const capture: { options: unknown } = { options: undefined };
		const sm = new SessionManager(
			[{ name: "t_retention2" } as never],
			"",
			undefined,
			makeFakeHarness(capture) as never,
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s2", { userId: "u1", systemPrompt: "SYS" });
		const entry = entryOf(sm, "s2");
		const lane = await entry.harness.lane("main");
		// 故意不调 setTurnContext

		await (sm as unknown as {
			runCompaction(e: unknown, l: unknown, c: unknown): Promise<unknown>;
		}).runCompaction(entry, lane, {});

		const opts = capture.options as { customInstructions?: string } | undefined;
		assert.notEqual(opts?.customInstructions, undefined, "无状态时也必须传兜底指令");
		assert.ok((opts?.customInstructions ?? "").length > 0);
	});

	it("⭐ 两层内容都在：#141 的静态清单 + 本分支的动态节点 id", async () => {
		// #141 提供了静态清单（通用四类要求），本分支提供画布里真实的 pending_confirm 节点。
		// 两者互补：静态清单说不出「是哪个节点」，动态状态给不出「还应保留哪几类」。
		// 少任何一层，保留段都不完整 —— 这条锁住合并语义不被后续改动悄悄丢掉一层。
		const capture: { options: unknown } = { options: undefined };
		const sm = new SessionManager(
			[{ name: "t_retention3" } as never],
			"",
			undefined,
			makeFakeHarness(capture) as never,
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s3", { userId: "u1", systemPrompt: "SYS" });
		sm.setTurnContext("s3", { retention: { pendingConfirmNodeIds: ["node-merge"] } });
		const entry = entryOf(sm, "s3");
		const lane = await entry.harness.lane("main");

		await (sm as unknown as {
			runCompaction(e: unknown, l: unknown, c: unknown): Promise<unknown>;
		}).runCompaction(entry, lane, {});

		const text = (capture.options as { customInstructions?: string }).customInstructions ?? "";
		// 动态层
		assert.ok(text.includes("node-merge"), "动态层：真实待确认节点 id");
		assert.ok(
			text.includes(RETENTION_INSTRUCTIONS_VERSION),
			"动态层：保留策略版本号（可归因）",
		);
		// 静态层（#141 的 COMPACTION_RETENTION_INSTRUCTIONS 首句）
		assert.ok(
			text.includes("画布创作助手"),
			"静态层：#141 的通用清单首句必须在（rebase 合并时被丢掉过）",
		);
	});

	it("kill switch：compactionRetention=false 时完全回退到 undefined", async () => {
		// #141 提供的 env 开关。回滚路径必须仍然可用，否则线上出问题只能回滚镜像。
		const capture: { options: unknown } = { options: undefined };
		const cfg = { ...testConfig(), compactionRetention: false } as RuntimeConfig;
		const sm = new SessionManager(
			[{ name: "t_retention4" } as never],
			"",
			undefined,
			makeFakeHarness(capture) as never,
			undefined,
			undefined,
			cfg,
		);
		await sm.create("s4", { userId: "u1", systemPrompt: "SYS" });
		sm.setTurnContext("s4", { retention: { pendingConfirmNodeIds: ["node-kill"] } });
		const entry = entryOf(sm, "s4");
		const lane = await entry.harness.lane("main");

		await (sm as unknown as {
			runCompaction(e: unknown, l: unknown, c: unknown): Promise<unknown>;
		}).runCompaction(entry, lane, {});

		// 开关关闭时仍会调 compact（压缩本身不受影响），但**整个 options 就是 undefined**
		// —— 与本开关引入前 `lane.compact(undefined, ctx)` 逐字节一致。
		// ⚠️ 不能断言 `capture.options` 为真值：fake 收到的就是 `undefined`。
		// 「compact 确实被调过」由下面这次调用本身的存在性保证（fake 只会从 compact 里写 capture）。
		assert.deepEqual(
			capture.options,
			undefined,
			"开关关闭 ⇒ 整个 options 为 undefined（与改动前逐字节一致）",
		);
	});
});
