import { test } from "node:test";
import assert from "node:assert/strict";
import type { LnkpiToolContext } from "./types.js";
import { buildCanvasReadTools } from "./registry.js";

const EXPECTED = new Set([
	"get_canvas_summary",
	"get_node",
	"get_generation_status",
	"get_generation_diagnostic",
	"get_canvas_layout",
	"list_generation_tasks",
	"list_user_assets",
]);

function fakeClient() {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	return {
		calls,
		post: async (path: string, body: unknown) => {
			calls.push({ path, body: body as Record<string, unknown> });
			return { ok: true };
		},
	};
}

const ctx = (sessionId: string, userId?: string): LnkpiToolContext => ({ sessionId, userId });

// 与真实 execute 签名对齐的调用助手（AgentHarnessTool.execute 共 6 参）
function call(
	tool: ReturnType<typeof buildCanvasReadTools>[number],
	params: unknown,
	context: LnkpiToolContext,
) {
	return tool.execute("call-1", params as never, () => {}, context, {} as never, undefined as never);
}

test("注册 7 个 read 工具且 tier 正确", () => {
	const tools = buildCanvasReadTools(fakeClient() as never);
	assert.equal(tools.length, 7);
	assert.deepEqual(new Set(tools.map((t) => t.name)), EXPECTED);
	assert.ok(tools.every((t) => t.tier === "read"));
});

test("get_node 映射 snake_case 入参到 camelCase body 并带 sessionId", async () => {
	const fake = fakeClient();
	const [tool] = buildCanvasReadTools(fake as never).filter((t) => t.name === "get_node");
	const res = await call(tool!, { node_id: "n1" }, ctx("s1"));
	assert.deepEqual(fake.calls[0], { path: "/agent/internal/get-node", body: { sessionId: "s1", nodeId: "n1" } });
	assert.match((res.content[0] as { text: string }).text, /"ok":true/);
});

test("双会话并发调用不串号（toolContext 各自带 sessionId）", async () => {
	const fake = fakeClient();
	const [tool] = buildCanvasReadTools(fake as never).filter((t) => t.name === "get_canvas_summary");
	await Promise.all([
		call(tool!, {}, ctx("sess-A")),
		call(tool!, {}, ctx("sess-B")),
	]);
	assert.deepEqual(
		fake.calls.map((c) => (c.body as { sessionId: string }).sessionId).sort(),
		["sess-A", "sess-B"],
	);
});

test("list_generation_tasks：userId 存在才带上；type 透传", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	const t = tools.find((x) => x.name === "list_generation_tasks")!;
	await call(t!, { type: "image" }, ctx("s1", "u1"));
	await call(t!, {}, ctx("s1"));
	assert.deepEqual(fake.calls[0].body, { sessionId: "s1", userId: "u1", type: "image" });
	assert.deepEqual(fake.calls[1].body, { sessionId: "s1" });
});

test("list_user_assets：无会话但有 userId；get_canvas_summary 无参", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	await call(tools.find((x) => x.name === "list_user_assets")!, {}, ctx("s1", "u9"));
	await call(tools.find((x) => x.name === "get_canvas_summary")!, {}, ctx("s1"));
	assert.deepEqual(fake.calls[0], { path: "/agent/internal/list-user-assets", body: { userId: "u9" } });
	assert.deepEqual(fake.calls[1], { path: "/agent/internal/get-canvas-summary", body: { sessionId: "s1" } });
});

test("get_generation_diagnostic：两个可选 id 至少一个，否则抛错（不打 Nest）", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	const t = tools.find((x) => x.name === "get_generation_diagnostic")!;
	await call(t!, { node_id: "n1" }, ctx("s1"));
	assert.deepEqual(fake.calls[0].body, { sessionId: "s1", nodeId: "n1" });
	await assert.rejects(
		() => call(t!, {}, ctx("s1")),
		/generation_record_id|node_id/,
	);
	assert.equal(fake.calls.length, 1);
});
