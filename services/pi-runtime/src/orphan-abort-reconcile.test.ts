import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countAbortReconcileSpans } from "./session-manager.js";
import { Metrics } from "./metrics.js";

describe("countAbortReconcileSpans（P1：vendor abort_reconcile 结构信号）", () => {
	it("命中：pi.harness.checkpoint + kind=abort_reconcile 按个数计数", () => {
		const spans = [
			{ name: "pi.harness.checkpoint", attributes: { "pi.checkpoint.kind": "abort_reconcile" } },
			{ name: "pi.harness.turn", attributes: {} },
			{ name: "pi.harness.checkpoint", attributes: { "pi.checkpoint.kind": "abort_reconcile" } },
		];
		assert.equal(countAbortReconcileSpans(spans), 2);
	});

	it("不命中：kind=normal / span 名不符 / 属性缺失（属性键用 vendor 确切的 pi.checkpoint.kind）", () => {
		const spans = [
			{ name: "pi.harness.checkpoint", attributes: { "pi.checkpoint.kind": "normal" } },
			{ name: "pi.harness.checkpoint", attributes: {} },
			{ name: "pi.harness.turn", attributes: { "pi.checkpoint.kind": "abort_reconcile" } },
			{ name: "pi.harness.checkpoint", attributes: { kind: "abort_reconcile" } },
		];
		assert.equal(countAbortReconcileSpans(spans), 0);
	});

	it("空集：0（空集合法——断言的是 0，不是异常）", () => {
		assert.equal(countAbortReconcileSpans([]), 0);
	});
});

describe("orphan settle 指标渲染（P1）", () => {
	it("ok/drift 双标签恒渲染，计数正确", () => {
		const m = new Metrics();
		m.observeOrphanSettle(true);
		m.observeOrphanSettle(true);
		m.observeOrphanSettle(false);
		const text = m.render(0, "test");
		assert.match(text, /pi_runtime_orphan_settle_abort_reconcile_total\{outcome="ok"\} 2/);
		assert.match(text, /pi_runtime_orphan_settle_abort_reconcile_total\{outcome="drift"\} 1/);
	});

	it("零样本也恒渲染（drift 恒 0 才是健康态；缺失行会与「从未触发」混淆）", () => {
		const m = new Metrics();
		const text = m.render(0, "test");
		assert.match(text, /pi_runtime_orphan_settle_abort_reconcile_total\{outcome="ok"\} 0/);
		assert.match(text, /pi_runtime_orphan_settle_abort_reconcile_total\{outcome="drift"\} 0/);
	});
});
