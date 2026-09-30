import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideCompaction, classifyCompactionError } from "./compaction-check.js";
import type { Entry } from "@earendil-works/pi-agent-core";
// 真实 vendor 错误类（非测试替身）：反应该模块在生产里面对的究竟是什么对象。
import { Closed, LaneBusy, NothingToCompact } from "@earendil-works/pi-agent-core";

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

	it("认得 harness 真正抛出的那三个类（而非仅测试替身）", () => {
		// 这条是不能省的回归锁：vendor 用 `TaggedError(tag)` 工厂批量生成这些类，
		// 本模块靠类名判别。若将来工厂改成匿名类/Proxy，上面的替身用例仍全绿，
		// 但生产里三个 branch 会静默全部落到 `unknown` —— 错误分类失效却不报错。
		assert.equal(
			classifyCompactionError(new NothingToCompact({ lane: "main", message: "m" })),
			"nothing_to_compact",
		);
		assert.equal(
			classifyCompactionError(
				new LaneBusy({ lane: "main", operationId: "o", operationKind: "compaction", message: "m" }),
			),
			"lane_busy",
		);
		assert.equal(classifyCompactionError(new Closed({ message: "m" })), "closed");
	});
});
