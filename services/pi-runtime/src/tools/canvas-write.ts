/**
 * B-2 批次写工具（13 个）+ connect_nodes（自 B-6 提前，见计划决策 D1）。
 * 端点/body 对照 services/agent-runtime/app/tools/nest_client.py 与 （注：老 LangGraph runtime 已于 2026-09-27 退役删除，该路径为历史语义出处）
 * apps/server/src/agent/agent-canvas-tools.controller.ts（2026-09-24 逐条核对）。
 * introduce_nodes_to_agent 属老链路 DEFERRED_TOOL_NAMES：默认不暴露（includeDeferred 显式开启）。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";
import type { SidebarAttachment } from "./types.js";
import { extractActions, resultWithActions } from "./result-with-actions.js";

const CONNECT_NODES_MAX_EDGES = 20;

/**
 * 无 actions 语义的直出文本（仅用于短路分支，如 apply_sidebar_attachments 的
 * 「没有侧栏附件」——那里根本不打 Nest，不存在 CanvasAction 可推）。
 * 其余一律走 resultWithActions：Nest 的实时通道只认 details.actions。
 */
function textRaw(value: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

/** 条件字段：仅非空（undefined/空串）才进 body。 */
function setIfPresent(body: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined && value !== null && value !== "") body[key] = value;
}

export function createCanvasWriteTools(
	client: NestClient,
	opts: { includeDeferred?: boolean } = {},
): LnkpiTool[] {
	const write = { tier: "write_light" as const };
	const tools: LnkpiTool[] = [
		{
			...write,
			name: "upsert_prompt_node",
			label: "新建/更新提示词节点",
			description:
				"Create or update a prompt (text) node. prompt doubles as the node title; content is the node body. FULL-OVERWRITE semantics: with node_id both prompt and content replace the node's text (partial updates use set_node_text).",
			parameters: Type.Object({
				prompt: Type.String({ description: "用户短需求原文，作 prompt 节点标题" }),
				content: Type.String({
					description:
						"节点正文。人物多视图类（三视图/模特图/角色设定图/多视图/模特定妆图/四视图）须按内置 character_turnaround 模版输出单段中文生图提示词；营销方案等可输出 Markdown。",
				}),
				node_id: Type.Optional(Type.String({ description: "Existing node id to update" })),
			}),
			execute: async (_id, p: { prompt: string; content: string; node_id?: string }, _u, tc: LnkpiToolContext) => {
				// 全量覆盖语义锁定（③ 后续裁决：有意不与 set_node_text 合并）——
				// Nest upsertPromptNode 带 nodeId 时 prompt/content/title 一起覆盖，不保留未传字段。
				// harness 不做 schema 校验，缺参必须在此 fail-closed，否则静默丢字段。
				if (!p.prompt || !p.content) {
					throw new Error(
						"upsert_prompt_node requires BOTH prompt and content (full overwrite; for partial updates use set_node_text)",
					);
				}
				if (!tc.userId) throw new Error("upsert_prompt_node requires userId in toolContext");
				const body: Record<string, unknown> = {
					sessionId: tc.sessionId,
					userId: tc.userId,
					prompt: p.prompt,
					content: p.content,
				};
				setIfPresent(body, "nodeId", p.node_id);
				return resultWithActions(await client.post("/agent/internal/upsert-prompt-node", body));
			},
		},
		{
			...write,
			name: "upsert_media_node",
			label: "新建/更新媒体节点",
			description:
				"Create or update a single media node (image|video|text|audio) with a prompt. Does not start generation — use propose_generation after the node is ready.",
			parameters: Type.Object({
				target_type: Type.String({ description: "Media node type: image, video, text, or audio" }),
				prompt: Type.String({ description: "Generation prompt to store on the media node" }),
				title: Type.Optional(Type.String({ description: "Optional node title" })),
				node_id: Type.Optional(Type.String({ description: "Existing media node id to update" })),
			}),
			execute: async (
				_id,
				p: { target_type: string; prompt: string; title?: string; node_id?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("upsert_media_node requires userId in toolContext");
				const body: Record<string, unknown> = {
					sessionId: tc.sessionId,
					userId: tc.userId,
					targetType: p.target_type,
					prompt: p.prompt,
				};
				setIfPresent(body, "title", p.title);
				setIfPresent(body, "nodeId", p.node_id);
				return resultWithActions(await client.post("/agent/internal/upsert-media-node", body));
			},
		},
		{
			...write,
			name: "set_node_text",
			label: "改节点文本",
			description:
				"Update prompt and/or content text on an EXISTING node (at least one of prompt/content; passing both updates both). For creating nodes use upsert_media_node / upsert_prompt_node instead.",
			parameters: Type.Object({
				node_id: Type.String({ description: "Canvas node id" }),
				prompt: Type.Optional(
					Type.String({ description: "New prompt text (generation prompt; doubles as prompt-node title)" }),
				),
				content: Type.Optional(Type.String({ description: "New node content text" })),
			}),
			execute: async (
				_id,
				p: { node_id: string; prompt?: string; content?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!p.prompt && !p.content) {
					throw new Error("set_node_text requires prompt or content (at least one)");
				}
				// content 路径 Nest DTO 必填 userId，fail-closed：缺身份时提前抛错而非发 undefined。
				if (p.content && !tc.userId) {
					throw new Error("set_node_text with content requires userId in toolContext (session identity missing)");
				}
				// 各端点 body 形态对齐老 client：set-node-prompt 不带 userId；set-node-content 带 userId。
				// ⚠️ prompt 分支此前丢弃了返回值 → 它返回的 canvas_action 被丢掉，
				// 实时通道断掉（画布要等回合末全量回拉才更新）。两个分支的 actions 需合并回传。
				const collected: Record<string, unknown>[] = [];
				if (p.prompt) {
					const done = await client.post("/agent/internal/set-node-prompt", {
						sessionId: tc.sessionId,
						nodeId: p.node_id,
						prompt: p.prompt,
					});
					collected.push(...extractActions(done));
				}
				if (p.content) {
					const done = await client.post("/agent/internal/set-node-content", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						nodeId: p.node_id,
						content: p.content,
					});
					collected.push(...extractActions(done));
				}
				// 两个分支的 actions 合并后一次性回给 Nest（details.actions 是实时通道）
				return resultWithActions({ actions: collected });
			},
		},
		{
			...write,
			name: "attach_refs",
			label: "挂引用",
			description:
				"Attach ordered canvas node ids (image-* / video-*) as refs. Never pass sidebar chip keys (I1/I2/@I*). Use apply_sidebar_attachments for chips.",
			parameters: Type.Object({
				node_id: Type.String({ description: "Target node id" }),
				ref_order: Type.Array(Type.String(), { description: "Ordered reference node ids" }),
			}),
			execute: async (_id, p: { node_id: string; ref_order: string[] }, _u, tc: LnkpiToolContext) => {
				return resultWithActions(
					await client.post("/agent/internal/attach-refs", {
						sessionId: tc.sessionId,
						nodeId: p.node_id,
						refOrder: p.ref_order,
					}),
				);
			},
		},
		{
			...write,
			name: "propose_generation",
			label: "提议生成",
			description:
				"Mark a media node pending user confirm for generation. Never calls run_*; wait for the user to confirm in the UI.",
			parameters: Type.Object({ node_id: Type.String({ description: "Canvas node id" }) }),
			execute: async (_id, p: { node_id: string }, _u, tc: LnkpiToolContext) => {
				if (!tc.userId) throw new Error("propose_generation requires userId in toolContext");
				return resultWithActions(
					await client.post("/agent/internal/propose-generation", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						nodeId: p.node_id,
					}),
				);
			},
		},
		{
			...write,
			name: "apply_sidebar_attachments",
			label: "落侧栏附件",
			description:
				"Write sidebar chip attachments onto canvas nodes as localRefs (default). mentioned_keys are I1/I2 chip keys, not canvas image-* ids. attachments may be omitted; falls back to this-turn sidebar attachments from the conversation context.",
			parameters: Type.Object({
				node_ids: Type.Array(Type.String(), { description: "Target canvas node ids" }),
				attachments: Type.Optional(
					Type.Array(Type.Object({}, { additionalProperties: true }), {
						description: "Sidebar attachment payloads; omit to use this-turn sidebar attachments",
					}),
				),
				ref_order: Type.Optional(Type.Array(Type.String(), { description: "Attachment id order" })),
				mode: Type.Optional(Type.String({ default: "localRefs", description: "localRefs or attach_edges" })),
				mentioned_keys: Type.Optional(
					Type.Array(Type.String(), {
						description: "Sidebar chip keys such as I1/I2, never canvas image-* ids",
					}),
				),
			}),
			execute: async (
				_id,
				p: {
					node_ids: string[];
					attachments?: Record<string, unknown>[];
					ref_order?: string[];
					mode?: string;
					mentioned_keys?: string[];
				},
				_u,
				tc: LnkpiToolContext,
			) => {
				// harness 不应用 TypeBox default（I-1）：mode 缺省必须在运行时兜底，否则 Nest DTO 必填 400。
				const mode = p.mode || "localRefs";
				// 对齐老链路 fallback：显式空数组同样回落本轮侧栏（M-1）；两层皆空短路（不打 Nest、不计熔断）。
				const attachments = p.attachments?.length ? p.attachments : tc.attachments;
				if (!attachments || attachments.length === 0) {
					return textRaw({ ok: false, error: "没有侧栏附件" });
				}
				const body: Record<string, unknown> = {
					sessionId: tc.sessionId,
					nodeIds: p.node_ids,
					attachments,
					refOrder: p.ref_order ?? tc.refOrder ?? [],
					mode,
				};
				const mentioned = p.mentioned_keys ?? tc.mentionedKeys;
				if (mentioned && mentioned.length > 0) body.mentionedKeys = mentioned;
				return resultWithActions(await client.post("/agent/internal/apply-sidebar-attachments", body));
			},
		},
		{
			...write,
			name: "apply_asset_to_node",
			label: "落资产到节点",
			description: "Apply a user or public asset URL to a compatible canvas node",
			parameters: Type.Object({
				node_id: Type.String({ description: "Target canvas node id" }),
				asset_id: Type.String({ description: "User or public asset id" }),
				source: Type.String({ description: "user or public" }),
			}),
			execute: async (
				_id,
				p: { node_id: string; asset_id: string; source: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("apply_asset_to_node requires userId in toolContext");
				return resultWithActions(
					await client.post("/agent/internal/apply-asset-to-node", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						nodeId: p.node_id,
						assetId: p.asset_id,
						source: p.source,
					}),
				);
			},
		},
		{
			...write,
			name: "save_node_to_asset_library",
			label: "存入资产库",
			description: "Save a canvas node's media URL to the user asset library",
			parameters: Type.Object({
				node_id: Type.String({ description: "Canvas node with media to save" }),
				label: Type.Optional(Type.String({ description: "Optional asset label override" })),
			}),
			execute: async (_id, p: { node_id: string; label?: string }, _u, tc: LnkpiToolContext) => {
				if (!tc.userId) throw new Error("save_node_to_asset_library requires userId in toolContext");
				const body: Record<string, unknown> = { sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id };
				setIfPresent(body, "label", p.label);
				return resultWithActions(await client.post("/agent/internal/save-node-to-asset-library", body));
			},
		},
		{
			...write,
			name: "duplicate_node",
			label: "复制节点",
			description:
				"Duplicate canvas node(s). Default: copy nodes only, no edges. Use node_ids for multi-select. Set include_upstream=true to reuse existing upstream nodes and connect them to the copies via inbound edges (edges only, upstream nodes are not duplicated).",
			parameters: Type.Object({
				node_id: Type.Optional(Type.String({ description: "Single seed node id" })),
				node_ids: Type.Optional(Type.Array(Type.String(), { description: "Multi-select subgraph ids" })),
				include_upstream: Type.Optional(
					Type.Boolean({
						description:
							"Single-node mode: reuse existing upstream nodes and connect them to the copy via inbound edges (upstream nodes are not duplicated)",
					}),
				),
			}),
			execute: async (
				_id,
				p: { node_id?: string; node_ids?: string[]; include_upstream?: boolean },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("duplicate_node requires userId in toolContext");
				const body: Record<string, unknown> = { sessionId: tc.sessionId, userId: tc.userId };
				setIfPresent(body, "nodeId", p.node_id);
				if (p.node_ids && p.node_ids.length > 0) body.nodeIds = p.node_ids;
				if (p.include_upstream === true) body.includeUpstream = true;
				return resultWithActions(await client.post("/agent/internal/duplicate-node", body));
			},
		},
		{
			...write,
			name: "upload_media_to_canvas",
			label: "上传媒体",
			description: "Add a media node from a public URL",
			parameters: Type.Object({
				url: Type.String({ description: "Public media URL to attach" }),
				media_type: Type.String({ description: "image, video, or audio" }),
				title: Type.Optional(Type.String({ description: "Optional node title" })),
			}),
			execute: async (
				_id,
				p: { url: string; media_type: string; title?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("upload_media_to_canvas requires userId in toolContext");
				const body: Record<string, unknown> = {
					sessionId: tc.sessionId,
					userId: tc.userId,
					url: p.url,
					mediaType: p.media_type,
				};
				setIfPresent(body, "title", p.title);
				return resultWithActions(await client.post("/agent/internal/upload-media-to-canvas", body));
			},
		},
		{
			...write,
			name: "grid_slice_image",
			label: "切图",
			description:
				"Equal-split an image into cols×rows tiles and return uploaded URLs. Does NOT write to canvas. Requires source_url or node_id (prefer source_url when both).",
			parameters: Type.Object({
				cols: Type.Number({ description: "Grid column count" }),
				rows: Type.Number({ description: "Grid row count" }),
				source_url: Type.Optional(
					Type.String({ description: "Image URL to slice; preferred over node_id when both are set" }),
				),
				node_id: Type.Optional(
					Type.String({
						description: "Canvas image node id; reads data.url from the session when source_url is omitted",
					}),
				),
			}),
			execute: async (
				_id,
				p: { cols: number; rows: number; source_url?: string; node_id?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("grid_slice_image requires userId in toolContext");
				const body: Record<string, unknown> = {
					sessionId: tc.sessionId,
					userId: tc.userId,
					cols: p.cols,
					rows: p.rows,
				};
				setIfPresent(body, "sourceUrl", p.source_url);
				setIfPresent(body, "nodeId", p.node_id);
				return resultWithActions(await client.post("/agent/internal/grid-slice-image", body));
			},
		},
		{
			tier: "graph_batch",
			name: "connect_nodes",
			label: "连节点",
			description: `Connect canvas nodes with directed edges (max ${CONNECT_NODES_MAX_EDGES} edges per call)`,
			parameters: Type.Object({
				edges: Type.Array(
					Type.Object({
						source: Type.String({ description: "source node id" }),
						target: Type.String({ description: "target node id" }),
					}),
					{ description: "Directed edges as source/target node ids" },
				),
			}),
			execute: async (_id, p: { edges: Array<{ source: string; target: string }> }, _u, tc: LnkpiToolContext) => {
				if (p.edges.length > CONNECT_NODES_MAX_EDGES) {
					throw new Error(
						`connect_nodes accepts at most ${CONNECT_NODES_MAX_EDGES} edges per call (got ${p.edges.length})`,
					);
				}
				return resultWithActions(await client.post("/agent/internal/connect-nodes", { sessionId: tc.sessionId, edges: p.edges }));
			},
		},
	];

	if (opts.includeDeferred) {
		tools.push({
			...write,
			name: "introduce_nodes_to_agent",
			label: "引入节点到侧栏",
			description: "Add canvas node content to agent sidebar context",
			parameters: Type.Object({
				node_ids: Type.Array(Type.String(), { description: "Canvas node ids to add as agent sidebar refs" }),
			}),
			execute: async (_id, p: { node_ids: string[] }, _u, tc: LnkpiToolContext) => {
				if (!tc.userId) throw new Error("introduce_nodes_to_agent requires userId in toolContext");
				return resultWithActions(
					await client.post("/agent/internal/introduce-nodes-to-agent", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						nodeIds: p.node_ids,
					}),
				);
			},
		});
	}

	return tools;
}
