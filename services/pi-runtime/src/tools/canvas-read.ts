/** B-1 批次 read 工具（7 个）。端点/body 对照 services/agent-runtime/app/tools/nest_client.py:216-596。 （注：老 LangGraph runtime 已于 2026-09-27 退役删除，该路径为历史语义出处） */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

const DIAG_REQUIRED = "pass generation_record_id or node_id (at least one)";

function textResult(data: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }], details: undefined };
}

export function createCanvasReadTools(client: NestClient): LnkpiTool[] {
	const base = { tier: "read" as const };
	return [
		{
			...base,
			name: "get_canvas_summary",
			label: "画布摘要",
			description:
				"Get a lightweight summary of the current canvas (node list with ids, types and counts). Call this first to understand the canvas.",
			parameters: Type.Object({}),
			execute: async (_id, _p, _u, tc: LnkpiToolContext) => {
				return textResult(await client.post("/agent/internal/get-canvas-summary", { sessionId: tc.sessionId }));
			},
		},
		{
			...base,
			name: "get_node",
			label: "读取节点",
			description:
				"Get full details of one canvas node by its id (content, media url, refs, connections).",
			parameters: Type.Object({ node_id: Type.String({ description: "canvas node id, e.g. n_abc123" }) }),
			execute: async (_id, p: { node_id: string }, _u, tc: LnkpiToolContext) => {
				return textResult(
					await client.post("/agent/internal/get-node", { sessionId: tc.sessionId, nodeId: p.node_id }),
				);
			},
		},
		{
			...base,
			name: "get_generation_status",
			label: "生成状态",
			description:
				"Get the current generation status of one media node (queued/running/succeeded/failed).",
			parameters: Type.Object({ node_id: Type.String({ description: "media node id" }) }),
			execute: async (_id, p: { node_id: string }, _u, tc: LnkpiToolContext) => {
				return textResult(
					await client.post("/agent/internal/get-generation-status", {
						sessionId: tc.sessionId,
						nodeId: p.node_id,
					}),
				);
			},
		},
		{
			...base,
			name: "get_generation_diagnostic",
			label: "生成诊断",
			description:
				"Get diagnostic details for a generation task (error message, retry hints). Requires generation_record_id or node_id.",
			parameters: Type.Object({
				generation_record_id: Type.Optional(Type.String()),
				node_id: Type.Optional(Type.String()),
			}),
			execute: async (
				_id,
				p: { generation_record_id?: string; node_id?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("get_generation_diagnostic requires userId in toolContext");
				if (!p.generation_record_id && !p.node_id) throw new Error(`get_generation_diagnostic requires ${DIAG_REQUIRED}`);
				const body: Record<string, unknown> = { sessionId: tc.sessionId, userId: tc.userId };
				if (p.node_id) body.nodeId = p.node_id;
				if (p.generation_record_id) body.generationRecordId = p.generation_record_id;
				return textResult(await client.post("/agent/internal/get-generation-diagnostic", body));
			},
		},
		{
			...base,
			name: "get_canvas_layout",
			label: "画布布局",
			description: "Get the current canvas layout (nodes and edges with positions and sizes).",
			parameters: Type.Object({}),
			execute: async (_id, _p, _u, tc: LnkpiToolContext) => {
				return textResult(await client.post("/agent/internal/get-canvas-layout", { sessionId: tc.sessionId }));
			},
		},
		{
			...base,
			name: "list_generation_tasks",
			label: "任务列表",
			description:
				"List generation records for the current session (task panel). Optional type filter e.g. image/video.",
			parameters: Type.Object({ type: Type.Optional(Type.String()) }),
			execute: async (_id, p: { type?: string }, _u, tc: LnkpiToolContext) => {
				if (!tc.userId) throw new Error("list_generation_tasks requires userId in toolContext");
				const body: Record<string, unknown> = { sessionId: tc.sessionId, userId: tc.userId };
				if (p.type) body.type = p.type;
				return textResult(await client.post("/agent/internal/list-generation-tasks", body));
			},
		},
		{
			...base,
			name: "list_user_assets",
			label: "资产库",
			description: "List assets in the user's asset library.",
			parameters: Type.Object({}),
			execute: async (_id, _p, _u, tc: LnkpiToolContext) => {
				if (!tc.userId) throw new Error("list_user_assets requires userId in toolContext");
				return textResult(await client.post("/agent/internal/list-user-assets", { userId: tc.userId }));
			},
		},
	];
}
