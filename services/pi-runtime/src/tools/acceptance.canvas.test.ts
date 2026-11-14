import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createNestCanvasOracle,
	judgeCanvasAcceptance,
	parseAcceptance,
	type AcceptanceRequirement,
} from "./acceptance.js";
import { judgeCanvasCounts } from "../canvas-judge.js";

/** 从 parse 结果取出归一化需求（测试里断言具体形态）。 */
function requirement(value: unknown): AcceptanceRequirement {
	const r = parseAcceptance(value);
	assert.equal(r.ok, true, `parse 应通过：${JSON.stringify(value)}`);
	if (!r.ok) throw new Error("unreachable");
	return r.requirement;
}

// ── parseAcceptance：C-2b 合法形态 ────────────────────────────────────────
test("C-2b parse: canvas_state + nodeCount 合法", () => {
	assert.deepEqual(requirement({ kind: "canvas_state", canvasState: { nodeCount: { min: 1 } } }), {
		kind: "canvas_state",
		canvasState: { nodeCount: { min: 1 } },
	});
});

test("C-2b parse: canvas_state + nodeTypeCounts 合法（多余字段被重建剔除）", () => {
	assert.deepEqual(
		requirement({
			kind: "canvas_state",
			canvasState: { nodeTypeCounts: { image: { min: 1, max: 3 }, text: { max: 2 } } },
		}),
		{
			kind: "canvas_state",
			canvasState: { nodeTypeCounts: { image: { min: 1, max: 3 }, text: { max: 2 } } },
		},
	);
});

test("C-2b parse: generation 归一化结果不携带 kind 字段（C-2a 契约兼容；DSL 的 kind 仍必填）", () => {
	assert.deepEqual(requirement({ kind: "generation" }), {});
	assert.deepEqual(requirement({ kind: "generation", generation: { requireSucceeded: true } }), {
		requireSucceeded: true,
	});
});

// ── parseAcceptance：§14.4 防游戏化守卫 ─────────────────────────────────
test("C-2b parse: canvas_state 缺 canvasState / 空对象 ⇒ 非法（至少一谓词）", () => {
	const a = parseAcceptance({ kind: "canvas_state" });
	assert.equal(a.ok, false);
	const b = parseAcceptance({ kind: "canvas_state", canvasState: {} });
	assert.equal(b.ok, false);
	if (!b.ok) assert.match(b.reason, /至少给一个谓词/);
	const c = parseAcceptance({ kind: "canvas_state", canvasState: { nodeCount: {} } });
	assert.equal(c.ok, false);
});

test("C-2b parse: kind 与载荷不匹配 ⇒ 非法", () => {
	assert.equal(parseAcceptance({ kind: "generation", canvasState: { nodeCount: { min: 1 } } }).ok, false);
	assert.equal(parseAcceptance({ kind: "canvas_state", generation: { requireSucceeded: true } }).ok, false);
});

test("C-2b parse: 未知 kind / 自由文本 / 未知 type ⇒ 非法", () => {
	assert.equal(parseAcceptance({ kind: "user_confirm" }).ok, false);
	// ⭐ DSL 的 kind 始终必填：C-2b 重写 parse 后不得放宽成「缺省即 generation」
	assert.equal(parseAcceptance({ canvasState: { nodeCount: { min: 1 } } }).ok, false);
	assert.equal(parseAcceptance({ generation: { requireSucceeded: true } }).ok, false);
	assert.equal(parseAcceptance({ kind: "canvas_state", canvasState: { nodeCount: { min: 1 } }, note: "x" }).ok, false);
	assert.equal(parseAcceptance({ kind: "canvas_state", canvasState: { nodeTypeCounts: { shot: { min: 1 } } } }).ok, false);
	assert.equal(parseAcceptance({ kind: "canvas_state", canvasState: { noOverlap: true } }).ok, false);
});

test("C-2b parse: 区间守卫（min>max / 非有限数 / 未知字段）", () => {
	for (const nodeCount of [
		{ min: 5, max: 2 },
		{ min: "1" },
		{ max: Number.POSITIVE_INFINITY },
		{ min: 1, extra: 2 },
	]) {
		const r = parseAcceptance({ kind: "canvas_state", canvasState: { nodeCount } });
		assert.equal(r.ok, false, `nodeCount=${JSON.stringify(nodeCount)} 应非法`);
	}
});

test("C-2b parse: nodeTypeCounts 内区间非法同样被拦", () => {
	assert.equal(
		parseAcceptance({
			kind: "canvas_state",
			canvasState: { nodeTypeCounts: { image: { min: 9, max: 1 } } },
		}).ok,
		false,
	);
});

// ── judgeCanvasAcceptance：与 C-1 eval 同源 ──────────────────────────────
test("C-2b judge: 满足 ⇒ ok；证据差来自共享 judgeCanvasCounts", () => {
	assert.deepEqual(judgeCanvasAcceptance({ nodeCount: 3, typeCounts: { image: 2 } }, { nodeCount: { min: 1 } }), {
		ok: true,
	});
	const r = judgeCanvasAcceptance({ nodeCount: 0, typeCounts: {} }, { nodeCount: { min: 1 } });
	assert.equal(r.ok, false);
	if (!r.ok) {
		const [shared] = judgeCanvasCounts({ nodeCount: 0, typeCounts: {} }, { nodeCount: { min: 1 } });
		assert.ok(r.evidence.includes(shared), "生产证据差必须包含 eval 同源判据文案");
		assert.match(r.evidence, /画布节点数=0/);
	}
});

test("C-2b judge: nodeTypeCounts 不满足 ⇒ 证据差带实际值", () => {
	const r = judgeCanvasAcceptance({ nodeCount: 2, typeCounts: { text: 2 } }, {
		nodeTypeCounts: { image: { min: 1 } },
	});
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.evidence, /image 节点数 0/);
});

// ── createNestCanvasOracle ───────────────────────────────────────────────
test("C-2b oracle: 节点按 type 计数，未知 type 保留原值键", async () => {
	const r = await createNestCanvasOracle({
		post: async () => ({
			nodes: [
				{ id: "n1", type: "image" },
				{ id: "n2", type: "image" },
				{ id: "n3", type: "shot" },
			],
		}),
	}).inspect({ sessionId: "s" });
	assert.deepEqual(r, {
		ok: true,
		canvas: { nodeCount: 3, typeCounts: { image: 2, shot: 1 } },
	});
});

test("C-2b oracle: ⭐ body 恰为 {sessionId}（不传 focusNodeId ⇒ 全量 SSOT）", async () => {
	let seen: unknown;
	let path = "";
	await createNestCanvasOracle({
		post: async (p: string, body: unknown) => {
			path = p;
			seen = body;
			return { nodes: [] };
		},
	}).inspect({ sessionId: "sess-1" });
	assert.equal(path, "/agent/internal/get-canvas-summary");
	assert.deepEqual(seen, { sessionId: "sess-1" });
});

test("C-2b oracle: 空画布 ⇒ ok:true + nodeCount 0（判据失败，非故障）", async () => {
	assert.deepEqual(
		await createNestCanvasOracle({ post: async () => ({ nodes: [] }) }).inspect({ sessionId: "s" }),
		{ ok: true, canvas: { nodeCount: 0, typeCounts: {} } },
	);
});

test("C-2b oracle: nodes 非数组 / type 缺失或非字符串 ⇒ ok:false（fail-open 输入）", async () => {
	for (const data of [{ nodes: "oops" }, { nodes: [{ id: "n" }] }, { nodes: [{ type: 123 }] }]) {
		const r = await createNestCanvasOracle({ post: async () => data }).inspect({ sessionId: "s" });
		assert.equal(r.ok, false, `data=${JSON.stringify(data)} 应归 fail-open`);
	}
});

test("C-2b oracle: client 抛错（http/timeout/熔断）⇒ ok:false 带 reason", async () => {
	const r = await createNestCanvasOracle({
		post: async () => {
			throw new Error("NestToolError: timeout");
		},
	}).inspect({ sessionId: "s" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /timeout/);
});
