import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createNestGenerationOracle,
	isAcceptanceEnabled,
	judgeGenerationAcceptance,
	parseAcceptance,
	type GenerationLatest,
} from "./acceptance.js";

const succeeded: GenerationLatest = { id: "gen-1", status: "succeeded" };

test("judge: succeeded 级 + 最新 succeeded ⇒ 通过", () => {
	assert.deepEqual(judgeGenerationAcceptance(succeeded, { requireSucceeded: true }), { ok: true });
});

test("judge: succeeded 级 + 最新 failed ⇒ 拒绝且证据差带 status/id", () => {
	const r = judgeGenerationAcceptance({ id: "gen-2", status: "failed" }, { requireSucceeded: true });
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.match(r.evidence, /status=failed/);
		assert.match(r.evidence, /gen-2/);
	}
});

test("judge: succeeded 级 + 最新 timeout/running/自由字符串 ⇒ 拒绝", () => {
	for (const status of ["timeout", "running", "queued", "draft", "SUCCEEDED"]) {
		const r = judgeGenerationAcceptance({ id: "g", status }, { requireSucceeded: true });
		assert.equal(r.ok, false, `status=${status} 不得放行`);
	}
});

test("judge: succeeded 级 + 无生成记录 ⇒ 拒绝", () => {
	const r = judgeGenerationAcceptance(undefined, { requireSucceeded: true });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.evidence, /无生成记录/);
});

test("judge: submitted 级（缺省）+ 任意状态记录 ⇒ 通过", () => {
	for (const status of ["queued", "running", "failed", "succeeded"]) {
		assert.deepEqual(judgeGenerationAcceptance({ id: "g", status }, {}), { ok: true });
	}
});

test("judge: submitted 级 + 无记录 ⇒ 拒绝", () => {
	assert.equal(judgeGenerationAcceptance(undefined, {}).ok, false);
});

test("judge: 显式 requireSucceeded:false 归 submitted 级", () => {
	assert.deepEqual(
		judgeGenerationAcceptance({ id: "g", status: "failed" }, { requireSucceeded: false }),
		{ ok: true },
	);
});

test("parse: 合法形态（缺省/显式 true/显式 false）", () => {
	assert.deepEqual(parseAcceptance({ kind: "generation" }), { ok: true, requirement: {} });
	assert.deepEqual(parseAcceptance({ kind: "generation", generation: { requireSucceeded: true } }), {
		ok: true,
		requirement: { requireSucceeded: true },
	});
	assert.deepEqual(parseAcceptance({ kind: "generation", generation: {} }), {
		ok: true,
		requirement: {},
	});
});

test("parse: kind 缺失/未知 ⇒ 非法（枚举封死）", () => {
	assert.equal(parseAcceptance({ generation: {} }).ok, false);
	assert.equal(parseAcceptance({ kind: "canvas_state", canvasState: {} }).ok, false);
	assert.equal(parseAcceptance({ kind: "user_confirm" }).ok, false);
	assert.equal(parseAcceptance(null).ok, false);
});

test("parse: 自由文本字段禁入（note / 生成内未知字段）", () => {
	const note = parseAcceptance({ kind: "generation", note: "看起来不错" });
	assert.equal(note.ok, false);
	if (!note.ok) assert.match(note.reason, /note/);
	const extra = parseAcceptance({ kind: "generation", generation: { requireSucceeded: true, note: "x" } });
	assert.equal(extra.ok, false);
});

test("parse: requireSucceeded 非 boolean / generation 非对象 ⇒ 非法", () => {
	assert.equal(parseAcceptance({ kind: "generation", generation: { requireSucceeded: "true" } }).ok, false);
	assert.equal(parseAcceptance({ kind: "generation", generation: "yes" }).ok, false);
});

test("oracle: 首项即最新，status 自由字符串原样带回", async () => {
	const client = {
		post: async () => ({
			tasks: [
				{ id: "g-new", status: "failed", createdAt: "2026-11-14T00:00:00Z" },
				{ id: "g-old", status: "succeeded", createdAt: "2026-11-13T00:00:00Z" },
			],
		}),
	};
	const r = await createNestGenerationOracle(client).inspect({ sessionId: "s", userId: "u" });
	assert.deepEqual(r, {
		ok: true,
		latest: { id: "g-new", status: "failed", createdAt: "2026-11-14T00:00:00Z" },
	});
});

test("oracle: 空数组 ⇒ ok:true + 无 latest（判据不满足，非故障）", async () => {
	const r = await createNestGenerationOracle({ post: async () => ({ tasks: [] }) }).inspect({
		sessionId: "s",
		userId: "u",
	});
	assert.deepEqual(r, { ok: true });
});

test("oracle: 恰好 50 条（trimData 不截断）仍取首项", async () => {
	const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `g-${i}`, status: "succeeded" }));
	const r = await createNestGenerationOracle({ post: async () => ({ tasks }) }).inspect({
		sessionId: "s",
		userId: "u",
	});
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.latest?.id, "g-0");
});

test("oracle: tasks 非数组 / status 非字符串 ⇒ ok:false（fail-open 输入）", async () => {
	const bad1 = await createNestGenerationOracle({ post: async () => ({ tasks: "oops" }) }).inspect({
		sessionId: "s",
		userId: "u",
	});
	assert.equal(bad1.ok, false);
	const bad2 = await createNestGenerationOracle({
		post: async () => ({ tasks: [{ id: "g", status: 123 }] }),
	}).inspect({ sessionId: "s", userId: "u" });
	assert.equal(bad2.ok, false);
});

test("oracle: client 抛错（http/timeout/熔断）⇒ ok:false 带 reason", async () => {
	const r = await createNestGenerationOracle({
		post: async () => {
			throw new Error("NestToolError: timeout");
		},
	}).inspect({ sessionId: "s", userId: "u" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /timeout/);
});

test("oracle: 请求 body 带 sessionId + userId", async () => {
	let seen: unknown;
	await createNestGenerationOracle({
		post: async (_path: string, body: unknown) => {
			seen = body;
			return { tasks: [] };
		},
	}).inspect({ sessionId: "sess-1", userId: "user-1" });
	assert.deepEqual(seen, { sessionId: "sess-1", userId: "user-1" });
});

test("kill switch: PI_RUNTIME_ACCEPTANCE=off ⇒ 关闭，其余开启", () => {
	const prev = process.env.PI_RUNTIME_ACCEPTANCE;
	try {
		delete process.env.PI_RUNTIME_ACCEPTANCE;
		assert.equal(isAcceptanceEnabled(), true);
		process.env.PI_RUNTIME_ACCEPTANCE = "off";
		assert.equal(isAcceptanceEnabled(), false);
	} finally {
		if (prev === undefined) delete process.env.PI_RUNTIME_ACCEPTANCE;
		else process.env.PI_RUNTIME_ACCEPTANCE = prev;
	}
});
