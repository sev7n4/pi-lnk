import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeleteNodesTools, DELETE_NODES_MAX } from "./delete-nodes.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

// harness execute 类型是 6 参；测试只关心前 4 个语义位，尾部两个以 never 垫齐。
type ToolResult = { content: { text: string }[] };
function runTool(tool: LnkpiTool, params: unknown, tc: unknown = {}): Promise<ToolResult> {
	return tool.execute!("1", params as never, undefined as never, tc as never, undefined as never, undefined as never) as Promise<ToolResult>;
}

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
	const out = await runTool(tool, { node_ids: ["n1", "n2"] }, tc);
	assert.equal(capture.path, "/agent/internal/remove-nodes");
	assert.deepEqual(capture.body, { sessionId: "sess-1", nodeIds: ["n1", "n2"] });
	assert.ok(out.content[0].text.includes("removedNodes"));
});

test("delete_nodes：超过上限 → execute 内兜底拒绝（Review#4）", async () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	const tooMany = Array.from({ length: DELETE_NODES_MAX + 1 }, (_, i) => "n" + i);
	await assert.rejects(() => runTool(tool, { node_ids: tooMany }, tc), /at most 50/);
});

test("delete_nodes：空数组 → 拒绝", async () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	await assert.rejects(() => runTool(tool, { node_ids: [] }, tc), /requires node_ids/);
});

test("delete_nodes：toolContext 缺 sessionId → fail-closed 拒绝（终审 M-1）", async () => {
	const capture: { path?: string; body?: unknown } = {};
	const [tool] = buildDeleteNodesTools(fakeClient(capture));
	await assert.rejects(() => runTool(tool, { node_ids: ["n1"] }, {} as LnkpiToolContext), /missing sessionId/);
	assert.equal(capture.path, undefined, "must not reach Nest without sessionId");
});
