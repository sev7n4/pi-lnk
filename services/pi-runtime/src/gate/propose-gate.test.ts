/**
 * A1 propose 单飞门单测（2026-11-02 老黄牛死循环护栏，RCA v2 §4-A1 + §5 验收 1/2）。
 *
 * 变异纪律：删 latch 分支 → 「latch」用例必须红；删 SSOT 分支 → 「in_flight」用例必须红；
 * 删 pending 分支 → 「pending」用例必须红。守卫禁删。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerationGateStore } from "./generation-gate.js";
import { PendingToolRegistry } from "../pending-registry.js";
import {
	checkProposeGate,
	registerProposeGateHooks,
	type ProposeGateBlockKind,
} from "./propose-gate.js";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";

function fakeClient(response: unknown, opts: { throwWith?: Error } = {}) {
	return {
		post: async () => {
			if (opts.throwWith) throw opts.throwWith;
			return response;
		},
	};
}

function nodeWith(status: string) {
	return { data: { status } };
}

// ── checkProposeGate 纯函数 ──────────────────────────────────────────────

test("非 propose 工具 → 放行（run_* 归 generation-gate 管）", async () => {
	const r = await checkProposeGate(new GenerationGateStore(), new PendingToolRegistry(), fakeClient(null), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(r, { allowed: true });
});

test("缺 node_id → 放行（工具 schema 负责参数校验）", async () => {
	const r = await checkProposeGate(new GenerationGateStore(), new PendingToolRegistry(), fakeClient(null), "s1", "propose_generation", {});
	assert.deepEqual(r, { allowed: true });
});

test("① latch：本 turn 已结算（confirmed）→ 拦，reason 含行动指令（事故主形态）", async () => {
	const store = new GenerationGateStore();
	store.markProposed("s1", "n1", { confirmed: true });
	const r = await checkProposeGate(store, new PendingToolRegistry(), fakeClient(null), "s1", "propose_generation", { node_id: "n1" });
	assert.equal(r.allowed, false);
	assert.equal(r.kind, "latch");
	assert.ok(r.reason?.includes("不要再次 propose_generation"), `reason 必须是行动指令：${r.reason}`);
});

test("① latch：timeout 等无副作用以外结算同样拦（RCA：timeout 重提议 ×5）", async () => {
	const store = new GenerationGateStore();
	store.markProposed("s1", "n1", { confirmed: false });
	const r = await checkProposeGate(store, new PendingToolRegistry(), fakeClient(null), "s1", "propose_generation", { node_id: "n1" });
	assert.equal(r.allowed, false);
});

test("① latch 豁免：missing_refs（transient）不锁，模型补绑 refs 后可同轮重提议", async () => {
	const store = new GenerationGateStore();
	store.markProposed("s1", "n1", { confirmed: false, transient: true });
	const r = await checkProposeGate(store, new PendingToolRegistry(), fakeClient(nodeWith("draft")), "s1", "propose_generation", { node_id: "n1" });
	assert.deepEqual(r, { allowed: true });
});

test("① latch 边界：用户下一条消息（turn bump）解锁，跨轮重提议放行", async () => {
	const store = new GenerationGateStore();
	store.markProposed("s1", "n1", { confirmed: true });
	store.bumpUserTurn("s1");
	const r = await checkProposeGate(store, new PendingToolRegistry(), fakeClient(nodeWith("pending_confirm")), "s1", "propose_generation", { node_id: "n1" });
	assert.deepEqual(r, { allowed: true });
});

test("② 在途：registry 中该节点有未结算 propose → 拦（settle 前窗口）", async () => {
	const store = new GenerationGateStore();
	const registry = new PendingToolRegistry();
	registry.waitForUser("canvas1", "callP", "propose_generation", 60_000, { nodeId: "n1" });
	try {
		const r = await checkProposeGate(store, registry, fakeClient(nodeWith("pending_confirm")), "s1", "propose_generation", { node_id: "n1" }, { canvasSessionId: "canvas1" });
		assert.equal(r.allowed, false);
		assert.equal(r.kind, "pending");
	} finally {
		registry.abortAll("canvas1");
	}
});

test("② 在途：其他节点的 pending 不误伤；ask_user 的 pending 不算 propose", async () => {
	const store = new GenerationGateStore();
	const registry = new PendingToolRegistry();
	registry.waitForUser("canvas1", "callP", "propose_generation", 60_000, { nodeId: "nOther" });
	registry.waitForUser("canvas1", "callA", "ask_user", 60_000, { nodeId: "n1" });
	try {
		const r = await checkProposeGate(store, registry, fakeClient(nodeWith("draft")), "s1", "propose_generation", { node_id: "n1" }, { canvasSessionId: "canvas1" });
		assert.deepEqual(r, { allowed: true });
	} finally {
		registry.abortAll("canvas1");
	}
});

test("③ SSOT：节点 generating / fallback_pending → 拦（重提议把 generating 盖回 pending_confirm 的事故形态）", async () => {
	for (const status of ["generating", "fallback_pending"]) {
		const r = await checkProposeGate(new GenerationGateStore(), new PendingToolRegistry(), fakeClient(nodeWith(status)), "s1", "propose_generation", { node_id: "n1" });
		assert.equal(r.allowed, false, `status=${status} 必须拦`);
		assert.equal(r.kind, "in_flight");
	}
});

test("③ SSOT：draft / pending_confirm / completed → 放行（合法提议/重提议）", async () => {
	for (const status of ["draft", "pending_confirm", "completed", "error"]) {
		const r = await checkProposeGate(new GenerationGateStore(), new PendingToolRegistry(), fakeClient(nodeWith(status)), "s1", "propose_generation", { node_id: "n1" });
		assert.deepEqual(r, { allowed: true }, `status=${status} 必须放行`);
	}
});

test("③ SSOT：get-node 404 → 放行（让 Nest proposeGeneration 给权威错误）", async () => {
	const err = Object.assign(new Error("nest /agent/internal/get-node http 404: 节点不存在"), { status: 404 });
	const r = await checkProposeGate(new GenerationGateStore(), new PendingToolRegistry(), fakeClient(null, { throwWith: err }), "s1", "propose_generation", { node_id: "n1" });
	assert.deepEqual(r, { allowed: true });
});

test("③ SSOT：其他错误 → fail-closed 拦（绝不放行未校验的重提议）", async () => {
	const r = await checkProposeGate(new GenerationGateStore(), new PendingToolRegistry(), fakeClient(null, { throwWith: new Error("boom") }), "s1", "propose_generation", { node_id: "n1" });
	assert.equal(r.allowed, false);
	assert.equal(r.kind, "ssot_unavailable");
});

// ── registerProposeGateHooks 接线 ────────────────────────────────────────

function stubHarness() {
	const handlers = new Map<string, (event: never) => Promise<unknown>>();
	const harness = {
		hooks: {
			on: (name: string, fn: never) => {
				handlers.set(name, fn as never);
			},
		},
	} as unknown as AgentHarness<LnkpiToolContext>;
	return { harness, handlers };
}

function stubMetrics() {
	const blocked: ProposeGateBlockKind[] = [];
	return {
		metrics: { observeProposeGateBlocked: (kind: ProposeGateBlockKind) => blocked.push(kind) },
		blocked,
	};
}

test("接线：latch 命中 → block 且打点；canvasSessionId 解析器现算（#74 同纪律）", async () => {
	const store = new GenerationGateStore();
	store.markProposed("s1", "n1", { confirmed: true });
	const registry = new PendingToolRegistry();
	const { metrics, blocked } = stubMetrics();
	const { harness, handlers } = stubHarness();
	registerProposeGateHooks(harness, {
		sessionKey: "s1",
		store,
		registry,
		client: fakeClient(nodeWith("draft")),
		canvasKey: () => "canvas1",
		metrics,
	});
	const beforeTool = handlers.get("before_tool")!;
	const out = (await beforeTool({
		toolName: "propose_generation",
		args: { node_id: "n1" },
	} as never)) as { block?: { reason?: string } };
	assert.ok(out?.block?.reason?.includes("不要再次 propose_generation"));
	assert.deepEqual(blocked, ["latch"]);
});

test("接线：kill switch off（PI_RUNTIME_PROPOSE_GATE=off）→ 零钩子注册，逐字节旧行为", () => {
	process.env.PI_RUNTIME_PROPOSE_GATE = "off";
	try {
		const { harness, handlers } = stubHarness();
		registerProposeGateHooks(harness, {
			sessionKey: "s1",
			store: new GenerationGateStore(),
			registry: new PendingToolRegistry(),
			client: fakeClient(null),
			canvasKey: "canvas1",
			metrics: stubMetrics().metrics,
		});
		assert.equal(handlers.size, 0, "off 时不得注册任何钩子");
	} finally {
		delete process.env.PI_RUNTIME_PROPOSE_GATE;
	}
});
