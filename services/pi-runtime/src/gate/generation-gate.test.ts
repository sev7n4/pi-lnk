import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerationGateStore } from "./generation-gate.js";

test("same-turn propose is detected", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), true);
});

test("user turn bump releases same-turn proposal", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	s.bumpUserTurn("sess1");
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), false);
});

test("sessions are isolated", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	assert.equal(s.wasProposedThisTurn("sess2", "n_1"), false);
});

test("resetSession clears state", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	s.resetSession("sess1");
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), false);
});

test("propose after bump is gated again in the new turn", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	s.bumpUserTurn("sess1");
	s.markProposed("sess1", "n_1"); // 用户确认后的新一轮里模型再次 propose
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), true);
});

// ── checkGenerationGate（B-5 HITL Gate 策略）────────────────────────────

import { checkGenerationGate } from "./generation-gate.js";

const GATED = "run_image_generation";

function fakeClient(response: unknown, opts: { throwOnPost?: boolean } = {}) {
	return {
		post: async () => {
			if (opts.throwOnPost) throw new Error("boom");
			return response;
		},
	};
}

test("non-gated tools pass without any check", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient(null), "s", "upsert_prompt_node", {});
	assert.deepEqual(r, { allowed: true });
});

test("missing node_id blocks", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient(null), "s", GATED, {});
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /node_id/);
});

test("same-turn propose blocks (self-approval guard)", async () => {
	const s = new GenerationGateStore();
	s.markProposed("s", "n_1");
	const r = await checkGenerationGate(
		s,
		fakeClient({ id: "n_1", data: { status: "pending_confirm" } }),
		"s",
		GATED,
		{ node_id: "n_1" },
	);
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /propose/);
});

test("pending_confirm node passes after canvas SSOT check", async () => {
	const r = await checkGenerationGate(
		new GenerationGateStore(),
		fakeClient({ id: "n_1", type: "image", position: { x: 0, y: 0 }, data: { status: "pending_confirm" } }),
		"s",
		GATED,
		{ node_id: "n_1" },
	);
	assert.deepEqual(r, { allowed: true });
});

test("node not in pending_confirm blocks with current status", async () => {
	const r = await checkGenerationGate(
		new GenerationGateStore(),
		fakeClient({ id: "n_1", type: "image", position: { x: 0, y: 0 }, data: { status: "generating" } }),
		"s",
		GATED,
		{ node_id: "n_1" },
	);
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /generating/);
});

test("get-node failure fails closed", async () => {
	const r = await checkGenerationGate(
		new GenerationGateStore(),
		fakeClient(null, { throwOnPost: true }),
		"s",
		GATED,
		{ node_id: "n_1" },
	);
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /fail-closed|校验/);
});

test("tolerates node shape without data object (unknown status -> block)", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient({ id: "n_1" }), "s", GATED, {
		node_id: "n_1",
	});
	assert.equal(r.allowed, false);
});

// ── V-γ：Gate 重试预算（第 2 次放行打 retry、第 3 次拦截转 ask_user）────

// 一个已 propose 且已跨轮的节点：SSOT 返回 pending_confirm（首跑成功后会变 completed）
function gateClientReturning(status: string) {
	return { post: async () => ({ data: { status } }) };
}

test("V-γ：第 1 次 run 走 SSOT 校验；第 2 次直接放行（retry=true）；第 3 次拦截", async () => {
	const store = new GenerationGateStore();
	// 第 1 次：SSOT=pending_confirm → 放行（非 retry），并消费掉 1 次预算
	const first = await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(first, { allowed: true });
	assert.equal(store.runCount("s1", "n1"), 1);

	// 第 2 次：预算=1 → 直接放行 retry（此刻 SSOT 已变 completed，仍须放行）
	const retry = await checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(retry, { allowed: true, retry: true });
	assert.equal(store.runCount("s1", "n1"), 2);

	// 第 3 次：预算=2 → 拦截，转 ask_user / propose
	const third = await checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(third.allowed, false);
	assert.match(third.reason ?? "", /ask_user|propose_generation/);
});

test("V-γ 边界：预算按节点隔离；非 pending 节点的首次 run 被拦且**不消费预算**", async () => {
	const store = new GenerationGateStore();
	await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(store.runCount("s1", "n2"), 0);
	const other = await checkGenerationGate(store, gateClientReturning("idle"), "s1", "run_image_generation", { node_id: "n2" });
	assert.equal(other.allowed, false);
	assert.match(other.reason ?? "", /待确认状态/);
	assert.equal(store.runCount("s1", "n2"), 0, "被拦不消费预算");
});

test("Review Focus ⑥（P0 回归）：非 GATED 工具不得写预算，否则首次 run 会绕过 SSOT", async () => {
	const store = new GenerationGateStore();
	// 模型先读节点（很自然的动作）——不得污染预算
	const read = await checkGenerationGate(store, gateClientReturning("idle"), "s1", "get_node", { node_id: "n1" });
	assert.deepEqual(read, { allowed: true });
	assert.equal(store.runCount("s1", "n1"), 0, "非 GATED 工具写预算 = Gate 可被绕过");

	// 紧接着首次 run：SSOT=idle → 必须被拦（若预算被污染，这里会误放行）
	const run = await checkGenerationGate(store, gateClientReturning("idle"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(run.allowed, false, "预算被 get_node 污染会导致 HITL 确认权被架空");
	assert.match(run.reason ?? "", /待确认状态/);
});

test("Review Focus ⑤：会话重置后预算清零（重新确认 = 新会话新意图）", async () => {
	const store = new GenerationGateStore();
	await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	await checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(store.runCount("s1", "n1"), 2);
	store.resetSession("s1");
	assert.equal(store.runCount("s1", "n1"), 0);
	const after = await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(after, { allowed: true });
});
