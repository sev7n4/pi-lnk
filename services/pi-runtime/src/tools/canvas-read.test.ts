import { test, describe, it } from "node:test";
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
	"list_model_options",
	"list_generation_scenes",
]);

/** @param data 每次 post 的返回值（缺省 {ok:true}，需要断言出参形状时传入）。 */
function fakeClient(data: unknown = { ok: true }) {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	return {
		calls,
		post: async (path: string, body: unknown) => {
			calls.push({ path, body: body as Record<string, unknown> });
			return data;
		},
	};
}

const ctx = (sessionId: string, userId?: string): LnkpiToolContext => ({ sessionId, userId });
const CTX = ctx("s1", "u1");

// 与真实 execute 签名对齐的调用助手（AgentHarnessTool.execute 共 6 参）
function call(
	tool: ReturnType<typeof buildCanvasReadTools>[number],
	params: unknown,
	context: LnkpiToolContext,
) {
	return tool.execute("call-1", params as never, () => {}, context, {} as never, undefined as never);
}

test("注册 9 个 read 工具且 tier 正确", () => {
	const tools = buildCanvasReadTools(fakeClient() as never);
	assert.equal(tools.length, 9);
	assert.deepEqual(new Set(tools.map((t) => t.name)), EXPECTED);
	assert.ok(tools.every((t) => t.tier === "read"));
});

test("get_canvas_layout description 声明含 edges 并引导 remove_edges（Task 5 契约）", () => {
	const tools = buildCanvasReadTools(fakeClient() as never);
	const layout = tools.find((x) => x.name === "get_canvas_layout")!;
	const desc = layout.description ?? "";
	assert.match(desc, /edges/, "布局描述必须声明返回 edges");
	assert.match(desc, /remove_edges/, "布局描述必须引导用 remove_edges 删除边");
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

test("list_generation_tasks：必带 userId；type 透传", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	const t = tools.find((x) => x.name === "list_generation_tasks")!;
	await call(t!, { type: "image" }, ctx("s1", "u1"));
	await assert.rejects(() => call(t!, {}, ctx("s1")), /userId/, "缺 userId 不得打 Nest");
	assert.deepEqual(fake.calls[0].body, { sessionId: "s1", userId: "u1", type: "image" });
	assert.equal(fake.calls.length, 1);
});

test("list_user_assets：仅 userId（必带）；get_canvas_summary 无参", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	await call(tools.find((x) => x.name === "list_user_assets")!, {}, ctx("s1", "u9"));
	await assert.rejects(
		() => call(tools.find((x) => x.name === "list_user_assets")!, {}, ctx("s1")),
		/userId/,
	);
	await call(tools.find((x) => x.name === "get_canvas_summary")!, {}, ctx("s1"));
	assert.deepEqual(fake.calls[0], { path: "/agent/internal/list-user-assets", body: { userId: "u9" } });
	assert.deepEqual(fake.calls[1], { path: "/agent/internal/get-canvas-summary", body: { sessionId: "s1" } });
});

test("get_generation_diagnostic：必带 userId 且两个可选 id 至少一个，否则抛错（不打 Nest）", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	const t = tools.find((x) => x.name === "get_generation_diagnostic")!;
	await call(t!, { node_id: "n1" }, ctx("s1", "u1"));
	assert.deepEqual(fake.calls[0].body, { sessionId: "s1", userId: "u1", nodeId: "n1" });
	await assert.rejects(() => call(t!, {}, ctx("s1", "u1")), /generation_record_id|node_id/);
	await assert.rejects(() => call(t!, { node_id: "n1" }, ctx("s1")), /userId/);
	assert.equal(fake.calls.length, 1);
});

describe("list_model_options（spec S3）", () => {
	const MODALITIES = { image: [{ ref: "platform::image2", source: "platform" }], video: [], text: [], audio: [] };

	it("tier=read；body 只带 userId；不暴露 sessionId", async () => {
		const fake = fakeClient({ modalities: MODALITIES });
		const tool = buildCanvasReadTools(fake as never).find((t) => t.name === "list_model_options")!;
		assert.equal(tool.tier, "read");
		assert.ok(!JSON.stringify(tool.parameters).includes("sessionId"));
		await call(tool!, {}, CTX);
		assert.equal(fake.calls[0].path, "/agent/internal/list-model-options");
		assert.deepEqual(fake.calls[0].body, { userId: "u1" });
	});

	it("modality 过滤在客户端做（不打第二次 Nest）", async () => {
		const fake = fakeClient({ modalities: MODALITIES });
		const tool = buildCanvasReadTools(fake as never).find((t) => t.name === "list_model_options")!;
		const res = await call(tool!, { modality: "image" }, CTX);
		assert.equal(fake.calls.length, 1);
		const out = JSON.parse((res.content[0] as { text: string }).text).data;
		assert.deepEqual(Object.keys(out), ["image"]);
	});

	it("未知 modality 不过滤成空（回落全量，避免模型写出幻觉模态时拿不到候选）", async () => {
		const fake = fakeClient({ modalities: MODALITIES });
		const tool = buildCanvasReadTools(fake as never).find((t) => t.name === "list_model_options")!;
		const res = await call(tool!, { modality: "hologram" }, CTX);
		const out = JSON.parse((res.content[0] as { text: string }).text).data;
		assert.deepEqual(Object.keys(out).sort(), ["audio", "image", "text", "video"]);
	});

	it("缺 userId → fail-closed，不打 Nest", async () => {
		const fake = fakeClient({ modalities: MODALITIES });
		const tool = buildCanvasReadTools(fake as never).find((t) => t.name === "list_model_options")!;
		await assert.rejects(() => call(tool!, {}, ctx("s1")), /requires userId/);
		assert.equal(fake.calls.length, 0);
	});
});

describe("list_generation_scenes（2026-10-03 场景清单）", () => {
	const SCENES = {
		scenes: [
			{
				id: "ecom_xiaohongshu",
				label: "小红书种草",
				modality: "image",
				group: "ecom_platform",
				description: "竖版 3:4 · 1K · x2",
				preferredParams: { aspectRatio: "3:4", resolution: "1K", count: 2 },
			},
		],
	};

	it("tier=read；body 只带 userId；不暴露 sessionId", async () => {
		const fake = fakeClient(SCENES);
		const tool = buildCanvasReadTools(fake as never).find((t) => t.name === "list_generation_scenes")!;
		assert.equal(tool.tier, "read");
		assert.ok(!JSON.stringify(tool.parameters).includes("sessionId"));
		await call(tool, {}, CTX);
		assert.equal(fake.calls[0].path, "/agent/internal/list-generation-scenes");
		assert.deepEqual(fake.calls[0].body, { userId: "u1" });
	});

	it("modality / scene_id 透传给 Nest（过滤在 Nest 侧做，SSOT 在 shared）", async () => {
		const fake = fakeClient(SCENES);
		const tool = buildCanvasReadTools(fake as never).find((t) => t.name === "list_generation_scenes")!;
		await call(tool, { modality: "image" }, CTX);
		assert.deepEqual(fake.calls[0].body, { userId: "u1", modality: "image" });
		await call(tool, { scene_id: " ecom_xiaohongshu " }, CTX);
		assert.deepEqual(fake.calls[1].body, { userId: "u1", sceneId: "ecom_xiaohongshu" });
	});

	it("缺 userId → fail-closed，不打 Nest", async () => {
		const fake = fakeClient(SCENES);
		const tool = buildCanvasReadTools(fake as never).find((t) => t.name === "list_generation_scenes")!;
		await assert.rejects(() => call(tool, {}, ctx("s1")), /requires userId/);
		assert.equal(fake.calls.length, 0);
	});
});

describe("读工具结果瘦身（③ trimData/slimLayout）", () => {
	function makeDataClient(data: unknown) {
		return {
			post: async () => data,
		} as never;
	}

	function parse(res: unknown) {
		const content = (res as { content: Array<{ text: string }> }).content;
		return JSON.parse(content[0].text).data;
	}

	it("get_canvas_summary：>50 节点截断并附 nodes_total/truncated；≤50 原样无附加键", async () => {
		const tools = buildCanvasReadTools(makeDataClient({ nodes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, type: "image", title: `t${i}`, status: "idle" })) }) as never);
		const summary = tools.find((x) => x.name === "get_canvas_summary")!;
		const big = parse(await call(summary!, {}, ctx("s1")));
		assert.equal(big.nodes.length, 50);
		assert.equal(big.nodes_total, 60);
		assert.equal(big.truncated, true);

		const small = buildCanvasReadTools(makeDataClient({ nodes: [{ id: "n1", type: "image", title: "t", status: "idle" }] }) as never);
		const light = parse(await call(small.find((x) => x.name === "get_canvas_summary")!, {}, ctx("s1")));
		assert.equal(light.nodes.length, 1);
		assert.equal("nodes_total" in light, false);
		assert.equal("truncated" in light, false);
	});

	it("get_canvas_layout：节点丢冗余 absolutePosition（=position）并截断；groups 保留", async () => {
		const data = {
			nodes: Array.from({ length: 52 }, (_, i) => ({
				id: `n${i}`,
				type: "image",
				title: `t${i}`,
				status: "idle",
				position: { x: i, y: i },
				absolutePosition: { x: i, y: i },
				size: { w: 100, h: 100 },
			})),
			groups: [{ id: "g1" }],
		};
		const tools = buildCanvasReadTools(makeDataClient(data) as never);
		const layout = tools.find((x) => x.name === "get_canvas_layout")!;
		const out = parse(await call(layout!, {}, ctx("s1")));
		assert.equal(out.nodes.length, 50);
		assert.equal(out.nodes_total, 52);
		assert.equal(out.truncated, true);
		assert.equal("absolutePosition" in out.nodes[0], false);
		assert.deepEqual(out.groups, [{ id: "g1" }]);
	});

	it("list_generation_tasks：数组形态 data 截断为 {items,total,truncated}", async () => {
		const tools = buildCanvasReadTools(makeDataClient(Array.from({ length: 55 }, (_, i) => ({ id: `t${i}` }))) as never);
		const tasks = tools.find((x) => x.name === "list_generation_tasks")!;
		const out = parse(await call(tasks!, {}, ctx("s1", "u1")));
		assert.equal(out.items.length, 50);
		assert.equal(out.total, 55);
		assert.equal(out.truncated, true);
	});

	it("get_node：单节点详情不瘦身", async () => {
		const data = { id: "n1", content: "x".repeat(10_000), refs: ["a"] };
		const tools = buildCanvasReadTools(makeDataClient(data) as never);
		const node = tools.find((x) => x.name === "get_node")!;
		const out = parse(await call(node!, { node_id: "n1" }, ctx("s1")));
		assert.deepEqual(out, data);
	});
});
