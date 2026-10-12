import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REMOVE_EDGES_MAX, buildRemoveEdgesTools } from "./remove-edges.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiToolContext } from "./types.js";

const CTX: LnkpiToolContext = { sessionId: "s1", userId: "u1" };

function makeClient(payload: unknown = { actions: [] }) {
	const calls: { path: string; body: unknown }[] = [];
	return {
		calls,
		client: {
			post: async (path: string, body: unknown) => {
				calls.push({ path, body });
				return payload;
			},
		} as unknown as NestClient,
	};
}

const run = (tool: ReturnType<typeof buildRemoveEdgesTools>[number], params: unknown, ctx = CTX) =>
	tool.execute("1", params as never, undefined as never, ctx as never, undefined as never, undefined as never);

describe("remove_edges（spec S4）", () => {
	it("tier=write_light；sessionId 不进 schema；body 带 userId 与 camelCase edgeIds", async () => {
		const { client, calls } = makeClient();
		const [tool] = buildRemoveEdgesTools(client);
		assert.equal(tool.tier, "write_light");
		assert.ok(!JSON.stringify(tool.parameters).includes("sessionId"));
		await run(tool, { edge_ids: ["e1", "e2"] });
		assert.equal(calls[0].path, "/agent/internal/remove-edges");
		assert.deepEqual(calls[0].body, { sessionId: "s1", userId: "u1", edgeIds: ["e1", "e2"] });
	});

	it("超过上限 → execute 内兜底拒绝", async () => {
		const { client, calls } = makeClient();
		const [tool] = buildRemoveEdgesTools(client);
		const tooMany = Array.from({ length: REMOVE_EDGES_MAX + 1 }, (_, i) => `e${i}`);
		await assert.rejects(() => run(tool, { edge_ids: tooMany }), /at most 20/);
		assert.equal(calls.length, 0);
	});

	it("空数组 → 拒绝；缺 userId → fail-closed 不打 Nest", async () => {
		const { client, calls } = makeClient();
		const [tool] = buildRemoveEdgesTools(client);
		await assert.rejects(() => run(tool, { edge_ids: [] }), /requires edge_ids/);
		await assert.rejects(() => run(tool, { edge_ids: ["e1"] }, { sessionId: "s1" }), /requires userId/);
		assert.equal(calls.length, 0);
	});

	it("Nest 的 actions 进 details.actions（实时删边）", async () => {
		const { client } = makeClient({ actions: [{ type: "remove_edge", payload: { id: "e1" } }] });
		const [tool] = buildRemoveEdgesTools(client);
		const out = (await run(tool, { edge_ids: ["e1"] })) as { details?: { actions?: unknown[] } };
		assert.deepEqual(out.details?.actions, [{ type: "remove_edge", payload: { id: "e1" } }]);
	});
});

// ---- Task 3：affectedCount 直报（spec 2026-10-12 §2.1/§2.2）----

describe("remove_edges: _signal + affectedCount", () => {
	it("部分生效：请求 2 条、Nest skip 1 条 → affectedCount=1（对账判据前置）", async () => {
		const { client } = makeClient({
			actions: [
				{ type: "remove_edge", payload: { id: "e1" } },
			],
		});
		const [tool] = buildRemoveEdgesTools(client);
		const out = await run(tool, { edge_ids: ["e1", "e-gone"] });
		const d = out.details as Record<string, unknown>;
		assert.equal(d.affectedCount, 1);
		assert.equal((d._signal as { status: string }).status, "ok");
	});
});
