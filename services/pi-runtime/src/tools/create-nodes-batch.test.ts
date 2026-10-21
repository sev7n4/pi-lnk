/** SP-A create_nodes_batch 契约测试：toolContext 安全模型、驼峰映射、上限 fail-closed、actions 通道。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvasWriteTools } from "./canvas-write.js";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

type Recorded = { path: string; body: Record<string, unknown> };

function makeClient(calls: Recorded[]) {
	return {
		post: async (path: string, body: Record<string, unknown>) => {
			calls.push({ path, body });
			return { nodes: [{ key: "a", nodeId: "image-1" }], actions: [] };
		},
	};
}

const CTX = { sessionId: "sess-1", userId: "u1" } as LnkpiToolContext;

function findTool(name: string): LnkpiTool {
	const tools = createCanvasWriteTools(makeClient([]) as never);
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `tool ${name} not registered`);
	return tool;
}

test("create_nodes_batch：schema 不暴露 sessionId/userId（toolContext 安全模型锁）", () => {
	const tool = findTool("create_nodes_batch");
	const schema = JSON.stringify(tool.parameters);
	assert.ok(!schema.includes("sessionId"), "sessionId must not be model-visible");
	assert.ok(!schema.includes("userId"), "userId must not be model-visible");
	assert.equal(tool.tier, "graph_batch");
});

test("create_nodes_batch：items驼峰映射 + edges 透传，sessionId 只取 toolContext", async () => {
	const calls: Recorded[] = [];
	const tools = createCanvasWriteTools(makeClient(calls) as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	await tool.execute!(
		"1",
		{
			items: [
				{ key: "a", type: "image", prompt: "一只猫", title: "猫" },
				{ key: "b", type: "video", prompt: "猫在跑" },
			],
			edges: [{ source: "a", target: "b" }],
		} as never,
		undefined as never,
		CTX,
		undefined as never,
		undefined as never,
	);
	assert.equal(calls[0]!.path, "/agent/internal/add-nodes-batch");
	const body = calls[0]!.body;
	assert.equal(body.sessionId, "sess-1");
	assert.equal(body.userId, "u1");
	assert.equal((body.items as unknown[]).length, 2);
	assert.equal((body.items as Array<{ targetType: string }>)[0]!.targetType, "image");
	assert.equal((body.items as Array<{ title: string }>)[1]!.title, "猫在跑", "缺 title 时回落 prompt");
	assert.deepEqual(body.edges, [{ source: "a", target: "b" }]);
});

test("create_nodes_batch：13 个节点 → execute 内兜底拒绝（Review#3）", async () => {
	const tool = findTool("create_nodes_batch");
	const items = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, type: "image", prompt: "p" }));
	await assert.rejects(
		() => tool.execute!("1", { items } as never, undefined as never, CTX, undefined as never, undefined as never),
		/at most 12 nodes per call \(got 13\)/,
	);
});

test("create_nodes_batch：21 条边 → 拒绝", async () => {
	const tool = findTool("create_nodes_batch");
	const edges = Array.from({ length: 21 }, (_, i) => ({ source: `k${i}`, target: `k${i + 1}` }));
	await assert.rejects(
		() =>
			tool.execute!(
				"1",
				{ items: [{ key: "k0", type: "image", prompt: "p" }], edges } as never,
				undefined as never,
				CTX,
				undefined as never,
				undefined as never,
			),
		/at most 20 edges/,
	);
});

test("create_nodes_batch：空 items → 拒绝", async () => {
	const tool = findTool("create_nodes_batch");
	await assert.rejects(
		() => tool.execute!("1", { items: [] } as never, undefined as never, CTX, undefined as never, undefined as never),
		/requires at least one item/,
	);
});

test("create_nodes_batch：已下线类型 → 工具层拒绝且不达 Nest（防类型复活）", async () => {
	const calls: Recorded[] = [];
	const tools = createCanvasWriteTools(makeClient(calls) as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	// NodeType 已收敛为 4 项；prompt/group/shot/sceneComposer/mediaInput 均为已下线类型。
	for (const dead of ["prompt", "group", "shot", "sceneComposer", "mediaInput"]) {
		await assert.rejects(
			() =>
				tool.execute!(
					"1",
					{ items: [{ key: "a", type: dead, prompt: "p" }] } as never,
					undefined as never,
					CTX,
					undefined as never,
					undefined as never,
				),
			/unsupported node type/,
			`type ${dead} must be rejected`,
		);
	}
	assert.equal(calls.length, 0, "must not reach Nest with a decommissioned node type");
});

test("create_nodes_batch：4 项白名单类型 → 放行", async () => {
	const calls: Recorded[] = [];
	const tools = createCanvasWriteTools(makeClient(calls) as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	await tool.execute!(
		"1",
		{
			items: [
				{ key: "a", type: "image", prompt: "p" },
				{ key: "b", type: "video", prompt: "p" },
				{ key: "c", type: "audio", prompt: "p" },
				{ key: "d", type: "text", prompt: "p" },
			],
		} as never,
		undefined as never,
		CTX,
		undefined as never,
		undefined as never,
	);
	assert.equal(calls.length, 1);
});

test("create_nodes_batch：toolContext 缺 sessionId → fail-closed（不达 Nest）", async () => {
	const calls: Recorded[] = [];
	const tools = createCanvasWriteTools(makeClient(calls) as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	await assert.rejects(
		() =>
			tool.execute!(
				"1",
				{ items: [{ key: "a", type: "image", prompt: "p" }] } as never,
				undefined as never,
				{} as LnkpiToolContext,
				undefined as never,
				undefined as never,
			),
		/missing sessionId/,
	);
	assert.equal(calls.length, 0, "must not reach Nest without sessionId");
});

test("create_nodes_batch：Nest 返回的 actions 进 details.actions（canvas_action SSE 通道）", async () => {
	const tools = createCanvasWriteTools(
		{
			post: async () => ({
				nodes: [{ key: "a", nodeId: "image-1" }],
				actions: [{ type: "add_node", payload: { id: "image-1" } }],
			}),
		} as never,
	);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	const out = (await tool.execute!(
		"1",
		{ items: [{ key: "a", type: "image", prompt: "p" }] } as never,
		undefined as never,
		CTX,
		undefined as never,
		undefined as never,
	)) as { details: { actions: unknown[]; affectedCount: number } };
	assert.equal(out.details.actions.length, 1);
	assert.equal(out.details.affectedCount, 1, "affectedCount 按请求语义计数（节点数），非 actions.length");
});