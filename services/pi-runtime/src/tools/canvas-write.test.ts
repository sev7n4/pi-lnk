/** B-2 写工具契约测试：入参 snake_case → body camelCase、条件字段、userId 有无、短路语义。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanvasWriteTools } from "./canvas-write.js";
import type { LnkpiToolContext } from "./types.js";

type Recorded = { path: string; body: Record<string, unknown> };

function makeClient() {
	const calls: Recorded[] = [];
	const client = {
		post: async (path: string, body: Record<string, unknown>) => {
			calls.push({ path, body });
			return { echoed: body };
		},
	};
	return { client: client as never, calls };
}

const CTX: LnkpiToolContext = {
	sessionId: "s1",
	userId: "u1",
	attachments: [{ url: "https://x/a.png", mediaType: "image" }],
	mentionedKeys: ["I1"],
};

function findTool(tools: ReturnType<typeof createCanvasWriteTools>, name: string) {
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `tool ${name} not registered`);
	return tool;
}

async function run(
	tool: ReturnType<typeof createCanvasWriteTools>[number],
	params: unknown,
	ctx: LnkpiToolContext = CTX,
) {
	return tool.execute("tc1", params as never, () => {}, ctx, {} as never, undefined as never);
}

describe("canvas-write: body 形态与条件字段", () => {
	it("upsert_prompt_node 发 userId/prompt/content，nodeId 仅非空才发", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		const tool = findTool(tools, "upsert_prompt_node");
		await run(tool, { prompt: "P", content: "C" });
		assert.equal(calls[0].path, "/agent/internal/upsert-prompt-node");
		assert.deepEqual(calls[0].body, { sessionId: "s1", userId: "u1", prompt: "P", content: "C" });

		await run(tool, { prompt: "P", content: "C", node_id: "n1" });
		assert.deepEqual(calls[1].body, {
			sessionId: "s1",
			userId: "u1",
			prompt: "P",
			content: "C",
			nodeId: "n1",
		});
	});

	it("upsert_prompt_node 全量覆盖语义锁定：缺任一字段 fail-closed 不打 Nest（有意不与 set_node_text 合并的裁决依据）", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		const tool = findTool(tools, "upsert_prompt_node");
		await assert.rejects(run(tool, { prompt: "P" } as never), /BOTH prompt and content/);
		await assert.rejects(run(tool, { content: "C" } as never), /BOTH prompt and content/);
		assert.equal(calls.length, 0);
	});

	it("upsert_media_node 走 targetType；title/nodeId 条件发", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "upsert_media_node"), {
			target_type: "image",
			prompt: "a cat",
		});
		assert.equal(calls[0].path, "/agent/internal/upsert-media-node");
		assert.deepEqual(calls[0].body, { sessionId: "s1", userId: "u1", targetType: "image", prompt: "a cat" });

		await run(findTool(tools, "upsert_media_node"), {
			target_type: "text",
			prompt: "t",
			title: "标题",
			node_id: "n9",
		});
		assert.deepEqual(calls[1].body, {
			sessionId: "s1",
			userId: "u1",
			targetType: "text",
			prompt: "t",
			title: "标题",
			nodeId: "n9",
		});
	});

	it("set_node_text 只传 prompt → set-node-prompt（不带 userId，对齐老 client）", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "set_node_text"), { node_id: "n1", prompt: "p" });
		assert.equal(calls[0].path, "/agent/internal/set-node-prompt");
		assert.deepEqual(calls[0].body, { sessionId: "s1", nodeId: "n1", prompt: "p" });
	});

	it("set_node_text 只传 content → set-node-content（带 userId）", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "set_node_text"), { node_id: "n1", content: "c" });
		assert.equal(calls[0].path, "/agent/internal/set-node-content");
		assert.deepEqual(calls[0].body, { sessionId: "s1", userId: "u1", nodeId: "n1", content: "c" });
	});

	it("set_node_text 双传 → 先 prompt 后 content 两个端点；双空 → 抛错不打 Nest", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "set_node_text"), { node_id: "n1", prompt: "p", content: "c" });
		assert.equal(calls[0].path, "/agent/internal/set-node-prompt");
		assert.equal(calls[1].path, "/agent/internal/set-node-content");
		assert.deepEqual(calls[1].body, { sessionId: "s1", userId: "u1", nodeId: "n1", content: "c" });

		await assert.rejects(run(findTool(tools, "set_node_text"), { node_id: "n1" }), /prompt or content/);
		assert.equal(calls.length, 2);
	});

	it("attach_refs 发 refOrder 且不带 userId；propose_generation 带 userId", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "attach_refs"), { node_id: "n1", ref_order: ["a", "b"] });
		assert.deepEqual(calls[0].body, { sessionId: "s1", nodeId: "n1", refOrder: ["a", "b"] });

		await run(findTool(tools, "propose_generation"), { node_id: "n1" });
		assert.deepEqual(calls[1].body, { sessionId: "s1", userId: "u1", nodeId: "n1" });
	});

	it("duplicate_node 条件字段：includeUpstream 仅 true 才发", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "duplicate_node"), { node_id: "n1" });
		assert.deepEqual(calls[0].body, { sessionId: "s1", userId: "u1", nodeId: "n1" });

		await run(findTool(tools, "duplicate_node"), { node_id: "n1", include_upstream: false });
		assert.deepEqual(calls[1].body, { sessionId: "s1", userId: "u1", nodeId: "n1" });

		await run(findTool(tools, "duplicate_node"), { node_ids: ["a", "b"], include_upstream: true });
		assert.deepEqual(calls[2].body, {
			sessionId: "s1",
			userId: "u1",
			nodeIds: ["a", "b"],
			includeUpstream: true,
		});
	});

	it("grid_slice_image 条件发 sourceUrl/nodeId", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "grid_slice_image"), { cols: 2, rows: 2, source_url: "https://x/i.png" });
		assert.deepEqual(calls[0].body, {
			sessionId: "s1",
			userId: "u1",
			cols: 2,
			rows: 2,
			sourceUrl: "https://x/i.png",
		});
		await run(findTool(tools, "grid_slice_image"), { cols: 3, rows: 1, node_id: "n1" });
		assert.deepEqual(calls[1].body, { sessionId: "s1", userId: "u1", cols: 3, rows: 1, nodeId: "n1" });
	});
});

describe("canvas-write: apply_sidebar_attachments", () => {
	it("attachments/mentionedKeys 缺省时回落 toolContext；refOrder 恒发、mentionedKeys 仅非空", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"], mode: "localRefs" });
		assert.equal(calls[0].path, "/agent/internal/apply-sidebar-attachments");
		assert.deepEqual(calls[0].body, {
			sessionId: "s1",
			nodeIds: ["n1"],
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
			refOrder: [],
			mode: "localRefs",
			mentionedKeys: ["I1"],
		});
	});

	it("双层皆空 → 短路 {ok:false,error:'没有侧栏附件'}，不打 Nest", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"], mode: "localRefs" }, {
			sessionId: "s1",
			userId: "u1",
		});
		assert.equal(calls.length, 0);
		assert.ok(String((res.content as Array<{ text: string }>)[0].text).includes("没有侧栏附件"));
	});

	it("mode 缺省运行时兜底 localRefs（I-1：harness 不应用 TypeBox default）；显式空 attachments 回落 toolContext（M-1）", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] });
		assert.equal(calls[0].body.mode, "localRefs");
		assert.deepEqual(calls[0].body.attachments, [{ url: "https://x/a.png", mediaType: "image" }]);

		await run(
			findTool(tools, "apply_sidebar_attachments"),
			{ node_ids: ["n1"], mode: "localRefs", attachments: [] },
			{ sessionId: "s1", userId: "u1", attachments: [{ text: "side" }] },
		);
		assert.deepEqual(calls[1].body.attachments, [{ text: "side" }]);
	});

	it("显式 attachments 优先；mentionedKeys 独立回落 toolContext（对齐老链路各字段独立 fallback）", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "apply_sidebar_attachments"), {
			node_ids: ["n1"],
			mode: "attach_edges",
			attachments: [{ text: "hello" }],
			ref_order: ["r1"],
		});
		assert.deepEqual(calls[0].body, {
			sessionId: "s1",
			nodeIds: ["n1"],
			attachments: [{ text: "hello" }],
			refOrder: ["r1"],
			mode: "attach_edges",
			mentionedKeys: ["I1"],
		});
		// 显式 mentioned_keys 为空数组时不发 mentionedKeys
		await run(findTool(tools, "apply_sidebar_attachments"), {
			node_ids: ["n1"],
			mode: "localRefs",
			mentioned_keys: [],
		});
		assert.equal("mentionedKeys" in calls[1].body, false);
	});
});

describe("canvas-write: connect_nodes 与 registry", () => {
	it("edges ≤20；>20 工具侧抛错不打 Nest", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		const tool = findTool(tools, "connect_nodes");
		await run(tool, { edges: [{ source: "a", target: "b" }] });
		assert.deepEqual(calls[0].body, { sessionId: "s1", edges: [{ source: "a", target: "b" }] });

		const tooMany = Array.from({ length: 21 }, (_, i) => ({ source: `n${i}`, target: "z" }));
		await assert.rejects(run(tool, { edges: tooMany }), /at most 20/);
		assert.equal(calls.length, 1);
	});

	it("默认注册 13 个写工具，tier 正确；includeDeferred 时含 introduce_nodes_to_agent", () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		assert.equal(tools.length, 13);
		const tiers = Object.fromEntries(tools.map((t) => [t.name, t.tier]));
		assert.equal(tiers.connect_nodes, "graph_batch");
		assert.equal(tiers.upsert_media_node, "write_light");
		assert.ok(!tools.some((t) => t.name === "introduce_nodes_to_agent"), "deferred 工具默认不暴露");
		assert.ok(!tools.some((t) => t.name === "set_node_prompt"), "set_node_prompt 已并入 set_node_text");
		assert.ok(!tools.some((t) => t.name === "set_node_content"), "set_node_content 已并入 set_node_text");

		const withDeferred = createCanvasWriteTools(client, { includeDeferred: true });
		assert.equal(withDeferred.length, 14);
		assert.ok(withDeferred.some((t) => t.name === "introduce_nodes_to_agent"));
	});
});

describe("update_node（spec S2）", () => {
	it("snake_case 入参 → camelCase patch；userId/sessionId 只来自 toolContext", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await run(tool, { node_id: "n1", title: "茶馆主视觉", image_model: "platform::seedream-4" });
		assert.equal(calls[0].path, "/agent/internal/update-node");
		assert.deepEqual(calls[0].body, {
			sessionId: "s1",
			userId: "u1",
			nodeId: "n1",
			patch: { title: "茶馆主视觉", imageModel: "platform::seedream-4" },
		});
	});

	it("一个字段都不给 → fail-closed，不打 Nest", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await assert.rejects(() => run(tool, { node_id: "n1" }), /at least one/);
		assert.equal(calls.length, 0);
	});

	it("禁止的字段不进 patch（模型无法借 update_node 改 prompt/content/status）", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await run(tool, { node_id: "n1", title: "X", status: "completed", prompt: "注入" } as never);
		assert.deepEqual(Object.keys(calls[0].body.patch as object), ["title"]);
	});

	it("toolContext 缺 userId → fail-closed", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await assert.rejects(
			() => run(tool, { node_id: "n1", title: "X" }, { sessionId: "s1" } as LnkpiToolContext),
			/requires userId/,
		);
		assert.equal(calls.length, 0);
	});

	it("返回 details.actions（实时通道）", async () => {
		const client = {
			post: async () => ({ nodeId: "n1", actions: [{ type: "update_node", payload: { id: "n1", data: { title: "X" } } }] }),
		} as never;
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		const out = (await run(tool, { node_id: "n1", title: "X" })) as { details?: { actions?: unknown[] } };
		assert.equal(out.details?.actions?.length, 1);
	});
});

/**
 * 实时通道回归锁（Task 7 Step 6）。
 *
 * 这里只断言"形状存在性"而不是内容：makeClient 返回 `{ echoed: body }`，没有
 * actions 字段，所以空数组也算通过。要锁的是"每个写工具都真的走了
 * resultWithActions 而不是某天被改回 textResult（details:undefined）"——
 * 那正是 PR #65 delete_nodes 踩过的坑（服务端已改、画布不动，要等回合末回拉）。
 */
describe("canvas-write: 全部写工具都推 details.actions（实时通道回归锁）", () => {
	const WRITE_TOOLS = [
		"upsert_prompt_node",
		"upsert_media_node",
		"set_node_text",
		"attach_refs",
		"propose_generation",
		"apply_asset_to_node",
		"save_node_to_asset_library",
		"duplicate_node",
		"upload_media_to_canvas",
		"grid_slice_image",
		"connect_nodes",
		"update_node",
	] as const;

	it("每个写工具的返回都含 details.actions 数组", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const params: Record<string, unknown> = {
			upsert_prompt_node: { prompt: "P", content: "C" },
			upsert_media_node: { target_type: "image", prompt: "P" },
			set_node_text: { node_id: "n1", prompt: "P" },
			attach_refs: { node_id: "n1", ref_order: ["i1"] },
			propose_generation: { node_id: "n1" },
			apply_asset_to_node: { node_id: "n1", asset_id: "a1", source: "user" },
			save_node_to_asset_library: { node_id: "n1" },
			duplicate_node: { node_id: "n1" },
			upload_media_to_canvas: { url: "https://x/a.png", media_type: "image" },
			grid_slice_image: { cols: 2, rows: 2, source_url: "https://x/a.png" },
			connect_nodes: { edges: [{ source: "n1", target: "n2" }] },
			update_node: { node_id: "n1", title: "X" },
		};
		for (const name of WRITE_TOOLS) {
			const out = (await run(findTool(tools, name), params[name])) as { details?: { actions?: unknown } };
			assert.ok(Array.isArray(out.details?.actions), `${name} must expose details.actions`);
		}
	});

	it("set_node_text 只传 prompt 时不吞掉该分支的 actions（此前 prompt 返回值被丢弃）", async () => {
		const tools = createCanvasWriteTools({
			post: async () => ({ actions: [{ type: "update_node", payload: { id: "n1" } }] }),
		} as never);
		const out = (await run(findTool(tools, "set_node_text"), { node_id: "n1", prompt: "P" })) as {
			details?: { actions?: unknown[] };
		};
		assert.deepEqual(out.details?.actions, [{ type: "update_node", payload: { id: "n1" } }]);
	});

	it("set_node_text 双传时合并两个分支的 actions（顺序：prompt → content）", async () => {
		let n = 0;
		const tools = createCanvasWriteTools({
			post: async () => ({ actions: [{ type: "update_node", payload: { seq: ++n } }] }),
		} as never);
		const out = (await run(findTool(tools, "set_node_text"), { node_id: "n1", prompt: "P", content: "C" })) as {
			details?: { actions?: Array<{ payload: { seq: number } }> };
		};
		assert.deepEqual(
			out.details?.actions?.map((a) => a.payload.seq),
			[1, 2],
		);
	});
});
