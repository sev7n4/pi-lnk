import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeleteNodesTools, DELETE_NODES_MAX } from "./delete-nodes.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiToolContext } from "./types.js";

function fakeClient(capture: { path?: string; body?: unknown } = {}): NestClient {
	return {
		post: async (path: string, body: unknown) => {
			capture.path = path;
			capture.body = body;
			return { removedNodes: 2, removedEdges: 3 };
		},
	} as unknown as NestClient;
}

const tc = { sessionId: "sess-1", userId: "u1" } as LnkpiToolContext;

test("delete_nodes：schema 不暴露 sessionId（toolContext 安全模型锁）", () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	const schema = JSON.stringify(tool.parameters);
	assert.ok(!schema.includes("sessionId"), "sessionId must not be a model-visible parameter");
	assert.equal(tool.tier, "destructive");
});

test("delete_nodes：sessionId 只取 toolContext，nodeIds 驼峰透传", async () => {
	const capture: { path?: string; body?: unknown } = {};
	const [tool] = buildDeleteNodesTools(fakeClient(capture));
	const out = await tool.execute!("1", { node_ids: ["n1", "n2"] }, undefined as never, tc);
	assert.equal(capture.path, "/agent/internal/remove-nodes");
	assert.deepEqual(capture.body, { sessionId: "sess-1", nodeIds: ["n1", "n2"] });
	assert.ok(out.content[0].text.includes("removedNodes"));
});

test("delete_nodes：超过上限 → execute 内兜底拒绝（Review#4）", async () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	const tooMany = Array.from({ length: DELETE_NODES_MAX + 1 }, (_, i) => "n" + i);
	await assert.rejects(() => tool.execute!("1", { node_ids: tooMany }, undefined as never, tc), /at most 50/);
});

test("delete_nodes：空数组 → 拒绝", async () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	await assert.rejects(() => tool.execute!("1", { node_ids: [] }, undefined as never, tc), /requires node_ids/);
});
