/**
 * 生成等待期 onUpdate 进度 ticker 测试（2026-10-18 上游对齐）。
 * 发射形状契约：partial 全量快照 + {checkpoint:true}，Nest pi-events 按
 * details.generating 派生 generation_progress——改形状必改两端。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startGenerationProgressTicker, GENERATION_PROGRESS_INTERVAL_MS } from "./progress-ticker.js";

type Update = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

describe("startGenerationProgressTicker", () => {
	it("按间隔发射全量快照 + checkpoint，elapsedSec 单调不减", async () => {
		const updates: Array<{ partial: Update; options?: { checkpoint?: boolean } }> = [];
		const stop = startGenerationProgressTicker((partial, options) => {
			updates.push({ partial: partial as unknown as Update, options });
		}, "node-p", 20);
		await new Promise((r) => setTimeout(r, 90));
		stop();
		await new Promise((r) => setTimeout(r, 60));
		assert.ok(updates.length >= 2, `应至少发射 2 拍，实际 ${updates.length}`);
		assert.equal(updates[0]!.options?.checkpoint, true);
		const first = JSON.parse(updates[0]!.partial.content[0]!.text) as { status: string; nodeId: string; elapsedSec: number };
		assert.equal(first.status, "generating");
		assert.equal(first.nodeId, "node-p");
		assert.deepEqual(updates[0]!.partial.details, {
			ok: true,
			generating: true,
			nodeId: "node-p",
			elapsedSec: first.elapsedSec,
		});
		const last = JSON.parse(updates[updates.length - 1]!.partial.content[0]!.text) as { elapsedSec: number };
		assert.ok(last.elapsedSec >= first.elapsedSec);
		// 停表后不再发射（重复停表无害）
		const count = updates.length;
		stop();
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(updates.length, count);
	});

	it("onUpdate 抛错被吞掉（进度上报绝不在工具主链路上炸）", async () => {
		const stop = startGenerationProgressTicker(() => {
			throw new Error("observer boom");
		}, "node-p", 15);
		await new Promise((r) => setTimeout(r, 60));
		stop();
		// 不抛即通过
	});

	it("onUpdate 缺省（legacy 形态/直测）→ no-op 停表", () => {
		const stop = startGenerationProgressTicker(undefined, "node-p");
		stop();
	});

	it("默认间隔 30s（stall watchdog 活性拍 + checkpoint 频率上限的权衡值）", () => {
		assert.equal(GENERATION_PROGRESS_INTERVAL_MS, 30_000);
	});
});
