/** B-2 写工具契约测试：入参 snake_case → body camelCase、条件字段、userId 有无、短路语义。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanvasWriteTools } from "./canvas-write.js";
import type { NestClient } from "./nest-client.js";
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

	it("attach_refs 发 refOrder 且不带 userId；propose_generation 带 userId + sidebarImageCount", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "attach_refs"), { node_id: "n1", ref_order: ["a", "b"] });
		assert.deepEqual(calls[0].body, { sessionId: "s1", nodeId: "n1", refOrder: ["a", "b"] });

		await run(findTool(tools, "propose_generation"), { node_id: "n1" });
		assert.deepEqual(calls[1].body, { sessionId: "s1", userId: "u1", nodeId: "n1", sidebarImageCount: 1 });
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

	it("默认注册 14 个写工具，tier 正确；includeDeferred 时含 introduce_nodes_to_agent（2026-10-21 SP-A 批量创建 13→14）", () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		assert.equal(tools.length, 14);
		const tiers = Object.fromEntries(tools.map((t) => [t.name, t.tier]));
		assert.equal(tiers.connect_nodes, "graph_batch");
		assert.equal(tiers.create_nodes_batch, "graph_batch");
		assert.equal(tiers.upsert_media_node, "write_light");
		assert.equal(tiers.set_node_generation_params, "write_light");
		assert.ok(!tools.some((t) => t.name === "introduce_nodes_to_agent"), "deferred 工具默认不暴露");
		assert.ok(!tools.some((t) => t.name === "set_node_prompt"), "set_node_prompt 已并入 set_node_text");
		assert.ok(!tools.some((t) => t.name === "set_node_content"), "set_node_content 已并入 set_node_text");
		assert.ok(!tools.some((t) => t.name === "upsert_prompt_node"), "upsert_prompt_node 随 prompt 节点下线删除");

		const withDeferred = createCanvasWriteTools(client, { includeDeferred: true });
		assert.equal(withDeferred.length, 15);
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

describe("set_node_generation_params（2026-10-03 生成参数预填）", () => {
	it("snake_case 入参 → Nest camelCase；image 扁平 / video 嵌套 / audio 扁平", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_generation_params");
		await run(tool, {
			node_id: "n1",
			guide_scene_id: "ecom_xiaohongshu",
			image_aspect: "3:4",
			image_resolution: "1K",
			image_count: 2,
		});
		assert.equal(calls[0].path, "/agent/internal/set-node-generation-params");
		assert.deepEqual(calls[0].body, {
			sessionId: "s1",
			userId: "u1",
			nodeId: "n1",
			params: {
				guideSceneId: "ecom_xiaohongshu",
				imageAspect: "3:4",
				imageResolution: "1K",
				imageCount: 2,
			},
		});
	});

	it("视频参数收进嵌套 videoSettings（与 VideoDockPanel 消费的 node.data 形状一致）", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_generation_params");
		await run(tool, {
			node_id: "n2",
			video_aspect: "9:16",
			video_duration: 6,
			video_generate_audio: true,
		});
		assert.deepEqual((calls[0].body.params as { videoSettings: object }).videoSettings, {
			aspectRatio: "9:16",
			duration: 6,
			generateAudio: true,
		});
	});

	it("音频参数是**扁平**字段（AudioDockPanel 读audioSpeed/audioVolume，不是嵌套对象）", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_generation_params");
		await run(tool, { node_id: "n3", audio_voice: "female-1", audio_speed: 1.2, audio_pitch: -3 });
		const params = calls[0].body.params as Record<string, unknown>;
		assert.equal(params.audioVoice, "female-1");
		assert.equal(params.audioSpeed, 1.2);
		assert.equal(params.audioPitch, -3);
		assert.ok(!("audioSettings" in params), "不得产出嵌套 audioSettings（前端读不到）");
	});

	it("一个参数都不给 → fail-closed，不打 Nest", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_generation_params");
		await assert.rejects(() => run(tool, { node_id: "n1" }), /at least one parameter/);
		assert.equal(calls.length, 0);
	});

	it("未声明的字段不进 params（模型无法借它塞 prompt/status）", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_generation_params");
		await run(tool, {
			node_id: "n1",
			image_aspect: "3:4",
			status: "completed",
			prompt: "注入",
		} as never);
		assert.deepEqual(Object.keys(calls[0].body.params as object), ["imageAspect"]);
	});

	it("toolContext 缺 userId → fail-closed", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_generation_params");
		await assert.rejects(
			() => run(tool, { node_id: "n1", image_aspect: "3:4" }, { sessionId: "s1" } as LnkpiToolContext),
			/requires userId/,
		);
		assert.equal(calls.length, 0);
	});

	it("description 不含任何具体比例数值（数值归注册表/skill 管，description 只写推理规则）", () => {
		const tool = findTool(createCanvasWriteTools(makeClient().client), "set_node_generation_params");
		// 允许「举例格式」里的 1:1 / 3:4 这类格式示范，禁止「小红书→3:4」这类平台映射断言
		assert.ok(!/小红书|抖音|淘宝|Amazon|SHEIN/.test(tool.description), "description 不得内嵌平台映射表");
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

// ── propose_generation 阻塞确认（B-2，2026-09-30-ask-user-blocking）─────────
// 阻塞开（registry 注入且 ASK_USER_BLOCKING≠off）→ 双臂 race：轮询画布 SSOT
// （2026-10-13 起只认**正证据**：generating / generationRecordId 变化 / generationStartedAt
// 前进；completed/error 等旧终态永远没有 confirmed 表决权——虚假确认事故修复）
// vs registry resolution（abort→aborted / timer→timeout）。off → 旧行为逐字节保留。

import { PendingToolRegistry } from "../pending-registry.js";
import { NestToolError } from "./nest-client.js";

// 2026-10-18 回合挂住等终态：确认路径的**旧**用例没有终态等待预算注入 ⇒ 文件级给
// 极小上限，避免旧用例挂进默认 13min 等待（新用例用 opts.genTerminalWaitMs 显式注入）。
process.env.PI_RUNTIME_GEN_TERMINAL_WAIT_MS = "30";

type PollRead = string | { status: string; generationRecordId?: string; generationStartedAt?: string; url?: string; errorMessage?: string; content?: string };

/**
 * propose 专用 mock：propose-generation 恒成功。
 * 首次 get-node = propose 前快照（恒返回 pending_confirm + 可配旧生成指纹，不消耗序列、
 * 不吃 failFirst/throws）；后续 get-node 为轮询读，按序返回（可注 throw）。
 */
function fakeNestClient(
	pollReads: PollRead[],
	opts: {
		getNodeThrows?: boolean;
		failFirst?: number;
		snapshotRecordId?: string;
		snapshotStartedAt?: string;
		/** P0-1：propose-generation 返回的 summary（节点类型派发生成端点用）。 */
		proposeSummary?: Record<string, unknown>;
		/** P0-1：start 与 run 系启动端点抛错（模拟服务端启动失败）。 */
		startThrows?: boolean;
		/** P0-1：run-text-generation 的返回（默认 {ok:true}）。 */
		runTextResult?: Record<string, unknown>;
		/** B2：start-image-generation 的返回（缺省 {ok:true} ⇒ 无 recordId ⇒ 旧只读轮询路径）。 */
		startResult?: Record<string, unknown>;
		/** B2：wait-image-generation 的返回。 */
		waitImageResult?: Record<string, unknown>;
		/** B2：wait-image-generation 抛错（模拟服务端等待失败 → 降级节点轮询）。 */
		waitImageThrows?: boolean;
	} = {},
) {
	let i = 0;
	let called = 0;
	let snapshotDone = false;
	const stats = { getNodeCalls: 0 };
	const posts: Array<{ path: string; body: unknown }> = [];
	const fake = {
		stats,
		posts,
		post: async (path: string, body?: unknown, _opts?: { signal?: AbortSignal }) => {
			posts.push({ path, body });
			if (opts.startThrows && /\/agent\/internal\/(start-(image|video)-generation|run-(text|audio)-generation)$/.test(path)) {
				throw new NestToolError("nest http 500: boom", "http", 500);
			}
			if (path === "/agent/internal/propose-generation") {
				return { ok: true, ...(opts.proposeSummary ? { summary: opts.proposeSummary } : {}) };
			}
			if (path === "/agent/internal/run-text-generation" && opts.runTextResult) {
				return opts.runTextResult;
			}
			if (path === "/agent/internal/start-image-generation" && opts.startResult) {
				return opts.startResult;
			}
			if (path === "/agent/internal/wait-image-generation") {
				if (opts.waitImageThrows) throw new NestToolError("nest http 500: boom", "http", 500);
				return opts.waitImageResult ?? { ok: true };
			}
			if (path === "/agent/internal/get-node") {
				stats.getNodeCalls++;
				if (!snapshotDone) {
					snapshotDone = true;
					return {
						id: "n1",
						data: {
							status: "pending_confirm",
							...(opts.snapshotRecordId ? { generationRecordId: opts.snapshotRecordId } : {}),
							...(opts.snapshotStartedAt ? { generationStartedAt: opts.snapshotStartedAt } : {}),
						},
					};
				}
				// 404 用 NestClient 真实错误形态（NestToolError kind=http + status=404），锁定「立即 gone」判定不靠 message 字符串
				if (opts.getNodeThrows) throw new NestToolError("nest /agent/internal/get-node http 404: not found", "http", 404);
				if (opts.failFirst && called++ < opts.failFirst) throw new Error("503 transient");
				const read = pollReads[Math.min(i++, pollReads.length - 1)];
				const data = typeof read === "string" ? { status: read } : read;
				return { id: "n1", data };
			}
			return { ok: true }; // propose-generation 等
		},
	};
	// 带类型的交叉断言：既满足 createCanvasWriteTools 的 NestClient 形参，
	// 又暴露 stats/posts 供断言读取（CI tsc 会编译测试文件，`as never` 会把成员收窄成 never）。
	return fake as unknown as NestClient & { stats: { getNodeCalls: number }; posts: typeof posts };
}

describe("propose_generation 阻塞确认（B-2）", () => {
	/** 轮询式等待（registry 挂载 / 其它异步条件），超时即抛错防用例假绿。 */
	async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
		const start = Date.now();
		while (!cond()) {
			if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
			await new Promise((r) => setTimeout(r, 2));
		}
	}

	it("事故回归锁：stale 覆盖回 completed 且无新生成证据 → confirmed=false reason=stale_status，文案禁称出图（2026-10-12 会话 cmv51vwpu0008p801hxaxcf8m）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient([
			"pending_confirm",
			"completed", // stale 全量 PUT 盖写后的旧终态 —— 旧逻辑在此虚假 confirmed
		]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, false);
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /stale_status:completed/);
		assert.match(text, /未检测到生成启动/);
		assert.match(text, /不要声称正在出图/);
		assert.doesNotMatch(text, /生成已由画布启动/);
		assert.equal(reg.hasPending("s1"), false);
	});

	it("completed 但 generationRecordId 相对快照变化（极快完成的竞态）→ confirmed=true reason=new_record", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(
			[{ status: "completed", generationRecordId: "rec-new", generationStartedAt: "2026-10-13T01:00:00Z" }],
			{ snapshotRecordId: "rec-old" },
		);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		const details = result.details as { confirmed?: boolean; reason?: string };
		assert.equal(details.confirmed, true);
		assert.equal(details.reason, "new_record");
	});

	it("completed 且 generationStartedAt 相对快照前进（无 recordId 时的次优正证据）→ confirmed=true reason=new_generation", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(
			[{ status: "completed", generationStartedAt: "2026-10-13T01:05:00Z" }],
			{ snapshotStartedAt: "2026-10-13T01:00:00Z" },
		);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		const details = result.details as { confirmed?: boolean; reason?: string };
		assert.equal(details.confirmed, true);
		assert.equal(details.reason, "new_generation");
	});

	it("error 终态同样无 confirmed 表决权（与 completed 同族假状态）→ confirmed=false reason=stale_status:error", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm", "error"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, false);
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /stale_status:error/);
	});

	it("确认路径 pending_confirm→generating（前端确认会清 pending_confirm 并自起生成）→ confirmed=true reason=generating 且文案不诱导 run_*", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm", "generating"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		const details = result.details as { confirmed?: boolean; reason?: string };
		assert.equal(details.confirmed, true);
		assert.equal(details.reason, "generating");
		const text = String((result.content as Array<{ text: string }>)[0].text);
		// 2026-10-18 回合挂住等终态：确认后进入终态等待，轮询序列耗尽 clamp 在 generating
		// ⇒ cap 超限收尾，文案不再有「已在画布侧启动生成」的即时返回措辞。
		assert.match(text, /生成仍在进行/);
		assert.match(text, /不要对该节点调用 run_\*/);
	});

	it("显式确认（前端 /answers → registry answered）→ confirmed=true，不等 SSOT 轮询", async () => {
		const reg = new PendingToolRegistry();
		// get-node 恒 pending_confirm：若仍靠轮询判定，本用例只能跑到 30min 超时——
		// answered 必须**自己**收口（2026-10-06 修：此前 answered 被映射成 timeout=
		// 用户点了生成却被回「未在时限内确认」）。
		const client = fakeNestClient(["pending_confirm"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true);
		const text = String((result.content as Array<{ text: string }>)[0].text);
		// 2026-10-18 终态等待：answered 后无生成证据 ⇒ cap 超限 timeout 收尾（不再是即时「已启动」）
		assert.match(text, /生成仍在进行/);
		assert.equal(reg.hasPending("s1"), false);
	});

	// ── B2（2026-10-31 蝌蚪回合实证 cmvvaw8ar000moe01fdolrugb）─────────────────
	// 旧只读轮询 get-node 的盲区：节点状态被 stale 全量 PUT 抹回 draft（#625 CAS 未合）
	// ⇒ fresh/sawGenerating 永不成立 ⇒ 盲等 cap 超时，record 已完成也无人把节点写回
	// 终态（小蝌蚪产物搁浅 13 分钟）。修复：P0-1 image/video 确认臂改走 Nest
	// wait-image/video-generation（轮询 record + 服务端写回节点终态，run_* 同语义）。

	it("B2 回归：确认后 start 返回 recordId ⇒ 走 wait-image-generation（record 轮询+服务端写回），completed 带 url ⇒ generation=completed 且 node_status generating/done", async () => {
		const reg = new PendingToolRegistry();
		const nodeStatuses: Array<{ status?: string; url?: string }> = [];
		const client = fakeNestClient(["pending_confirm"], {
			startResult: { generationRecordId: "rec-new" },
			waitImageResult: { status: "completed", url: "https://x/out.png", generationRecordId: "rec-new" },
		});
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 5,
			genTerminalWaitMs: 100,
			onNodeStatus: (_sid, data) => nodeStatuses.push(data),
		}).filter((t) => t.name === "propose_generation");
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as {
			confirmed?: boolean;
			generation?: { status?: string; url?: string };
		};
		assert.equal(details.confirmed, true);
		assert.equal(details.generation?.status, "completed");
		assert.equal(details.generation?.url, "https://x/out.png");
		const waitPost = client.posts.find((p) => p.path === "/agent/internal/wait-image-generation");
		assert.ok(waitPost, "must POST wait-image-generation");
		assert.equal((waitPost.body as { generationRecordId?: string }).generationRecordId, "rec-new");
		const statuses = nodeStatuses.map((s) => s.status);
		assert.ok(statuses.includes("generating"), "起手即 generating（run_* 同款）");
		assert.ok(statuses.includes("done"), "终态广播 done");
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /生成已完成/);
		assert.match(text, /https:\/\/x\/out\.png/);
	});

	it("B2 回归：wait-image-generation 异常 ⇒ 降级既有只读节点轮询（cap 超限 timeout 收尾，工具不炸）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm", "generating"], {
			startResult: { generationRecordId: "rec-new" },
			waitImageThrows: true,
		});
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 5,
			genTerminalWaitMs: 30,
		}).filter((t) => t.name === "propose_generation");
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as { confirmed?: boolean; generation?: { status?: string } };
		assert.equal(details.confirmed, true);
		assert.equal(details.generation?.status, "timeout");
		// 降级轮询确实发生（get-node 消耗了快照之外的读）
		assert.ok(client.stats.getNodeCalls > 1);
	});

	it("B2 回归：start 未回传 recordId ⇒ 保持旧只读节点轮询路径（行为逐字节保留）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm", "generating"]);
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 5,
			genTerminalWaitMs: 30,
		}).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		const details = result.details as { confirmed?: boolean; generation?: { status?: string } };
		assert.equal(details.confirmed, true);
		assert.equal(details.generation?.status, "timeout");
		// 未打 wait-* 端点（旧路径）
		assert.equal(
			client.posts.some((p) => p.path === "/agent/internal/wait-image-generation"),
			false,
		);
	});

	it("显式拒绝 + note（§17.8 批注流锚带回）→ confirmed=false，文案含批注意见与防抢跑提示", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.decline("s1", "tc1", "圈选的配色太冷了");
		const result = await pending;
		assert.equal((result.details as { confirmed?: boolean }).confirmed, false);
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /批注模式/);
		assert.match(text, /圈选的配色太冷了/);
		assert.match(text, /正从对话发来/);
		assert.match(text, /不要在收到用户消息前盲目重试/);
	});

	it("显式拒绝无 note → 文案逐字节保持「用户已中止。」（旧行为保留）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.decline("s1", "tc1");
		const result = await pending;
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /用户已中止/);
		assert.doesNotMatch(text, /批注模式/);
	});

	// ── 生成终态等待登记（2026-10-18 上游对齐）─────────────────────────────

	it("终态等待期登记节点：onRegisterGenerationWait 确认后注册、等待收尾必解绑（异常收尾也解）", async () => {
		const reg = new PendingToolRegistry();
		const calls: Array<{ sid: string; node: string; phase: string }> = [];
		const client = fakeNestClient(["generating"]);
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 2,
			genTerminalWaitMs: 25,
			onRegisterGenerationWait: (sid, node) => {
				calls.push({ sid, node, phase: "register" });
				return () => calls.push({ sid, node, phase: "unregister" });
			},
		}).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true);
		assert.deepEqual(calls, [
			{ sid: "s1", node: "n1", phase: "register" },
			{ sid: "s1", node: "n1", phase: "unregister" },
		]);
	});

	// ── 回合挂住等终态（2026-10-18，上游对齐）─────────────────────────────

	it("终态等待：generating→completed+url ⇒ 广播 node_status generating/done，结果带 generation，文案报完成", async () => {
		const reg = new PendingToolRegistry();
		const events: Array<{ status: string; url?: string; error?: string }> = [];
		const client = fakeNestClient(
			[
				"generating", // 确认臂：正证据 → confirmed
				"generating", // 终态等待首拍：广播 generating
				{ status: "completed", url: "https://x/a.png", generationRecordId: "rec-new" }, // 终态
			],
			{ snapshotRecordId: "rec-old" },
		);
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 2,
			genTerminalWaitMs: 2_000,
			onNodeStatus: (_sid, d) => events.push({ status: d.status, url: d.url, error: d.error }),
		}).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		const details = result.details as { confirmed?: boolean; generation?: { status: string; url?: string } };
		assert.equal(details.confirmed, true);
		assert.deepEqual(events, [
			{ status: "generating", url: undefined, error: undefined },
			{ status: "done", url: "https://x/a.png", error: undefined },
		]);
		assert.equal(details.generation?.status, "completed");
		assert.equal(details.generation?.url, "https://x/a.png");
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /生成已完成/);
	});

	it("超限收尾：持续 generating 至 cap ⇒ generation.status=timeout，只广播一次 generating，不伪造终态", async () => {
		const reg = new PendingToolRegistry();
		const events: Array<{ status: string }> = [];
		const client = fakeNestClient(["generating"]);
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 2,
			genTerminalWaitMs: 25,
			onNodeStatus: (_sid, d) => events.push({ status: d.status }),
		}).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		const details = result.details as { confirmed?: boolean; generation?: { status: string } };
		assert.equal(details.confirmed, true);
		assert.equal(details.generation?.status, "timeout");
		assert.deepEqual(events, [{ status: "generating" }]);
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /生成仍在进行/);
		assert.match(text, /不要声称已完成/);
	});

	it("进度 ticker 接线：generating 等待期经 onUpdate 每拍全量快照 + checkpoint（feature ① 画布链路活性证据）", async () => {
		const reg = new PendingToolRegistry();
		const updates: Array<{ details: any; checkpoint: boolean }> = [];
		const client = fakeNestClient(["generating"]);
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 2,
			genTerminalWaitMs: 120,
			tickerIntervalMs: 5,
		}).filter((t) => t.name === "propose_generation");
		// 不经由 run()（其 onUpdate 为 no-op）；直接喂 recording onUpdate
		const result = await propose.execute!(
			"tc1",
			{ node_id: "n1" },
			(partial: any, meta: any) => updates.push({ details: partial.details, checkpoint: meta?.checkpoint === true }),
			CTX,
			{} as never,
			undefined as never,
		);
		const details = result.details as { confirmed?: boolean; generation?: { status: string } };
		assert.equal(details.confirmed, true);
		assert.equal(details.generation?.status, "timeout"); // 全程 generating 至 cap
		// ticker 至少发射一拍，且每拍均为 generating 全量快照 + checkpoint
		assert.ok(updates.length >= 1, `进度 ticker 应至少发射一拍，实际 ${updates.length}`);
		for (const u of updates) {
			assert.equal(u.details.generating, true);
			assert.equal(u.checkpoint, true);
		}
		// 快照携带 nodeId 路由键与 elapsedSec
		const first = updates[0].details as { nodeId?: string; elapsedSec?: number };
		assert.equal(first.nodeId, "n1");
		assert.ok(typeof first.elapsedSec === "number" && first.elapsedSec >= 0);
	});

	it("failed 终态：errorMessage 透传广播 failed，文案禁称已出图", async () => {
		const reg = new PendingToolRegistry();
		const events: Array<{ status: string; error?: string }> = [];
		const client = fakeNestClient(
			[{ status: "failed", errorMessage: "upstream 500", generationRecordId: "rec-new" }],
			{ snapshotRecordId: "rec-old" },
		);
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 2,
			genTerminalWaitMs: 2_000,
			onNodeStatus: (_sid, d) => events.push({ status: d.status, error: d.error }),
		}).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		const details = result.details as { confirmed?: boolean; generation?: { status: string; error?: string } };
		assert.equal(details.confirmed, true);
		assert.deepEqual(events, [{ status: "failed", error: "upstream 500" }]);
		assert.equal(details.generation?.status, "failed");
		assert.equal(details.generation?.error, "upstream 500");
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /生成失败/);
		assert.match(text, /不要声称已出图/);
	});

	it("旧终态残留：completed 无新生成证据 ⇒ 绝不下发 done（2026-10-12 事故形态在终态等待期的同构回归锁）", async () => {
		const reg = new PendingToolRegistry();
		const events: Array<{ status: string }> = [];
		// confirmed 经 answered 收口（无新生成证据路径），终态等待读到 stale completed
		const client = fakeNestClient([{ status: "completed", generationRecordId: "rec-old" }], {
			snapshotRecordId: "rec-old",
		});
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 2,
			genTerminalWaitMs: 25,
			onNodeStatus: (_sid, d) => events.push({ status: d.status }),
		}).filter((t) => t.name === "propose_generation");
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true);
		assert.deepEqual(events, [], "stale completed 无正据 ⇒ 不广播 done");
		const details = result.details as { generation?: { status: string } };
		assert.equal(details.generation?.status, "timeout");
	});

	it("取消路径：连续两次轮询停 draft（用户 clear-propose）→ confirmed=false reason=rejected", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["draft", "draft"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, false);
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /rejected/);
		assert.equal(reg.hasPending("s1"), false);
		// P1 golden case ②（spec §6）：缺 confirmed → 信号 partial + retryable:false（§5 本地域事实：
		// 工具自己知道同参重试无意义）+ reason 进 errorCode；gate 契约键 ok/confirmed 原样保留。
		const sig = (result.details as { _signal?: Record<string, unknown> })._signal;
		assert.deepEqual(sig, { status: "partial", retryable: false, errorCode: "rejected" });
	});

	it("draft 翻转边界：单次 draft 后转 generating（draftStreak 重置）→ confirmed=true", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["draft", "generating"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true, "单次 draft 是确认翻转的中间态，不得误判 rejected");
	});

	it("瞬时错误容忍：get-node 首次 throw、次次返回 generating → confirmed=true（Finding 3）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["generating"], { failFirst: 1 });
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true);
		assert.equal(reg.hasPending("s1"), false);
	});

	it("节点 404（确定性消失）→ 第 1 拍立即 gone，不走错误容忍（Important-1 fail-closed 时序）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient([], { getNodeThrows: true }); // get-node 抛 NestToolError 404
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, false);
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /gone/);
		// 2026-10-13 起 get-node 调用 = 1 次快照 + 轮询序列；404 判据不变：
		// 轮询**首轮**即 gone，不得消耗容忍额度（快照是 best-effort，不参与容忍计数）
		assert.equal((client as { stats: { getNodeCalls: number } }).stats.getNodeCalls, 2, "404 再等多久都不会回来：轮询首轮即 fail-closed，不得消耗容忍额度");
		assert.equal(reg.hasPending("s1"), false);
	});

	it("B-5 off（env=off 且 registry 注入）→ 立即返回、details 无 confirmed（Review Focus 5）", async () => {
		const prev = process.env.ASK_USER_BLOCKING;
		process.env.ASK_USER_BLOCKING = "off";
		try {
			const reg = new PendingToolRegistry();
			const client = fakeNestClient(["pending_confirm"]);
			const [propose] = createCanvasWriteTools(client, { registry: reg }).filter(
				(t) => t.name === "propose_generation",
			);
			const result = await run(propose, { node_id: "n1" });
			assert.equal((result.details as { confirmed?: boolean }).confirmed, undefined);
			assert.equal(reg.hasPending("s1"), false); // 从未挂 pending
		} finally {
			if (prev === undefined) delete process.env.ASK_USER_BLOCKING;
			else process.env.ASK_USER_BLOCKING = prev;
		}
	});
});

// ---- Task 3：details._signal + affectedCount 直报（spec 2026-10-12 §2.2/§3）----

describe("canvas-write: _signal + affectedCount 契约", () => {
	it("写工具 details._signal 存在且 actions/affectedCount 保留", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "upsert_media_node"), {
			target_type: "image",
			prompt: "p",
		});
		const d = res.details as Record<string, unknown>;
		assert.equal((d._signal as { status: string }).status, "ok");
		assert.equal(d.affectedCount, 1);
		assert.ok(Array.isArray(d.actions));
	});

	it("grid_slice_image affectedCount = cols×rows（与 actions.length 解耦）", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "grid_slice_image"), {
			cols: 3,
			rows: 2,
			source_url: "https://x/a.png",
		});
		const d = res.details as Record<string, unknown>;
		assert.equal(d.affectedCount, 6);
	});

	it("connect_nodes affectedCount = 请求边数（graph_batch）", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "connect_nodes"), {
			edges: [
				{ source: "a", target: "b" },
				{ source: "b", target: "c" },
			],
		});
		assert.equal((res.details as Record<string, unknown>).affectedCount, 2);
	});

	it("propose_generation 确认后 details 顶层 confirmed=true 且 _signal 存在（gate 回归锁）", async () => {
		// registry 不注入 → 旧行为分支（B-2 off）也必须有 _signal + affectedCount
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "propose_generation"), { node_id: "n1" });
		const d = res.details as Record<string, unknown>;
		assert.equal((d._signal as { status: string }).status, "ok");
		assert.equal(d.affectedCount, 1);
	});

	it("textRaw 短路分支 details 补齐 {ok:false, affectedCount:0}（不再 undefined）", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		// ctx 也不带 attachments（CTX 自带一份，会走 fallback 而非短路）
		const emptyCtx: LnkpiToolContext = { ...CTX, attachments: [], mentionedKeys: [] };
		const res = await run(
			findTool(tools, "apply_sidebar_attachments"),
			{ node_ids: ["n1"], attachments: [] },
			emptyCtx,
		);
		const d = res.details as Record<string, unknown>;
		assert.equal(d.ok, false);
		assert.equal(d.affectedCount, 0);
	});
});

describe("canvas-write: apply_sidebar_attachments prepareArguments 消毒（RB-D2）", () => {
	function toolWithArgs() {
		const { client } = makeClient();
		return findTool(createCanvasWriteTools(client), "apply_sidebar_attachments");
	}

	it("事故形态（source/target_node_id 字段全虚构）→ 整参数删除，execute 回落 tc.attachments", () => {
		const out = toolWithArgs().prepareArguments?.({
			node_ids: ["n1"],
			mode: "localRefs",
			attachments: [{ source: "I1", target_node_id: "image-x" }],
		});
		assert.deepEqual(out, { node_ids: ["n1"], mode: "localRefs" });
	});

	it("合法实体（id/mediaType/label + url）原样透传——不误杀老链路显式传参", () => {
		const att = [{ id: "mv6f", mediaType: "image", sourceKind: "upload", label: "a.jpg", url: "https://x/a.png" }];
		const out = toolWithArgs().prepareArguments?.({ node_ids: ["n1"], attachments: att });
		assert.deepEqual(out, { node_ids: ["n1"], attachments: att });
	});

	it("省略 / 空数组 / 非数组 attachments 原样透传（SM-D4、M-1 回归零变化）", () => {
		const t = toolWithArgs();
		assert.deepEqual(t.prepareArguments?.({ node_ids: ["n1"] }), { node_ids: ["n1"] });
		assert.deepEqual(t.prepareArguments?.({ node_ids: ["n1"], attachments: [] }), { node_ids: ["n1"], attachments: [] });
		assert.deepEqual(t.prepareArguments?.({ node_ids: ["n1"], attachments: "I1" }), { node_ids: ["n1"], attachments: "I1" });
	});

	it("混合形态（部分合法部分伪造）→ 整参数删除（确定性，不做逐项过滤）", () => {
		const out = toolWithArgs().prepareArguments?.({
			node_ids: ["n1"],
			attachments: [
				{ id: "a", mediaType: "image", sourceKind: "upload", label: "a.jpg", url: "https://x/a.png" },
				{ source: "I2", target_node_id: "n1" },
			],
		});
		assert.deepEqual(out, { node_ids: ["n1"] });
	});

	it("url 为 blob: 但形状合法 → 不消毒（形状判断与内容治理分离，blob 拒绝仍归 Nest）", () => {
		const att = [{ id: "b", mediaType: "image", sourceKind: "upload", label: "b.jpg", url: "blob:x" }];
		const out = toolWithArgs().prepareArguments?.({ node_ids: ["n1"], attachments: att });
		assert.deepEqual(out, { node_ids: ["n1"], attachments: att });
	});

	it(
		"事故形态端到端（G2 伪造 source/target_node_id）→ 消毒删除后回落 tc.attachments，apply 成功触发 onSidebarRefBind('ok') 一次",
		async () => {
			const { client, calls } = makeClient();
			const bind: string[] = [];
			const tools = createCanvasWriteTools(client, {
				onSidebarRefBind: (o) => bind.push(o),
			});
			const tool = findTool(tools, "apply_sidebar_attachments");
			// 模型传入的 G2 形态伪造参数
			const forged = [{ source: "I1", target_node_id: "image-x" }];
			// harness 契约：prepareArguments 先消毒，再以消毒后参数 execute
			// （vendor harness/execution/tools.ts:88：
			//  `const preparedArguments = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;`）
			const prepared = (tool.prepareArguments?.({
				node_ids: ["n1"],
				mode: "localRefs",
				attachments: forged,
			}) ?? { node_ids: ["n1"], mode: "localRefs", attachments: forged }) as Record<string, unknown>;
			// ① prepareArguments 直接断言：伪造项整删（与既有 RB-D2 用例同口径）
			assert.deepEqual(prepared, { node_ids: ["n1"], mode: "localRefs" });
			// ② 端到端：以消毒后参数执行（与 harness 同路径）
			await run(tool, prepared);
			assert.equal(calls[0].path, "/agent/internal/apply-sidebar-attachments");
			const sent = calls[0].body.attachments as Array<Record<string, unknown>>;
			// ③ POST body 的 attachments 不含伪造字段（source/target_node_id 已消毒）
			assert.ok(Array.isArray(sent));
			for (const a of sent) {
				assert.equal("source" in a, false, "消毒后不得残留 source 字段");
				assert.equal("target_node_id" in a, false, "消毒后不得残留 target_node_id 字段");
			}
			// ④ 回落 SM-D4 路径：body.attachments 等于 tc.attachments 实体（CTX，无 source/target_node_id）
			assert.deepEqual(sent, CTX.attachments);
			// ⑤ stub 恒返 200（makeClient 成功路径）→ apply 成功 → onSidebarRefBind('ok') 一次
			assert.equal(bind.length, 1);
			assert.equal(bind[0], "ok");
		},
	);
});

describe("canvas-write: apply_sidebar_attachments 平台填充对账文案（RB-D2）", () => {
	it("省略 attachments（平台填充）→ content 尾部追加来源说明行", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] });
		const blocks = res.content as Array<{ type: string; text: string }>;
		assert.equal(blocks[0].type, "text");
		const note = blocks.find((b) => b.text.includes("本轮侧栏附件"));
		assert.ok(note, "missing reconciliation note");
		assert.ok(note.text.includes("平台填充"));
	});

	it("tc.attachments 实体缺 id（旧数据形态）→ 文案优雅降级不抛错", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const ctx: LnkpiToolContext = { sessionId: "s1", userId: "u1", attachments: [{ url: "https://x/a.png", mediaType: "image" }] };
		const res = await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] }, ctx);
		const blocks = res.content as Array<{ type: string; text: string }>;
		assert.ok(blocks.some((b) => b.text.includes("平台填充")));
	});

	it("显式传合法实体 → 不追加对账行（老链路 content 形态不变）", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "apply_sidebar_attachments"), {
			node_ids: ["n1"],
			attachments: [{ id: "a", mediaType: "image", sourceKind: "upload", label: "a.jpg", url: "https://x/a.png" }],
		});
		const blocks = res.content as Array<{ type: string; text: string }>;
		assert.equal(blocks.length, 1);
	});
});

// ── propose_generation 结算归因回调（P2，spec 2026-10-13 §2）────────────────
// 一次 propose 恰好一条观测：race 收敛单点（等待结算）与早退路径（nonblocking）互斥不双计。
// ── P0-1 确认即启动（规格 2026-10-30-propose-confirm-execution-unity §5）──────────
// 2026-10-29 生产事故根因回归锁：确认（answered）后**必须**由 runtime 直调服务端
// 生成端点——此前内联卡只 POST /answers、前端不再自起，runtime 空轮询 13 分钟等一个
// 自己没启动的任务（GenerationRecord 零行，模型却被喂「生成仍在进行」）。
describe("propose_generation 确认即启动（P0-1）", () => {
	/** 轮询式等待（registry 挂载），超时即抛错防用例假绿。 */
	async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
		const start = Date.now();
		while (!cond()) {
			if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
			await new Promise((r) => setTimeout(r, 2));
		}
	}

	it("answered → runtime 直调 start-image-generation（执行权收编服务端，body 三字段）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		await pending;
		const start = client.posts.find((p) => p.path === "/agent/internal/start-image-generation");
		assert.ok(start, "start-image-generation 未被调用");
		assert.deepEqual(start.body, { sessionId: "s1", userId: "u1", nodeId: "n1" });
	});

	it("summary.type=video → 派发 start-video-generation", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"], { proposeSummary: { type: "video" } });
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		await pending;
		assert.ok(
			client.posts.some((p) => p.path === "/agent/internal/start-video-generation"),
			"start-video-generation 未被调用",
		);
	});

	it("text 节点：run-text-generation 持至终态 → 直接采用，不再轮询等待", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"], {
			proposeSummary: { type: "text" },
			runTextResult: { status: "completed" },
		});
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5, genTerminalWaitMs: 40 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as { generation?: { status: string } };
		assert.equal(details.generation?.status, "completed");
		assert.ok(client.posts.some((p) => p.path === "/agent/internal/run-text-generation"));
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /生成已完成/);
	});

	it("启动失败（start 抛 500）→ fail 信号 + 明说未启动，绝不装「生成中」", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"], { startThrows: true });
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as {
			ok?: boolean;
			started?: boolean;
			confirmed?: boolean;
			_signal?: { status?: string; errorCode?: string };
		};
		assert.equal(details.ok, false);
		assert.equal(details.started, false);
		assert.equal(details.confirmed, true);
		assert.equal(details._signal?.errorCode, "generation_start_failed");
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /启动生成失败/);
		assert.match(text, /不要声称正在出图/);
		assert.doesNotMatch(text, /生成仍在进行/);
	});

	// ── 终态动作广播源（2026-10-31 黑猩猩/奶牛生产实证回归锁）────────────────
	// 事故形态：final result 透传提议时刻 base.actions[pending_confirm]，生成完成后
	// 广播把画布节点重新打回待确认 ⇒ 确认/取消胶囊永久残留；且 completed+url 从未
	// 广播 ⇒ 产物要手动刷新才上画布。锁：details.actions 只准携带终态时刻的新鲜动作。
	it("B2 wait 终态：actions 透传 Nest finishActions（completed+url），绝不重放 pending_confirm", async () => {
		const reg = new PendingToolRegistry();
		const finish = {
			type: "update_node",
			payload: { id: "n1", data: { status: "completed", generationRecordId: "rec1", url: "https://x/a.png" } },
		};
		const client = fakeNestClient(["pending_confirm"], {
			startResult: { generationRecordId: "rec1" },
			waitImageResult: { status: "completed", url: "https://x/a.png", generationRecordId: "rec1", actions: [finish] },
		});
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as { actions?: Array<Record<string, unknown>>; generation?: { status: string } };
		assert.equal(details.generation?.status, "completed");
		assert.deepEqual(details.actions, [finish]);
		assert.ok(
			!JSON.stringify(details.actions).includes("pending_confirm"),
			"终态广播绝不允许携带 pending_confirm（胶囊残留根治锁）",
		);
	});

	it("B2 wait 终态但 Nest 缺 actions → 按 genOutcome 现造 completed+url+recordId", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"], {
			startResult: { generationRecordId: "rec1" },
			waitImageResult: { status: "completed", url: "https://x/a.png" },
		});
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as { actions?: Array<{ type: string; payload: { id: string; data: Record<string, unknown> } }> };
		assert.deepEqual(details.actions, [
			{
				type: "update_node",
				payload: { id: "n1", data: { status: "completed", url: "https://x/a.png", generationRecordId: "rec1" } },
			},
		]);
	});

	it("wait 非终态（fallback_pending → timeout）→ 空 actions（绝不重放提议时刻动作）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"], {
			startResult: { generationRecordId: "rec1" },
			waitImageResult: { status: "fallback_pending" },
		});
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as { actions?: unknown[]; generation?: { status: string } };
		assert.equal(details.generation?.status, "timeout");
		assert.deepEqual(details.actions, []);
	});

	it("text 节点 run-text 终态：Nest 自带 actions（含 content）原样透传", async () => {
		const reg = new PendingToolRegistry();
		const finish = {
			type: "update_node",
			payload: { id: "n1", data: { status: "completed", content: "你好", generationRecordId: "recT" } },
		};
		const client = fakeNestClient(["pending_confirm"], {
			proposeSummary: { type: "text" },
			runTextResult: { status: "completed", generationRecordId: "recT", actions: [finish] },
		});
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5, genTerminalWaitMs: 40 }).filter(
			(t) => t.name === "propose_generation",
		);
		const pending = run(propose, { node_id: "n1" });
		await waitFor(() => reg.hasPending("s1"));
		reg.answer("s1", "tc1", {});
		const result = await pending;
		const details = result.details as { actions?: Array<Record<string, unknown>> };
		assert.deepEqual(details.actions, [finish]);
	});
});

describe("propose_generation 结算归因回调（P2）", () => {
	it("无 registry（旧行为早退）→ onProposeOutcome(nonblocking, false) 且结果逐字节旧行为", async () => {
		const client = fakeNestClient(["pending_confirm"]);
		const outcomes: Array<[string, boolean]> = [];
		const [propose] = createCanvasWriteTools(client, {
			onProposeOutcome: (reason, confirmed) => outcomes.push([reason, confirmed]),
		}).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		assert.deepEqual(outcomes, [["nonblocking", false]]);
		assert.equal((result.details as Record<string, unknown>).confirmed, undefined, "早退路径不产生 confirmed 语义");
	});

	it("B-5 off（env=off）→ 同样记 nonblocking（开关关闭也进分母）", async () => {
		const prev = process.env.ASK_USER_BLOCKING;
		process.env.ASK_USER_BLOCKING = "off";
		try {
			const reg = new PendingToolRegistry();
			const client = fakeNestClient(["pending_confirm"]);
			const outcomes: Array<[string, boolean]> = [];
			const [propose] = createCanvasWriteTools(client, {
				registry: reg,
				onProposeOutcome: (reason, confirmed) => outcomes.push([reason, confirmed]),
			}).filter((t) => t.name === "propose_generation");
			await run(propose, { node_id: "n1" });
			assert.deepEqual(outcomes, [["nonblocking", false]]);
			assert.equal(reg.hasPending("s1"), false);
		} finally {
			if (prev === undefined) delete process.env.ASK_USER_BLOCKING;
			else process.env.ASK_USER_BLOCKING = prev;
		}
	});

	it("/answers 显式确认 → onProposeOutcome(answered, true)（唯一不依赖 SSOT 时序的路径）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm"]); // 轮询臂永远看不到生成——确认只能来自 /answers
		const outcomes: Array<[string, boolean]> = [];
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 5,
			onProposeOutcome: (reason, confirmed) => outcomes.push([reason, confirmed]),
		}).filter((t) => t.name === "propose_generation");
		const pending = run(propose, { node_id: "n1" });
		// 轮询式等待 registry 挂载（复用本文件 waitFor 语义，避免挂载竞态假绿）
		const start = Date.now();
		while (!reg.hasPending("s1")) {
			if (Date.now() - start > 1000) throw new Error("waitFor pending timeout");
			await new Promise((r) => setTimeout(r, 2));
		}
		reg.answer("s1", "tc1", {});
		await pending;
		assert.deepEqual(outcomes, [["answered", true]]);
	});

	it("stale 覆盖回 completed → onProposeOutcome(stale_status:completed, false)（2026-10-12 事故形态的观测锚）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["pending_confirm", "completed"]);
		const outcomes: Array<[string, boolean]> = [];
		const [propose] = createCanvasWriteTools(client, {
			registry: reg,
			pollMs: 5,
			onProposeOutcome: (reason, confirmed) => outcomes.push([reason, confirmed]),
		}).filter((t) => t.name === "propose_generation");
		await run(propose, { node_id: "n1" });
		assert.deepEqual(outcomes, [["stale_status:completed", false]]);
	});

	it("超时（registry timer）→ onProposeOutcome(timeout, false)", async () => {
		const reg = new PendingToolRegistry();
		// 轮询臂恒 pending_confirm（不出任何正证据），让 registry 超时臂赢下 race
		const client = fakeNestClient(["pending_confirm"]);
		const outcomes: Array<[string, boolean]> = [];
		// askUserTimeoutMs 走 env；注入最短档（>=1000ms 下限由实现保证的话用 1s）
		const prev = process.env.ASK_USER_TIMEOUT_MS;
		process.env.ASK_USER_TIMEOUT_MS = "1";
		try {
			const [propose] = createCanvasWriteTools(client, {
				registry: reg,
				pollMs: 50,
				onProposeOutcome: (reason, confirmed) => outcomes.push([reason, confirmed]),
			}).filter((t) => t.name === "propose_generation");
			const result = await run(propose, { node_id: "n1" });
			assert.equal((result.details as { confirmed?: boolean }).confirmed, false);
			assert.deepEqual(outcomes, [["timeout", false]]);
		} finally {
			if (prev === undefined) delete process.env.ASK_USER_TIMEOUT_MS;
			else process.env.ASK_USER_TIMEOUT_MS = prev;
		}
	});
});

// ── propose_generation RB-D5 门禁短路（spec 2026-10-13-sidebar-ref-bind-invariant-design）──
describe("propose_generation RB-D5 门禁短路", () => {
	function gateClient(gateBody: unknown, record: (path: string, body: Record<string, unknown>) => void) {
		return {
			post: async (path: string, body: Record<string, unknown>) => {
				record(path, body);
				if (path === "/agent/internal/propose-generation") return gateBody;
				return { ok: true };
			},
		} as never;
	}

	it("Nest fail-closed（confirmed:false missing_refs）→ 短路返回，不进阻塞等待、无 get-node 轮询", async () => {
		const paths: string[] = [];
		const outcomes: Array<[string, boolean]> = [];
		const client = gateClient(
			{ confirmed: false, reason: "missing_refs", message: "参考图未绑定成功，请重试 apply_sidebar_attachments（只传 node_ids 与 mentioned_keys），或请用户在画布上手动添加参考图" },
			(p) => paths.push(p),
		);
		const [propose] = createCanvasWriteTools(client, {
			registry: new PendingToolRegistry(),
			pollMs: 5,
			onProposeOutcome: (reason, confirmed) => outcomes.push([reason, confirmed]),
		}).filter((t) => t.name === "propose_generation");

		const result = await run(propose, { node_id: "n1" });
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /missing_refs/);
		assert.match(text, /apply_sidebar_attachments/);
		const details = result.details as { ok?: boolean; confirmed?: boolean; _signal?: { status?: string; retryable?: boolean; errorCode?: string } };
		assert.equal(details.ok, false);
		assert.equal(details.confirmed, false);
		assert.deepEqual(details._signal, { status: "failed", retryable: false, errorCode: "missing_refs" });
		// 短路：只有 propose-generation 一次调用，无 get-node 快照/轮询，registry 无 pending
		assert.deepEqual(paths, ["/agent/internal/propose-generation"]);
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0][0], "missing_refs");
		assert.equal(outcomes[0][1], false);
	});

	it("B-5 off（无 registry）短路同样生效——门禁独立于阻塞模式", async () => {
		const client = gateClient({ confirmed: false, reason: "missing_refs", message: "m" }, () => {});
		const [propose] = createCanvasWriteTools(client).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /missing_refs/);
		assert.doesNotMatch(text, /"ok":true/);
	});

	it("tc.attachments 只计 image：text/video 附件不计入 body.sidebarImageCount", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const client = {
			post: async (path: string, body: Record<string, unknown>) => {
				bodies.push(body);
				return { ok: true };
			},
		} as never;
		const tools = createCanvasWriteTools(client);
		const ctx: LnkpiToolContext = {
			sessionId: "s1",
			userId: "u1",
			attachments: [
				{ url: "https://x/a.png", mediaType: "image" },
				{ text: "参考文案", mediaType: "text" },
				{ url: "https://x/v.mp4", mediaType: "video" },
			],
		};
		await run(findTool(tools, "propose_generation"), { node_id: "n1" }, ctx);
		assert.equal(bodies[0].sidebarImageCount, 1);
		// Ruling 6 锚：无附件（含 0）也恒上行，DTO 可选字段收到显式 0
		const emptyCtx: LnkpiToolContext = { sessionId: "s1", userId: "u1", attachments: [] };
		await run(findTool(tools, "propose_generation"), { node_id: "n1" }, emptyCtx);
		assert.equal(bodies[1].sidebarImageCount, 0);
	});

	it("Nest 正常放行（无 confirmed:false）→ 不短路，走既有路径（Review Focus 5 回归锚）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["generating"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true);
	});
});

// ── RB-D9（PR-D Task 1）：侧栏参考图绑定观测批核心指标发射 ───────────────────
// 三个新回调只做 Map.set、不得抛；调用点不包 try/catch。本 describe 用注入回调断言
// 调用次数/取值，复用既有 makeClient / findTool / run 辅助与 NestToolError 形态。
describe("canvas-write: RB-D9 指标发射", () => {
	/** apply_sidebar_attachments 专用 stub：按 behavior 决定 POST 结果（200 / 400 / 500）。 */
	function applyClient(behavior: "ok" | "bad400" | "bad500") {
		return {
			post: async (path: string, _body: Record<string, unknown>) => {
				if (path === "/agent/internal/apply-sidebar-attachments") {
					if (behavior === "bad400") throw new NestToolError("nest apply zod 400", "http", 400);
					if (behavior === "bad500") throw new NestToolError("nest apply 500", "http", 500);
					return { ok: true };
				}
				return { ok: true };
			},
		} as never;
	}

	it("apply 成功（stub 200）→ onSidebarRefBind('ok') 调用一次", async () => {
		const bind: string[] = [];
		const tools = createCanvasWriteTools(applyClient("ok"), {
			onSidebarRefBind: (o) => bind.push(o),
		});
		await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] });
		assert.equal(bind.length, 1);
		assert.equal(bind[0], "ok");
	});

	it("apply 返回 400（NestToolError status 400）→ onSidebarRefBind('invalid_params') + onNestZodReject('apply-sidebar-attachments')", async () => {
		const bind: string[] = [];
		const reject: string[] = [];
		const tools = createCanvasWriteTools(applyClient("bad400"), {
			onSidebarRefBind: (o) => bind.push(o),
			onNestZodReject: (ep) => reject.push(ep),
		});
		// 失败仍向上 fail-visible（链路错误不静默吞），但指标已先行记录
		await assert.rejects(run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] }));
		assert.equal(bind.length, 1);
		assert.equal(bind[0], "invalid_params");
		assert.equal(reject.length, 1);
		assert.equal(reject[0], "apply-sidebar-attachments");
	});

	it("apply 返回 500（NestToolError 5xx）→ onSidebarRefBind('upstream_error')", async () => {
		const bind: string[] = [];
		const tools = createCanvasWriteTools(applyClient("bad500"), {
			onSidebarRefBind: (o) => bind.push(o),
		});
		await assert.rejects(run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] }));
		assert.equal(bind.length, 1);
		assert.equal(bind[0], "upstream_error");
	});

	it("propose 短路（confirmed:false missing_refs）→ onSidebarRefBind('short_circuit') + onProposeMissingRefs()", async () => {
		const bind: string[] = [];
		let missingRefs = 0;
		const client = {
			post: async (path: string) => {
				if (path === "/agent/internal/propose-generation") {
					return { confirmed: false, reason: "missing_refs", message: "m" };
				}
				return { ok: true };
			},
		} as never;
		const [propose] = createCanvasWriteTools(client, {
			onSidebarRefBind: (o) => bind.push(o),
			onProposeMissingRefs: () => missingRefs++,
		}).filter((t) => t.name === "propose_generation");
		await run(propose, { node_id: "n1" });
		assert.equal(bind.length, 1);
		assert.equal(bind[0], "short_circuit");
		assert.equal(missingRefs, 1);
	});
});

describe("canvas-write: 写工具串行化（spec 2026-10-16 P1-A）", () => {
	it("upsert_media_node / set_node_generation_params / propose_generation 声明 executionMode=sequential", () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		for (const name of ["upsert_media_node", "set_node_generation_params", "propose_generation"]) {
			const tool = findTool(tools, name);
			assert.equal(tool.executionMode, "sequential", `${name} 必须串行（同批写调用 create 先 finalize，P1b 捕获时序的前提）`);
		}
	});
});

describe("set_node_text format", () => {
	it("content+format:'html' ⇒ set-node-content body 带 format", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		const tool = findTool(tools, "set_node_text");
		await run(tool, { node_id: "n1", content: "<h1>hi</h1>", format: "html" });
		const body = calls.find((c) => c.path === "/agent/internal/set-node-content")?.body;
		assert.equal(body?.format, "html");
	});
	it("format 缺省 ⇒ body 无 format 键", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_text");
		await run(tool, { node_id: "n1", content: "纯文本" });
		const body = calls.find((c) => c.path === "/agent/internal/set-node-content")?.body;
		assert.equal("format" in (body ?? {}), false);
	});
	it("format 非法值 ⇒ 工具层抛错（信息列合法值），不发请求", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_text");
		await assert.rejects(
			() => run(tool, { node_id: "n1", content: "x", format: "jsx" }),
			/plain, markdown, html/,
		);
		assert.equal(calls.length, 0);
	});
	it("format 无 content ⇒ 抛错（format 仅与 content 同发）", async () => {
		const { client } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "set_node_text");
		await assert.rejects(
			() => run(tool, { node_id: "n1", prompt: "p", format: "html" }),
			/format requires content/,
		);
	});
});

describe("create_nodes_batch item format", () => {
	it("item.format:'html' ⇒ add-nodes-batch body items 带 format", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "create_nodes_batch");
		await run(tool, { items: [{ key: "k1", type: "text", prompt: "落地页", format: "html" }] });
		const body = calls.find((c) => c.path === "/agent/internal/add-nodes-batch")?.body;
		assert.equal((body?.items as Array<Record<string, unknown>>)[0].format, "html");
	});
	it("item.format 非法值 ⇒ 抛错", async () => {
		const { client } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "create_nodes_batch");
		await assert.rejects(
			() => run(tool, { items: [{ key: "k1", type: "text", prompt: "p", format: "jsx" }] }),
			/plain, markdown, html/,
		);
	});
});

describe("set_node_text description 路由线索（规格 §10 skill 接线守卫）", () => {
	it("描述含 load_skill('html-craft') 强制线索", () => {
		const tool = findTool(createCanvasWriteTools((undefined as never) as never), "set_node_text");
		assert.match(tool.description, /load_skill\('html-craft'\)/);
	});
});
