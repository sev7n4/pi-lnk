/**
 * P0-2：abort 销毁队列内容时必须**把它吐回来**（2026-10-20）。
 *
 * 背景：vendor 的 `requestOperationAbort`（`harness/runtime/lane.ts:1047-1089`）在中止时
 * 会把 inbox 里的 steer/followUp **移除并删除其 pending entry**（不可恢复），但把内容经
 * `AbortRequestResult.steer/followUp` 返给调用方 —— 上游 coding-agent 的 `clearQueue()`
 * 就是拿它把队列内容放回编辑器的。
 *
 * 我们此前**丢弃**了该返回值（`session-manager.ts` 的 forceSettleLaneOperation /
 * settleOneOrphan 两处）⇒ 用户插队的消息在孤儿/看护结算路径上**静默消失**。
 *
 * 本测试锁三件事：
 *   1. 正常取消（run 正在跑）**不删队列** ⇒ 没有可吐回的（recovered 为空）；
 *   2. force 分支（lane 上钉着孤儿 operation）会真删 ⇒ 内容必须被吐回；
 *   3. 吐回的内容是**纯文本**（vendor 的 AgentMessage 里取 text 段）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toRecoveredQueueItems } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-abort-recover-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `a${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	} as unknown as RuntimeConfig;
}

describe("toRecoveredQueueItems：把 vendor 吐回的消息转成可回灌的纯文本", () => {
	it("steer 与 followUp 分组保留标签，文本按 content 里的 text 段拼接", () => {
		const items = toRecoveredQueueItems(
			[{ role: "user", content: [{ type: "text", text: "再亮一点" }], timestamp: 1 }],
			[{ role: "user", content: [{ type: "text", text: "然后导出" }], timestamp: 2 }],
		);
		assert.deepEqual(items, [
			{ kind: "steer", text: "再亮一点" },
			{ kind: "followUp", text: "然后导出" },
		]);
	});

	it("⭐ 多个 text 段按顺序拼成一条（不是只取第一段）", () => {
		const items = toRecoveredQueueItems(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "前半" },
						{ type: "text", text: "后半" },
					],
					timestamp: 1,
				},
			],
			[],
		);
		assert.equal(items.length, 1);
		assert.equal(items[0]!.text, "前半后半");
	});

	it("⭐ 只有图片的消息保留但文本为空（丢弃就是另一种数据丢失）", () => {
		const items = toRecoveredQueueItems(
			[
				{
					role: "user",
					content: [{ type: "image", data: "base64", mimeType: "image/png" }],
					timestamp: 1,
				},
			],
			[],
		);
		assert.equal(items.length, 1);
		assert.equal(items[0]!.text, "");
	});

	it("⭐ content 是纯字符串时也能取到文字（类型允许两种形态，漏一个就取不到）", () => {
		const items = toRecoveredQueueItems(
			[{ role: "user", content: "整段就是字符串", timestamp: 1 }],
			[],
		);
		assert.deepEqual(items, [{ kind: "steer", text: "整段就是字符串" }]);
	});

	it("非 user 角色的消息被跳过（联合类型里它们没有 content 数组）", () => {
		const items = toRecoveredQueueItems(
			[
				{ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
			],
			[],
		);
		assert.deepEqual(items, []);
	});

	it("空数组 ⇒ 空结果（正常取消路径）", () => {
		assert.deepEqual(toRecoveredQueueItems([], []), []);
	});
});

/** 造一个「lane 上钉着孤儿 operation」的 manager：inspectExecution 有 current、requestAbort 返回内容。 */
function makeOrphanManager(recovered: { steer: unknown[]; followUp: unknown[] }) {
	const lane = {
		prompt: async () => ({ ok: true }),
		inspectExecution: async () => ({ current: { id: "op-1", kind: "run" } }),
		requestAbort: async () => ({
			ok: true,
			value: { operationId: "op-1", newlyRequested: true, steer: recovered.steer, followUp: recovered.followUp },
		}),
		drive: async () => ({ ok: true, value: { kind: "aborted" } }),
	};
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

describe("SessionManager.abort：force 分支必须吐回被销毁的队列内容", () => {
	it("⭐ lane 上有孤儿 operation ⇒ abort 返回 recovered（内容不再静默消失）", async () => {
		const sm = makeOrphanManager({
			steer: [{ role: "user", content: [{ type: "text", text: "再亮一点" }], timestamp: 1 }],
			followUp: [],
		});
		await sm.create("ar-1", { userId: "u1" });

		const result = await sm.abort("ar-1");

		assert.equal(result.aborted, true);
		assert.deepEqual(result.recovered, [{ kind: "steer", text: "再亮一点" }]);
	});

	it("没有可吐回的内容 ⇒ recovered 为空数组（不是 undefined）", async () => {
		const sm = makeOrphanManager({ steer: [], followUp: [] });
		await sm.create("ar-2", { userId: "u1" });

		const result = await sm.abort("ar-2");

		assert.equal(result.aborted, true);
		assert.deepEqual(result.recovered, []);
	});

	it("会话不存在 ⇒ aborted=false + recovered 空（不是异常）", async () => {
		const sm = makeOrphanManager({ steer: [], followUp: [] });
		const result = await sm.abort("ar-missing");
		assert.equal(result.aborted, false);
		assert.deepEqual(result.recovered, []);
	});
});
