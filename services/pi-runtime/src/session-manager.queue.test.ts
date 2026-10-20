/**
 * steering / followUp 队列接入的回归锁（2026-10-02）。
 *
 * 只锁三件事，都是「坏了不会报错、只会静默不生效」的形态：
 *   1. 用户插话必须交给 vendor 队列（此前这条路径是 409 + 静默吞，等于消息蒸发）
 *   2. 空文本 / vendor 拒收必须带可判别的错误类型（路由层据此映射 400 / 503）
 *   3. idle 时入队必须**自动开一轮**接住它 —— vendor 明确没有 terminal drain
 *      （`docs/work-packages/05-direct-durable-drive.md:69` "There is no terminal drain"），
 *      少了这层兜底，用户视角就是「我发了，它不理我」。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, InvalidInputError, QueueRejectedError } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-queue-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `q${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 一轮微任务 + setImmediate：够 fire-and-forget 的 drain 跑完。 */
const settle = () => new Promise<void>((r) => setImmediate(r));

/** 调用流水：steer/followUp/prompt 各自按到达顺序记录，便于断言「谁被调了几次」。 */
interface LaneCalls {
	steer: string[];
	followUp: string[];
	prompt: string[];
	/** 撤回调用流水（2026-10-20 接上 vendor `cancelQueued`）。 */
	cancelQueued: string[];
	/** 让 `prompt` 永不 settle，用来模拟「run 还在跑」。 */
	hang?: boolean;
	/** 让 `steer` 返回拒收，用来模拟 vendor Closed 等。 */
	rejectSteer?: boolean;
}

function makeFakeLane(calls: LaneCalls) {
	// ⚠️ 2026-10-20：`steer/followUp` 现在会回传 `entryId`（撤回键，取自 vendor
	// `QueueResult{entryId}`），所以 fake lane **必须**给出 `value`，否则
	// `res.value.entryId` 会抛 TypeError —— 表现为「入队测试全红」，很容易误判成
	// 生产代码坏了（真实 lane 一定带 entryId，见 `harness/runtime/lane.ts:1434` enqueue）。
	let seq = 0;
	const enqueued = () => ({ ok: true, value: { entryId: `fake-entry-${++seq}` } });
	const lane = {
		steer: async (msg: string) => {
			calls.steer.push(msg);
			return calls.rejectSteer ? { ok: false, error: new Error("Closed") } : enqueued();
		},
		followUp: async (msg: string) => {
			calls.followUp.push(msg);
			return enqueued();
		},
		prompt: async (text?: string) => {
			calls.prompt.push(text ?? "");
			if (calls.hang) return new Promise(() => {});
			return { ok: true };
		},
		cancelQueued: async (entryId: string) => {
			calls.cancelQueued.push(entryId);
			return { ok: true, value: { kind: "cancelled" as const } };
		},
	};
	return lane;
}

function makeManager(calls: LaneCalls) {
	const lane = makeFakeLane(calls);
	const factory = async () =>
		({
			harness: {
				events: { on: () => () => {} },
				lane: async () => lane,
				close: async () => {},
			},
		} as never);
	return new SessionManager([], "", undefined, factory, undefined, undefined, testConfig());
}

describe("steer：用户插话走 vendor steering 队列", () => {
	it("idle 会话插话：入队 + 自动开一轮接住（vendor 没有 terminal drain）", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const sm = makeManager(calls);
		await sm.create("sq-idle", { userId: "u1" });

		const res = await sm.steer("sq-idle", "换个风格再生成一次");

		// 回传体现在带 entryId（撤回键）—— 断言它的**存在性**而非具体值
		// （fake lane 的 entryId 是自增序号，锁死字面量会在换 mock 时假红）。
		assert.equal(res.queued, true);
		assert.equal(typeof res.entryId, "string", "必须回传 entryId，否则上层无法撤回这条");
		assert.ok(res.entryId.length > 0);
		assert.deepEqual(calls.steer, ["换个风格再生成一次"]);
		// 关键：入队之后立刻有人来接（空 prompt 触发 accept 排空积压）
		await settle();
		assert.ok(calls.prompt.includes(""), "idle 插话后应自动开一轮排空，否则消息会一直睡着");
	});

	it("run 进行中插话：入队但不触发排空（该轮自己的边界会消费它）", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [], hang: true };
		const sm = makeManager(calls);
		await sm.create("sq-busy", { userId: "u1" });

		// 挂起一个 run，使会话处于 prompting
		void sm.prompt("sq-busy", "先画一版");
		await settle();
		assert.ok(calls.prompt.includes("先画一版"));

		const res = await sm.steer("sq-busy", "顺便把背景换成夜景");
		// 回传体现在带 entryId（撤回键）—— 断言它的**存在性**而非具体值
		// （fake lane 的 entryId 是自增序号，锁死字面量会在换 mock 时假红）。
		assert.equal(res.queued, true);
		assert.equal(typeof res.entryId, "string", "必须回传 entryId，否则上层无法撤回这条");
		assert.ok(res.entryId.length > 0);
		assert.deepEqual(calls.steer, ["顺便把背景换成夜景"]);

		// 入队≠新开一轮：不该再出现一条 prompt（那会变成两条 run 交错）
		assert.equal(calls.prompt.length, 1, "run 进行中插话不应触发新的 prompt");
	});

	it("空文本按 400 契约拒绝（InvalidInputError），不进 vendor 队列", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const sm = makeManager(calls);
		await sm.create("sq-empty", { userId: "u1" });

		await assert.rejects(() => sm.steer("sq-empty", "   "), InvalidInputError);
		await assert.rejects(() => sm.followUp("sq-empty", ""), InvalidInputError);
		assert.deepEqual(calls.steer, []);
		assert.deepEqual(calls.followUp, []);
	});

	it("vendor 拒收时抛 QueueRejectedError（路由层据此映射 503），不静默吞", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [], rejectSteer: true };
		const sm = makeManager(calls);
		await sm.create("sq-reject", { userId: "u1" });

		await assert.rejects(() => sm.steer("sq-reject", "插一句"), (err: unknown) => {
			assert.ok(err instanceof QueueRejectedError);
			assert.match((err as Error).message, /steer/);
			return true;
		});
		assert.deepEqual(calls.steer, ["插一句"], "vendor 已收到但被拒 → 仍要留下可查的痕迹");
	});

	it("会话不存在时 404 契约（NotFoundError 冒泡）", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const sm = makeManager(calls);
		await assert.rejects(() => sm.steer("sq-missing", "hi"));
	});
});

describe("followUp：尾随指令走 vendor followUp 队列", () => {
	it("入队的是 followUp 标签，不是 steer", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const sm = makeManager(calls);
		await sm.create("sq-fu", { userId: "u1" });

		const res = await sm.followUp("sq-fu", "然后导出成九宫格");

		// 回传体现在带 entryId（撤回键）—— 断言它的**存在性**而非具体值
		// （fake lane 的 entryId 是自增序号，锁死字面量会在换 mock 时假红）。
		assert.equal(res.queued, true);
		assert.equal(typeof res.entryId, "string", "必须回传 entryId，否则上层无法撤回这条");
		assert.ok(res.entryId.length > 0);
		assert.deepEqual(calls.followUp, ["然后导出成九宫格"]);
		assert.deepEqual(calls.steer, [], "followUp 必须走 followUp 通道，混用会让收尾续跑语义失效");
	});
});

describe("cancelQueued：撤回单条已入队的插话（2026-10-20）", () => {
	it("用入队回传的 entryId 撤回，outcome 如实透传", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const sm = makeManager(calls);
		await sm.create("sq-cancel", { userId: "u1" });

		// 先入队拿到 key
		const enqueued = await sm.steer("sq-cancel", "改成暖色调");
		assert.equal(typeof enqueued.entryId, "string");

		// 再用它撤回
		const res = await sm.cancelQueued("sq-cancel", enqueued.entryId);

		assert.deepEqual(res, { outcome: "cancelled" });
		assert.deepEqual(calls.cancelQueued, [enqueued.entryId], "必须把同一个 entryId 交给 vendor lane");
	});

	it("空 entryId 报InvalidInputError（路由层据此映射 400）", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const sm = makeManager(calls);
		await sm.create("sq-cancel-bad", { userId: "u1" });
		await assert.rejects(() => sm.cancelQueued("sq-cancel-bad", "   "), InvalidInputError);
		assert.deepEqual(calls.cancelQueued, [], "非法输入不该打到 vendor");
	});

	it("会话不存在时 404 契约（NotFoundError 冒泡）", async () => {
		const calls: LaneCalls = { steer: [], followUp: [], prompt: [], cancelQueued: [] };
		const sm = makeManager(calls);
		await assert.rejects(() => sm.cancelQueued("sq-missing-cancel", "e1"), /not found|session/i);
	});
});

describe("队列模式透传", () => {
	it("steeringMode / followUpMode 随 harness options 交出（此前是 configmap 死配置）", async () => {
		let captured: unknown;
		// ⚠️ 参数必须是 unknown 而不是 Record<string, unknown>：PR #103 把 HarnessFactory
		// 收成泛型 `typeof AgentHarness.create`，逆变下 Record 版本过不了 tsc（本地 tsx 不查类型，
		// 只跑这个文件会一路绿 —— CI 跑全量 tsc 才红）。
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
		const sm = new SessionManager([], "", undefined, factory, undefined, undefined, {
			...testConfig(),
			steeringMode: "all",
			followUpMode: "one-at-a-time",
		});
		await sm.create("sq-mode", { userId: "u1" });
		const modes = captured as { steeringMode: string; followUpMode: string };
		assert.equal(modes.steeringMode, "all");
		assert.equal(modes.followUpMode, "one-at-a-time");
	});
});
