/**
 * S4：删边工具（tier=write_light）。
 * 复用既有 Nest 端点 /agent/internal/remove-edges（W32），零 Nest 业务改动（仅加 optional userId）。
 * tier 定 write_light 而非 destructive：边不承载数据、画布 undo 可恢复，
 * 且搭骨架时模型需要频繁纠错，归 destructive 只会给未来审批门禁加噪音。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";
import { resultWithActions } from "./result-with-actions.js";

export const REMOVE_EDGES_MAX = 20;

export function buildRemoveEdgesTools(client: NestClient): LnkpiTool[] {
	return [
		{
			tier: "write_light" as const,
			name: "remove_edges",
			label: "删边",
			description:
				"Remove canvas edges by id (max 20 per call). Ids come from get_canvas_layout. Removing a non-existent edge is a no-op, not an error. Use delete_nodes instead when you want to delete the nodes.",
			parameters: Type.Object({
				edge_ids: Type.Array(Type.String({ description: "Canvas edge id" }), {
					description: "edge ids to remove (1-" + REMOVE_EDGES_MAX + " per call)",
				}),
			}),
			execute: async (_id, p: { edge_ids: string[] }, _u, tc: LnkpiToolContext) => {
				if (!tc?.sessionId) throw new Error("remove_edges: missing sessionId in toolContext");
				if (!tc.userId) throw new Error("remove_edges requires userId in toolContext");
				if (!Array.isArray(p.edge_ids) || p.edge_ids.length === 0) {
					throw new Error("remove_edges requires edge_ids (1-" + REMOVE_EDGES_MAX + " per call)");
				}
				if (p.edge_ids.length > REMOVE_EDGES_MAX) {
					throw new Error("remove_edges accepts at most " + REMOVE_EDGES_MAX + " edges per call");
				}
				return resultWithActions(
					await client.post("/agent/internal/remove-edges", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						edgeIds: p.edge_ids,
					}),
				);
			},
		},
	];
}
