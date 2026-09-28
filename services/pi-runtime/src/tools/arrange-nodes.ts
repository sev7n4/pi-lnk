/**
 * arrange_nodes 工具（spec docs/superpowers/specs/2026-09-28-arrange-nodes-tool-design.md）：
 * 触发前端自动排列一批画布节点（grid 网格 / along_edges 沿边分层）。
 * tier=ui_command 单向无回流——execute 立即返回，前端即触即发布局，不需用户回复。
 * 复用 useCanvasGrouping.layoutNodesInGrid / layoutNodesAlongEdges（零新建布局算法）。
 * D1-D5 已拍板按推荐（默认 grid / 无 edges 降级 grid / 不与 focus 联动 / gap 默认 40 / edges 显式传）。
 */
import { Type } from "typebox";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";

export interface ArrangeEdge {
	source: string;
	target: string;
}

function uiResult(commands: unknown[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: unknown[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, canvasCommands: commands }) }],
		details: { ok: true, canvasCommands: commands },
	};
}

export function createArrangeNodesTools(metrics: Metrics): LnkpiTool[] {
	return [{
		tier: "ui_command" as const,
		name: "arrange_nodes",
		label: "排列节点",
		description: "Auto-arrange a set of canvas nodes into a grid or a layered layout along directed edges. Non-blocking UI command; reuses the existing useCanvasGrouping layout functions on the frontend. Use grid for unordered sets, along_edges when nodes are connected (e.g. an ecommerce image set linked by reference edges) to lay out as a left-to-right reference chain.",
		parameters: Type.Object({
			node_ids: Type.Array(Type.String(), {
				description: "Canvas node ids to arrange; at least 2 to have effect",
			}),
			mode: Type.String({
				description: "grid | along_edges; grid ignores edges, along_edges requires edges",
			}),
			gap: Type.Optional(Type.Number({ description: "pixel gap between nodes, default 40" })),
			edges: Type.Optional(
				Type.Array(Type.Object({
					source: Type.String(),
					target: Type.String(),
				}), {
					description: "Directed edges; required when mode=along_edges, ignored when mode=grid",
				}),
			),
		}),
		execute: async (_id, p: {
			node_ids: string[];
			mode: string;
			gap?: number;
			edges?: ArrangeEdge[];
		}) => {
			metrics.observeToolCall("arrange_nodes", "ok");
			const mode = p.mode === "along_edges" ? "along_edges" : "grid";
			return uiResult([{
				type: "arrange_nodes",
				nodeIds: p.node_ids,
				mode,
				gap: p.gap ?? 40,
				...(mode === "along_edges" && p.edges?.length ? { edges: p.edges } : {}),
			}]);
		},
	}];
}
