import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenerationTools } from "./generation.js";
import type { LnkpiToolContext } from "./types.js";

const tc: LnkpiToolContext = { sessionId: "s1", userId: "u1" };

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
	const res = await tool.execute!("id", { node_id: "n_1" }, undefined, tc);
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
		() => tool.execute!("id", { node_id: "n_1" }, undefined, { sessionId: "s1" }),
		/userId/,
	);
});

test("cancel_generation requires at least one identifier", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "cancel_generation")!;
	await assert.rejects(() => tool.execute!("id", {}, undefined, tc), /generation_record_id or node_id/);
	await tool.execute!("id", { node_id: "n_1" }, undefined, tc);
	assert.deepEqual(client.calls[0], {
		path: "/agent/internal/cancel-generation",
		body: { sessionId: "s1", userId: "u1", nodeId: "n_1" },
	});
});

test("cancel_generation forwards generationRecordId", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "cancel_generation")!;
	await tool.execute!("id", { generation_record_id: "g9" }, undefined, tc);
	assert.deepEqual(client.calls[0].body, { sessionId: "s1", userId: "u1", generationRecordId: "g9" });
});

test("non-array actions degrade to empty details.actions", async () => {
	const client = { post: async () => ({ status: "completed" }) };
	const tool = createGenerationTools(client as never).find((t) => t.name === "run_text_generation")!;
	const res = await tool.execute!("id", { node_id: "n_1" }, undefined, tc);
	assert.deepEqual((res.details as { actions: unknown[] }).actions, []);
});
