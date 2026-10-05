/**
 * arrange_nodes 工具（spec docs/superpowers/specs/2026-09-28-arrange-nodes-tool-design.md）：
 * 触发前端自动排列一批画布节点（grid 网格 / along_edges 沿边分层）。
 * tier=ui_command 单向无回流——execute 立即返回，前端即触即发布局，不需用户回复。
 * 复用 useCanvasGrouping.layoutNodesInGrid / layoutNodesAlongEdges（零新建布局算法）。
 * D1-D5 已拍板按推荐（默认 grid / 无 edges 降级 grid / 不与 focus 联动 / gap 默认 40 / edges 显式传）。
 *
 * 2026-10-02 增补（L2 结果富化 + L3 by-mode 观测）：
 * - 注入**只读** NestClient，execute 内先 get_canvas_layout 校验 node_ids 是否真实存在、
 *   along_edges 是否真有可用边，把 arranged / missing / degraded 写回工具结果——
 *   原实现只回显入参，模型无法知道 id 是否存在、是否降级，无法自我纠错。
 * - 校验是**尽力而为**：Nest 读失败（超时/熔断/包络错）一律按原样发命令并标 verified=false，
 *   绝不因校验把单向 UI 命令拖成阻塞或失败。
 * - edges 仍以显式传入为准（D5）；显式缺失时用画布上已有的边兜底并标注，避免「静默变网格」。
 *
 * 2026-10-04：移除 `metrics` 形参与 L3 by-mode 自计埋点（观测移交事件层，见 spec §3.2）。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

export interface ArrangeEdge {
	source: string;
	target: string;
}

/** get_canvas_layout 只取用到的字段（该接口还带 position/size/groups 等，此处不消费）。 */
interface CanvasLayoutSnapshot {
	nodes?: Array<{ id?: string }>;
	edges?: Array<{ source?: string; target?: string }>;
}

export type ArrangeDegradedReason =
	| "no_edges_fallback_grid"
	| "edges_missing_used_canvas_edges"
	| "below_two_nodes";

function uiResult(payload: Record<string, unknown>, commands: unknown[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: unknown[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload, canvasCommands: commands }) }],
		details: { ok: true, canvasCommands: commands },
	};
}

function usableEdges(
	edges: ArrangeEdge[] | undefined,
	present: Set<string>,
): ArrangeEdge[] {
	if (!edges?.length) return [];
	return edges.filter(
		(e) => e && typeof e.source === "string" && typeof e.target === "string" && present.has(e.source) && present.has(e.target),
	);
}

export function createArrangeNodesTools(client?: NestClient): LnkpiTool[] {
	return [{
		tier: "ui_command" as const,
		name: "arrange_nodes",
		label: "排列节点",
		description:
			"自动重排画布节点的位置（只改坐标，不改节点内容）。" +
			"【何时该用】用户想整理 / 排列 / 对齐 / 铺开节点，或想按连线关系把节点排成层级时，" +
			"例如「把节点排一下」「按左右关系重新排」「整理画布」「按引用链铺开」「这些节点太乱了」——" +
			"只要用户的意图是调整布局或顺序，就用本工具，不要只读画布就作答。" +
			"mode=grid 用于无顺序关系的集合；mode=along_edges 用于有向关系（如分镜引用链、大纲→分集）。" +
			"完成后视口自动平移到这些节点，并返回已排列数、未找到的 id、along_edges 是否降级为 grid（degraded）。" +
			"【何时不该用】要改节点文字用 set_node_text；要新建节点用 upsert_prompt_node / upsert_media_node；" +
			"只想查看有多少节点或当前布局用 get_canvas_summary / get_canvas_layout——" +
			"「看一眼」不要触发重排，除非用户明确要求整理或排列。",

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
		}, _onUpdate, tc?: LnkpiToolContext) => {
			const nodeIds = Array.isArray(p.node_ids) ? [...new Set(p.node_ids.filter((id) => typeof id === "string"))] : [];
			const gap = typeof p.gap === "number" && Number.isFinite(p.gap) ? p.gap : 40;
			let mode: "grid" | "along_edges" = p.mode === "along_edges" ? "along_edges" : "grid";

			// L2：只读校验（尽力而为）。无 client（纯文本模式）时跳过，行为与旧版逐字节一致。
			let verified = false;
			let missing: string[] = [];
			let degraded: ArrangeDegradedReason | undefined;
			let edges: ArrangeEdge[] | undefined = mode === "along_edges" ? p.edges : undefined;

			if (client && tc?.sessionId) {
				try {
					const layout = (await client.post("/agent/internal/get-canvas-layout", {
						sessionId: tc.sessionId,
					})) as CanvasLayoutSnapshot | null;
					const known = new Set(
						(layout?.nodes ?? []).map((n) => n?.id).filter((id): id is string => typeof id === "string"),
					);
					const present = new Set(nodeIds.filter((id) => known.has(id)));
					missing = nodeIds.filter((id) => !known.has(id));
					verified = true;

					if (mode === "along_edges") {
						const explicit = usableEdges(p.edges, present);
						if (explicit.length) {
							edges = explicit;
						} else {
							const fallback = (layout?.edges ?? [])
								.filter((e) => e && typeof e.source === "string" && typeof e.target === "string")
								.map((e) => ({ source: e.source as string, target: e.target as string }))
								.filter((e) => present.has(e.source) && present.has(e.target));
							if (fallback.length) {
								edges = fallback;
								degraded = "edges_missing_used_canvas_edges";
							} else {
								mode = "grid";
								edges = undefined;
								degraded = "no_edges_fallback_grid";
							}
						}
					}
					if (present.size < 2) degraded = degraded ?? "below_two_nodes";
				} catch {
					// 校验失败不阻断：按入参原样下发（单向 UI 命令不因读失败而失败）
					verified = false;
					missing = [];
					degraded = undefined;
				}
			} else if (mode === "along_edges" && !p.edges?.length) {
				mode = "grid";
				edges = undefined;
				degraded = "no_edges_fallback_grid";
			}

			// L3：by-mode 观测已于 2026-10-04 移交事件层——`arrange_nodes_grid` 这类
			// 动态 tool label 是 spec §3.2 点名要消除的基数风险（mode 取值会随前端加模式增长），
			// 事件层只出 `tool="arrange_nodes"`。mode 分布改由工具结果里的 `details.mode` 观测。

			return uiResult(
				{ mode, gap, arranged: nodeIds.length - missing.length, missing, degraded, verified },
				[{
					type: "arrange_nodes",
					nodeIds,
					mode,
					gap,
					...(mode === "along_edges" && edges?.length ? { edges } : {}),
				}],
			);
		},
	}];
}
