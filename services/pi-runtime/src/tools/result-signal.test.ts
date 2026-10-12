import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isToolResultSignal, signalFromUpstream, withSignal } from "./result-signal.js";

describe("signalFromUpstream（规则启发式，禁 LLM）", () => {
	it("429/限流 → failed + retryable=true（agnes 病例）", () => {
		const s = signalFromUpstream({ ok: false, errorCode: "rate_limited" });
		assert.equal(s.status, "failed");
		assert.equal(s.retryable, true);
	});
	it("upstream_timeout → partial + retryable=true（cogvideox 病例）", () => {
		const s = signalFromUpstream({ ok: false, status: "upstream_timeout" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, true);
	});
	it("status=timeout（生成未完成）→ partial + retryable=true", () => {
		const s = signalFromUpstream({ ok: true, status: "timeout" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, true);
	});
	it("status=fallback_pending → partial + retryable=false（需用户确认，不可盲重试）", () => {
		const s = signalFromUpstream({ ok: true, status: "fallback_pending" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, false);
	});
	it("ok:true 且无异常字段 → ok", () => {
		assert.deepEqual(signalFromUpstream({ ok: true, url: "https://x" }), {
			status: "ok",
			retryable: false,
		});
	});
	it("非 object 输入 fail-soft → ok（绝不 throw）", () => {
		assert.equal(signalFromUpstream(null).status, "ok");
		assert.equal(signalFromUpstream("str").status, "ok");
	});
});

describe("isToolResultSignal", () => {
	it("合法/非法判定", () => {
		assert.ok(isToolResultSignal({ status: "ok" }));
		assert.ok(!isToolResultSignal({ status: "yes" }));
		assert.ok(!isToolResultSignal(null));
	});
});

describe("withSignal", () => {
	it("展开原 details 保留全部键（actions/confirmed 不丢）", () => {
		const base = { content: [], details: { actions: [{ type: "add_node" }], confirmed: true } };
		const out = withSignal(base as never, { status: "ok" });
		assert.equal(out.details.actions.length, 1);
		assert.equal(out.details.confirmed, true);
		assert.equal(out.details.signal.status, "ok");
	});
	it("content 引用不变（run_image 双 block 场景安全）", () => {
		const content = [
			{ type: "text", text: "a" },
			{ type: "image", url: "x" },
		];
		const out = withSignal({ content, details: {} } as never, { status: "ok" });
		assert.equal(out.content.length, 2);
	});
});
