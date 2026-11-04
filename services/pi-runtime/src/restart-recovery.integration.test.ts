import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

/**
 * P2 Task 5 · 重启演练集成（rootfix T5 验收的运行时侧证据）。
 *
 * 两个剧本，对齐 Nest 对账 probe（`reconcileLatestAssistant`）的裁决面：
 *  1. 进行中回合：结构性事件已入 journal、无终态帧 → 重启 → 重放可见 tool_* 等
 *     且**不含终态** ⇒ probe 判 active（继续等待，不误杀）；
 *  2. 刚完成回合：终态帧已入 journal → 重启 → 重放含 turn_end
 *     ⇒ probe 判 settled（补结算，不弹失败卡）。
 *
 * 判 active/settled 的运行时侧等价判据 = 重放流里有无终态帧
 * （probe 消费重放至首个终态帧；见 agent.service.ts probeRunEventStream）。
 *
 * ⭐ 变异守卫（本文件提交时已做过两轮变异实验，均有既有用例承接红灯）：
 *  ① 删 `rebuildReplayFromJournal` 的 `nextSeq = recoverNextSeq(recs)`
 *     ⇒ session-journal-rebuild.test.ts「nextSeq = max(seq)+1」红（seq 撞号）；
 *  ② journal 名单混入 message_update（或删一个终态类型）
 *     ⇒ events-journal.test.ts 的穷举断言红。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-p2t5-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));
let cfgSeq = 0;

function makeManager() {
	const fakeHarnessFactory = (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {},
		},
	})) as never;
	return new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: join(TEST_ROOT, `r${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
	});
}

type EntryLike = {
	journal?: { append: (r: { seq: number; event: unknown }) => void; close: () => Promise<void> };
	buffer: Array<{ type: string; seq: number }>;
	nextSeq: number;
};

function smInternals(sm: SessionManager) {
	return sm as unknown as {
		sessions: Map<string, EntryLike>;
		destroyMemoryOnly: (k: string) => Promise<void>;
		dispatch: (e: EntryLike, ev: Record<string, unknown>) => void;
		ensureLoaded: (k: string) => Promise<boolean>;
	};
}

/** 一次完整的「重启演练」：建会话 → dispatch → 模拟重启 → ensureLoaded → 返回重放流。 */
async function restartDrill(
	sm: SessionManager,
	key: string,
	dispatches: Array<Record<string, unknown>>,
): Promise<Array<{ type: string; seq: number }>> {
	const internals = smInternals(sm);
	await sm.create(key, { userId: "u1" });
	const sk = internals.sessions.keys().next().value as string;
	const entry = internals.sessions.get(sk)!;
	for (const d of dispatches) internals.dispatch(entry, d);
	await entry.journal!.close();
	await internals.destroyMemoryOnly(sk);

	assert.equal(await sm.ensureLoaded(key), true, "重启后 lazy reload 必须成功");
	const replay = sm.subscribe(key, () => {}, -1);
	return replay.map((e) => ({ type: e.type, seq: e.seq }));
}

describe("P2 重启演练（rootfix T5 验收）", () => {
	it("进行中回合：重放含结构性事件、无终态帧 ⇒ probe 等价判据 active", async () => {
		const sm = makeManager();
		const replay = await restartDrill(sm, "drill-active", [
			{ type: "turn_start", payload: {} },
			{ type: "tool_execution_start", payload: { toolName: "run_text_generation" } },
			{ type: "tool_execution_end", payload: { toolName: "run_text_generation" } },
		]);
		assert.deepEqual(
			replay.map((e) => `${e.seq}:${e.type}`),
			["0:turn_start", "1:tool_execution_start", "2:tool_execution_end"],
		);
		assert.equal(
			replay.some((e) => e.type === "turn_end"),
			false,
			"无终态帧 ⇒ probe 消费完重放也不会提前返回 ⇒ active（不误杀在跑回合）",
		);
	});

	it("刚完成回合：重放含终态帧 turn_end ⇒ probe 等价判据 settled", async () => {
		const sm = makeManager();
		const replay = await restartDrill(sm, "drill-settled", [
			{ type: "turn_start", payload: {} },
			{ type: "tool_execution_start", payload: { toolName: "run_image_generation" } },
			{ type: "tool_execution_end", payload: { toolName: "run_image_generation" } },
			{ type: "turn_end", payload: {} },
		]);
		assert.equal(
			replay.some((e) => e.type === "turn_end"),
			true,
			"终态帧在重放里 ⇒ probe 消费至终态即 settled（补结算、不弹失败卡）",
		);
		assert.equal(replay[replay.length - 1].type, "turn_end", "终态帧必须是重放末帧（游标锚点）");
	});
});
