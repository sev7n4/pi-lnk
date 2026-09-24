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
