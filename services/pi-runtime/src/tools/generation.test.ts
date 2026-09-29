import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenerationTools } from "./generation.js";
import type { LnkpiToolContext } from "./types.js";

const tc: LnkpiToolContext = { sessionId: "s1", userId: "u1" };

/** 对齐 harness execute 六参签名（同 ui-command.test.ts 的调用方式）。 */
function run(tool: NonNullable<ReturnType<typeof createGenerationTools>[number]>, params: unknown) {
	return tool.execute!("tc1", params as never, () => {}, tc as never, {} as never, undefined as never);
}

function fakeClient() {
	const calls: Array<{ path: string; body: unknown }> = [];
	return {
		calls,
		post: async (path: string, body: unknown) => {
			calls.push({ path, body });
			return {
				status: "completed",
				url: "https://x/y.png",
				generationRecordId: "g1",
				actions: [{ type: "update_node", payload: { id: "n_1", data: { status: "completed" } } }],
			};
		},
	};
}

test("six gen/lifecycle tools registered with tiers", () => {
	const tools = createGenerationTools(fakeClient() as never);
	assert.deepEqual(
		tools.map((t) => t.name),
		[
			"run_image_generation",
			"run_video_generation",
			"run_text_generation",
			"run_prompt_generation",
			"run_audio_generation",
			"cancel_generation",
		],
	);
	assert.deepEqual(tools.map((t) => t.tier), ["gen", "gen", "gen", "gen", "gen", "lifecycle"]);
});

test("run_image_generation posts correct body and surfaces actions in details", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "run_image_generation")!;
	const res = await run(tool, { node_id: "n_1" });
	assert.deepEqual(client.calls, [
		{
			path: "/agent/internal/run-image-generation",
			body: { sessionId: "s1", userId: "u1", nodeId: "n_1" },
		},
	]);
	assert.equal((res.details as { actions: unknown[] }).actions.length, 1);
});

test("run_* fails closed without userId", async () => {
	const tool = createGenerationTools(fakeClient() as never).find(
		(t) => t.name === "run_image_generation",
	)!;
	await assert.rejects(
		() => tool.execute!("tc1", { node_id: "n_1" } as never, () => {}, { sessionId: "s1" } as never, {} as never, undefined as never),
		/userId/,
	);
});

test("cancel_generation requires at least one identifier", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "cancel_generation")!;
	await assert.rejects(
		() => tool.execute!("tc1", {} as never, () => {}, tc as never, {} as never, undefined as never),
		/generation_record_id or node_id/,
	);
	await run(tool, { node_id: "n_1" });
	assert.deepEqual(client.calls[0], {
		path: "/agent/internal/cancel-generation",
		body: { sessionId: "s1", userId: "u1", nodeId: "n_1" },
	});
});

test("cancel_generation forwards generationRecordId", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "cancel_generation")!;
	await run(tool, { generation_record_id: "g9" });
	assert.deepEqual(client.calls[0].body, { sessionId: "s1", userId: "u1", generationRecordId: "g9" });
});

test("non-array actions degrade to empty details.actions", async () => {
	const client = { post: async () => ({ status: "completed" }) };
	const tool = createGenerationTools(client as never).find((t) => t.name === "run_text_generation")!;
	const res = await run(tool, { node_id: "n_1" });
	assert.deepEqual((res.details as { actions: unknown[] }).actions, []);
});

test("P0-②：runTool 把 context.abortSignal 透传给 client.post 第三参", async () => {
	const posts: Array<{ opts?: { signal?: AbortSignal } }> = [];
	const fakeClient = {
		post: async (_path: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
			posts.push({ opts });
			return { actions: [] };
		},
	};
	const tools = createGenerationTools(fakeClient as never);
	const runTool = tools.find((t) => t.name === "run_image_generation")!;
	const controller = new AbortController();
	// 6 参签名：第 4 参 toolContext、第 6 参 context（P0-② abort 级联的数据源）
	await runTool.execute!(
		"call-1",
		{ node_id: "image-1" } as never,
		() => {},
		tc as never,
		{} as never,
		{ abortSignal: controller.signal } as never,
	);
	assert.equal(posts.length, 1);
	assert.equal(posts[0]!.opts?.signal, controller.signal);
});

test("P0-②：cancel_generation 同样透传 context.abortSignal", async () => {
	const posts: Array<{ opts?: { signal?: AbortSignal } }> = [];
	const fakeClient = {
		post: async (_path: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
			posts.push({ opts });
			return { actions: [] };
		},
	};
	const tools = createGenerationTools(fakeClient as never);
	const cancelTool = tools.find((t) => t.name === "cancel_generation")!;
	const controller = new AbortController();
	await cancelTool.execute!(
		"call-2",
		{ node_id: "image-1" } as never,
		() => {},
		tc as never,
		{} as never,
		{ abortSignal: controller.signal } as never,
	);
	assert.equal(posts[0]!.opts?.signal, controller.signal);
});

test("P0-②：context.abortSignal 缺省时（旧调用路径）不传 signal 也不报错", async () => {
	const posts: Array<{ opts?: { signal?: AbortSignal } }> = [];
	const fakeClient = {
		post: async (_path: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
			posts.push({ opts });
			return { actions: [] };
		},
	};
	const tools = createGenerationTools(fakeClient as never);
	const runTool = tools.find((t) => t.name === "run_image_generation")!;
	await runTool.execute!("call-3", { node_id: "image-1" } as never, () => {}, tc as never, {} as never, {
		abortSignal: undefined,
	} as never);
	assert.equal(posts[0]!.opts?.signal, undefined);
});
