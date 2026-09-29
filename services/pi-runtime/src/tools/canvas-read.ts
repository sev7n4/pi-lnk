/** B-1 批次 read 工具（7 个）。端点/body 对照 services/agent-runtime/app/tools/nest_client.py:216-596。 （注：老 LangGraph runtime 已于 2026-09-27 退役删除，该路径为历史语义出处） */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

const DIAG_REQUIRED = "pass generation_record_id or node_id (at least one)";

/** 列表截断阈值：读工具结果数组超过此长度即截断（③ 结果瘦身，控制上下文占用）。 */
const TRIM_MAX_ITEMS = 50;

/**
 * 读工具结果瘦身：顶层每个超过 TRIM_MAX_ITEMS 的数组字段截断，
 * 附 `<key>_total` 与 `truncated:true` 标记（数组形态 data 映射为 {items,total,truncated}）。
 * ≤阈值的数据逐字节原样返回，不附加任何键。
 */
export function trimData<T>(data: T): T {
	if (Array.isArray(data)) {
		if (data.length <= TRIM_MAX_ITEMS) return data;
		return { items: data.slice(0, TRIM_MAX_ITEMS), total: data.length, truncated: true } as T;
	}
	if (typeof data !== "object" || data === null) return data;
	const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
	let truncated = false;
	for (const [k, v] of Object.entries(out)) {
		if (Array.isArray(v) && v.length > TRIM_MAX_ITEMS) {
			out[`${k}_total`] = v.length;
			out[k] = v.slice(0, TRIM_MAX_ITEMS);
			truncated = true;
		}
	}
	if (truncated) out.truncated = true;
	return out as T;
}

/**
 * layout 专用瘦身：节点丢冗余 absolutePosition（恒等于 position，Nest 侧测试锁定该语义），
 * 再走通用 trimData。形状异常时原样透传（fail-open，只降信息量不报错）。
 */
function slimLayout(data: unknown): unknown {
	const d = data as { nodes?: unknown[] } | null;
	if (typeof d !== "object" || d === null || !Array.isArray(d.nodes)) return trimData(data);
	const nodes = d.nodes.map((n) => {
		if (typeof n !== "object" || n === null) return n;
		const { absolutePosition: _drop, ...rest } = n as Record<string, unknown>;
		return rest;
	});
	return trimData({ ...d, nodes });
}

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
				return textResult(trimData(await client.post("/agent/internal/get-canvas-summary", { sessionId: tc.sessionId })));
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
			description:
				"Get the current canvas layout (nodes with positions and sizes, groups, and edges as source/target id pairs). Use edge ids from here for remove_edges.",
			parameters: Type.Object({}),
			execute: async (_id, _p, _u, tc: LnkpiToolContext) => {
				return textResult(slimLayout(await client.post("/agent/internal/get-canvas-layout", { sessionId: tc.sessionId })));
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
				return textResult(trimData(await client.post("/agent/internal/list-generation-tasks", body)));
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
				return textResult(trimData(await client.post("/agent/internal/list-user-assets", { userId: tc.userId })));
			},
		},
	];
}
