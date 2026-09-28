/**
 * P0 破坏性操作：delete_nodes（tier=destructive）。
 * spec: docs/superpowers/specs/2026-09-28-agent-tool-p0-web-and-delete-design.md
 * 复用既有 Nest 端点 /agent/internal/remove-nodes（W31）：服务端自动删除关联边，零 Nest 改动。
 * v1 免交互审批（spec D3）：画布 undo/redo 兜底 + 单次上限 50；误删率高再上 before_tool 审批。
 * stage 参数 v1 不透传（恒直接删）；sessionId 只取 toolContext（模型入参不可覆盖会话归属）。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

export const DELETE_NODES_MAX = 50;

function textResult(data: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }], details: undefined };
}

export function buildDeleteNodesTools(client: NestClient): LnkpiTool[] {
	return [
		{
			tier: "destructive" as const,
			name: "delete_nodes",
			label: "删除节点",
			description:
				"Delete canvas nodes by id. Edges connected to deleted nodes are removed automatically. Max 50 nodes per call. The canvas supports undo, but for large deletions prefer confirming the scope with the user first.",
			parameters: Type.Object({
				node_ids: Type.Array(Type.String({ description: "Canvas node id" }), {
					description: "node ids to delete (1-" + DELETE_NODES_MAX + " per call)",
				}),
			}),
			execute: async (_id, p: { node_ids: string[] }, _u, tc: LnkpiToolContext) => {
				// harness 不做 schema 校验，约束在此兜底（对齐 canvas-write 模式）
				if (!Array.isArray(p.node_ids) || p.node_ids.length === 0) {
					throw new Error("delete_nodes requires node_ids (1-50 per call)");
				}
				if (p.node_ids.length > DELETE_NODES_MAX) {
					throw new Error("delete_nodes accepts at most " + DELETE_NODES_MAX + " nodes per call");
				}
				const data = await client.post("/agent/internal/remove-nodes", {
					sessionId: tc.sessionId,
					nodeIds: p.node_ids,
				});
				return textResult(data);
			},
		},
	];
}
