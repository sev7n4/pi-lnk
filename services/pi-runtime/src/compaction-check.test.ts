import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideCompaction, classifyCompactionError } from "./compaction-check.js";
import type { Entry } from "@earendil-works/pi-agent-core";

/** 构造带 usage 的 assistant message 条目；vendor 的 Entry 不变式较多，测试用最小形状铸造。 */
function assistantEntry(totalTokens: number, stopReason = "stop"): Entry {
	return {
		type: "message",
		message: { role: "assistant", stopReason, usage: { totalTokens } },
	} as unknown as Entry;
}

describe("decideCompaction", () => {
	const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };

	it("超过阈值时判定为真", () => {
		const d = decideCompaction([assistantEntry(120_000)], 128_000, settings);
		assert.equal(d.shouldRun, true);
		assert.equal(d.threshold, 111_616);
		assert.equal(d.contextTokens, 120_000);
	});

	it("低于阈值时判定为假且给出 below_threshold", () => {
		const d = decideCompaction([assistantEntry(100_000)], 128_000, settings);
		assert.equal(d.shouldRun, false);
		assert.equal(d.skipReason, "below_threshold");
	});

	it("enabled=false 时短路为 disabled", () => {
		const d = decideCompaction([assistantEntry(9_999_999)], 128_000, { ...settings, enabled: false });
		assert.equal(d.shouldRun, false);
		assert.equal(d.skipReason, "disabled");
	});

	it("contextWindow 缺失/非正时短路为 no_window", () => {
		assert.equal(decideCompaction([assistantEntry(1)], undefined, settings).skipReason, "no_window");
		assert.equal(decideCompaction([assistantEntry(1)], 0, settings).skipReason, "no_window");
	});

	it("没有 assistant usage 时短路为 no_usage", () => {
		const userOnly = [{ type: "message", message: { role: "user", content: "hi" } }] as unknown as Entry[];
		assert.equal(decideCompaction(userOnly, 128_000, settings).skipReason, "no_usage");
	});

	it("最后一轮 stopReason 为 aborted 时不取该轮 usage", () => {
		// 前一轮刻意低于阈值：若实现误取了最后一轮的 9_000_000，下面两条断言会同时失败
		// （plan 原稿此处给的前一轮是 120_000，已超阈值 111_616，与 shouldRun:false 自相矛盾）。
		const d = decideCompaction([assistantEntry(100_000), assistantEntry(9_000_000, "aborted")], 128_000, settings);
		assert.equal(d.shouldRun, false);
		assert.equal(d.skipReason, "below_threshold");
		assert.equal(d.contextTokens, 100_000);
	});
});

describe("classifyCompactionError", () => {
	it("按错误类名归类为说明理由", () => {
		class NothingToCompact extends Error {}
		class LaneBusy extends Error {}
		class Closed extends Error {}
		assert.equal(classifyCompactionError(new NothingToCompact()), "nothing_to_compact");
		assert.equal(classifyCompactionError(new LaneBusy()), "lane_busy");
		assert.equal(classifyCompactionError(new Closed()), "closed");
		assert.equal(classifyCompactionError(new Error("boom")), "unknown");
	});
});
