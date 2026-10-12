import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isToolResultSignal,
	isGenDetails,
	isWriteDetails,
	isReadSummaryDetails,
	signalFromUpstream,
	withSignal,
} from "./result-signal.js";

describe("signalFromUpstream（vendor 薄适配 + 本地域单点，禁 LLM）", () => {
	it("限流文本 → failed + retryable=true（agnes 病例：vendor 瞬时 pattern）", () => {
		const s = signalFromUpstream({ ok: false, message: "429 Too Many Requests, rate limit exceeded" });
		assert.equal(s.status, "failed");
		assert.equal(s.retryable, true);
	});
	it("timeout 状态（生成未完成）→ partial + retryable=true", () => {
		const s = signalFromUpstream({ ok: true, status: "timeout" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, true);
	});
	it("配额/计费文本 → failed + retryable 缺省（未判明；vendor-false 无法区分配额 vs 未识别）", () => {
		const s = signalFromUpstream({ ok: false, message: "insufficient_quota: out of budget" });
		assert.equal(s.status, "failed");
		assert.equal("retryable" in s, false);
	});
	it("errorCode unknown / 无文本 → failed + retryable 缺省（未判明）", () => {
		const s = signalFromUpstream({ ok: false, errorCode: "unknown" });
		assert.equal(s.status, "failed");
		assert.equal("retryable" in s, false);
	});
	it("empty_result（本地域事实）→ partial + retryable=false", () => {
		const s = signalFromUpstream({ ok: true, status: "empty_result" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, false);
	});
	it("fallback_pending（本地域事实）→ partial + retryable=false", () => {
		const s = signalFromUpstream({ ok: true, status: "fallback_pending" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, false);
	});
	it("invalid_params（本地域事实）→ failed + retryable=false", () => {
		const s = signalFromUpstream({ ok: false, status: "invalid_params" });
		assert.equal(s.status, "failed");
		assert.equal(s.retryable, false);
	});
	it("ok:true 且无异常字段 → 恰为 {status:'ok'}（三态：ok 不写 retryable）", () => {
		assert.deepEqual(signalFromUpstream({ ok: true, url: "https://x" }), { status: "ok" });
	});
	it("error_code 下划线归一", () => {
		assert.equal(signalFromUpstream({ ok: false, error_code: "rate limit" }).errorCode, "rate limit");
	});
	it("非 object 输入 fail-soft → ok（绝不 throw）", () => {
		assert.equal(signalFromUpstream(null).status, "ok");
		assert.equal(signalFromUpstream("str").status, "ok");
	});
});

describe("守卫族", () => {
	it("isToolResultSignal 合法/非法判定", () => {
		assert.ok(isToolResultSignal({ status: "ok" }));
		assert.ok(!isToolResultSignal({ status: "yes" }));
		assert.ok(!isToolResultSignal(null));
	});
	it("isGenDetails：modelUsed + generationParams 必填", () => {
		assert.ok(isGenDetails({ modelUsed: "agnes-2.5-flash", generationParams: { w: 1 } }));
		assert.ok(!isGenDetails({ modelUsed: "x" }));
		assert.ok(!isGenDetails(null));
	});
	it("isWriteDetails：affectedCount 数字", () => {
		assert.ok(isWriteDetails({ affectedCount: 3 }));
		assert.ok(!isWriteDetails({ affectedCount: "3" }));
	});
	it("isReadSummaryDetails：coverage + scope 必填", () => {
		assert.ok(isReadSummaryDetails({ coverage: "partial", scope: "nodes[0..20]" }));
		assert.ok(!isReadSummaryDetails({ coverage: "partial" }));
	});
});

describe("withSignal", () => {
	it("写入 details._signal 键（下划线前缀）且展开保留 actions/confirmed", () => {
		const base = {
			content: [] as Array<{ type: string; text?: string }>,
			details: { actions: [{ type: "add_node" }], confirmed: true },
		};
		const out = withSignal(base, { status: "ok" });
		assert.equal(out.details.actions.length, 1);
		assert.equal(out.details.confirmed, true);
		assert.equal(out.details._signal.status, "ok");
		assert.equal("signal" in out.details, false);
	});
	it("content 引用不变（run_image 双 block 场景安全）", () => {
		const content: Array<{ type: string; text?: string; url?: string }> = [
			{ type: "text", text: "a" },
			{ type: "image", url: "x" },
		];
		const out = withSignal({ content, details: {} }, { status: "ok" });
		assert.equal(out.content.length, 2);
	});
});
