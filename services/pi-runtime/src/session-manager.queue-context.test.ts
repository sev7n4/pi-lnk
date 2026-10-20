/**
 * P1 插话上下文与带图（2026-10-20）：
 * - `withQueueContext`：消息级上下文块拼进文本（独立于会话级 turnContext 的覆盖写语义）；
 * - steer / followUp 的 `images` 透传到 vendor `lane.steer/followUp` 第二参（P1-2 带图），
 *   门控与主链路 prompt 同款（`directImages !== false`），且**绝不发空数组**（Review Focus 1）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, withQueueContext, type QueueContext } from "./session-manager.js";
import type { DirectImage } from "./direct-images.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-queue-ctx-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));
let cfgSeq = 0;
function testConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `c${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		...overrides,
	};
}

describe("withQueueContext（消息级上下文块）", () => {
	it("无上下文 ⇒ 原样返回（不添任何标记）", () => {
		assert.equal(withQueueContext("把标题改短一点"), "把标题改短一点");
		assert.equal(withQueueContext("把标题改短一点", undefined), "把标题改短一点");
		assert.equal(withQueueContext("把标题改短一点", { blocks: [] }), "把标题改短一点");
	});

	it("有上下文 ⇒ 拼在用户原话之后（原话在前，注解在后），空行分隔", () => {
		const ctx: QueueContext = { blocks: ["侧栏参考素材：\nI1=a.png", "画布选中：node-1（image）"] };
		assert.equal(
			withQueueContext("把标题改短一点", ctx),
			"把标题改短一点\n\n侧栏参考素材：\nI1=a.png\n\n画布选中：node-1（image）",
		);
	});

	it("空白块被过滤（trim 后为空的块不产生孤立空行）", () => {
		const ctx: QueueContext = { blocks: ["  ", "有效块", ""] };
		assert.equal(withQueueContext("问题", ctx), "问题\n\n有效块");
	});
});

describe("P1-2 steer/followUp 带图与上下文透传", () => {
	/** fake lane：捕获 steer/followUp 的 (message, images) 入参，返回 vendor QueueResult 形状。 */
	function queueCaptureFactory() {
		const calls: Array<{
			method: "steer" | "followUp";
			message: string;
			images: unknown;
		}> = [];
		const factory = async () =>
			({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({
						steer: async (message: string, images: unknown) => {
							calls.push({ method: "steer", message, images });
							return { ok: true, value: { entryId: `e-steer-${calls.length}` } };
						},
						followUp: async (message: string, images: unknown) => {
							calls.push({ method: "followUp", message, images });
							return { ok: true, value: { entryId: `e-fu-${calls.length}` } };
						},
						prompt: async () => ({ ok: true, value: { kind: "completed" } }),
					}),
					close: async () => {},
				},
			}) as never;
		return { factory, calls };
	}

	const IMG: DirectImage[] = [
		{ name: "a.png", mimeType: "image/png", data: "aGVsbG8=" },
	];

	it("steer 带图：images 转 ImageContent 后进 lane.steer 第二参；回传 entryId", async () => {
		const { factory, calls } = queueCaptureFactory();
		const sm = new SessionManager([], "", undefined, factory, undefined, undefined, testConfig());
		await sm.create("s-img-steer", {});
		const res = await sm.steer("s-img-steer", "把这张图里的按钮放大", "main", { images: IMG });
		assert.deepEqual(res, { queued: true, entryId: "e-steer-1" });
		assert.equal(calls[0]?.method, "steer");
		const imgs = calls[0]?.images as Array<{ type: string; source: unknown }> | undefined;
		assert.ok(Array.isArray(imgs) && imgs.length === 1, "第二参必须是长度 1 的数组（不能是 undefined/空）");
		assert.equal(imgs[0]?.type, "image");
	});

	it("steer 不带图：第二参是 undefined（绝不发空数组，Review Focus 1）", async () => {
		const { factory, calls } = queueCaptureFactory();
		const sm = new SessionManager([], "", undefined, factory, undefined, undefined, testConfig());
		await sm.create("s-noimg-steer", {});
		await sm.steer("s-noimg-steer", "继续");
		assert.equal(calls[0]?.images, undefined);
	});

	it("门控 directImages=false ⇒ 带了也传 undefined（与主链路 prompt 同口径）", async () => {
		const { factory, calls } = queueCaptureFactory();
		const sm = new SessionManager(
			[],
			"",
			undefined,
			factory,
			undefined,
			undefined,
			testConfig({ directImages: false }),
		);
		await sm.create("s-gate-steer", {});
		await sm.steer("s-gate-steer", "继续", "main", { images: IMG });
		assert.equal(calls[0]?.images, undefined);
	});

	it("queueContext 块拼进 steer 消息文本；turnContext 缺省不触碰会话级状态", async () => {
		const { factory, calls } = queueCaptureFactory();
		const sm = new SessionManager([], "", undefined, factory, undefined, undefined, testConfig());
		await sm.create("s-ctx-steer", {});
		await sm.steer("s-ctx-steer", "这个再亮一点", "main", {
			queueContext: { blocks: ["画布选中：node-9（image）"] },
		});
		assert.equal(calls[0]?.message, "这个再亮一点\n\n画布选中：node-9（image）");
	});

	it("followUp 同款：images 与 queueContext 都透传", async () => {
		const { factory, calls } = queueCaptureFactory();
		const sm = new SessionManager([], "", undefined, factory, undefined, undefined, testConfig());
		await sm.create("s-img-fu", {});
		const res = await sm.followUp("s-img-fu", "跑完后按这张图出一版", "main", {
			images: IMG,
			queueContext: { blocks: ["侧栏参考素材：\nI1=a.png"] },
		});
		assert.deepEqual(res, { queued: true, entryId: "e-fu-1" });
		assert.equal(calls[0]?.method, "followUp");
		assert.match(String(calls[0]?.message), /侧栏参考素材/);
		const imgs = calls[0]?.images as Array<{ type: string }> | undefined;
		assert.ok(Array.isArray(imgs) && imgs.length === 1);
		assert.equal(imgs[0]?.type, "image");
	});
});
