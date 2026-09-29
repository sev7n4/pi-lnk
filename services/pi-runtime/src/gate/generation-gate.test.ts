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

// ── V-γ 逃生口：预算耗尽后用户重新确认（SSOT 回到 pending_confirm）→ 预算清零重跑 ──

function driveToBudgetExhausted() {
	const store = new GenerationGateStore();
	// 第 1 次：SSOT=pending_confirm → 放行 0→1；第 2 次：completed → retry 放行 1→2
	return checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" })
		.then(() => checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" }))
		.then(() => store);
}

test("V-γ 逃生口：预算耗尽后用户重新确认（SSOT=pending_confirm）→ 清零并放行且非 retry", async () => {
	const store = await driveToBudgetExhausted();
	assert.equal(store.runCount("s1", "n1"), 2);
	const r = await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(r, { allowed: true }, "重新确认 = 新意图，放行且不得打 retry 标记");
	assert.equal(store.runCount("s1", "n1"), 1, "clearRun 清零后走正常首跑路径，markRun 消费 0→1");
});

test("V-γ 逃生口：预算耗尽且未重新确认（SSOT≠pending_confirm）→ 仍拦截且预算不变", async () => {
	const store = await driveToBudgetExhausted();
	const r = await checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /ask_user|propose_generation/);
	assert.equal(store.runCount("s1", "n1"), 2, "被拦不消费也不清零预算");
});

test("V-γ 逃生口：非 GATED 工具在预算耗尽后也不得触发 clearRun", async () => {
	const store = await driveToBudgetExhausted();
	const read = await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "get_node", { node_id: "n1" });
	assert.deepEqual(read, { allowed: true });
	assert.equal(store.runCount("s1", "n1"), 2, "非 GATED 调用零接触预算（不清零）");
});

// ── SSOT 查询的 sessionId 解耦（#74 后 gate 必须带画布会话 id）──────────────
// 背景：gate 在 index.ts 的 onSessionCreated 闭包里只拿得到 pi 会话键；#74 之前
// pi 键 == 画布 id 所以没事，解耦后拿键查 Nest get-node 必 404 → 全部 run_* 被
// fail-closed 假阳性拦截（2026-09-29 生产冒烟实证）。SSOT 查询必须用画布会话 id。

function bodyCapturingClient(response: unknown, opts: { throwOnPost?: boolean } = {}) {
	const bodies: Array<Record<string, unknown>> = [];
	return {
		bodies,
		post: async (_path: string, body: unknown) => {
			bodies.push(body as Record<string, unknown>);
			if (opts.throwOnPost) throw new Error("boom");
			return response;
		},
	};
}

const PENDING_NODE = { data: { status: "pending_confirm" } };

test("SSOT 查询带 opts.canvasSessionId 时必须用它（而非 pi 会话键）", async () => {
	const c = bodyCapturingClient(PENDING_NODE);
	const r = await checkGenerationGate(
		new GenerationGateStore(), c, "pi-key-abc", GATED, { node_id: "n1" }, { canvasSessionId: "canvas-9" },
	);
	assert.equal(r.allowed, true);
	assert.deepEqual(c.bodies[0], { sessionId: "canvas-9", nodeId: "n1" });
});

test("未传 opts.canvasSessionId 时回落 sessionId（兼容旧调用/单测）", async () => {
	const c = bodyCapturingClient(PENDING_NODE);
	const r = await checkGenerationGate(new GenerationGateStore(), c, "pi-key-abc", GATED, { node_id: "n1" });
	assert.equal(r.allowed, true);
	assert.deepEqual(c.bodies[0], { sessionId: "pi-key-abc", nodeId: "n1" });
});

test("V-γ 逃生口的 SSOT 查询同样必须用画布会话 id", async () => {
	const store = new GenerationGateStore();
	store.markRun("pi-key-abc", "n1");
	store.markRun("pi-key-abc", "n1"); // runs = 2 → 进入逃生口分支
	const c = bodyCapturingClient(PENDING_NODE);
	const r = await checkGenerationGate(
		store, c, "pi-key-abc", GATED, { node_id: "n1" }, { canvasSessionId: "canvas-9" },
	);
	assert.equal(r.allowed, true);
	assert.deepEqual(c.bodies[0], { sessionId: "canvas-9", nodeId: "n1" });
});
