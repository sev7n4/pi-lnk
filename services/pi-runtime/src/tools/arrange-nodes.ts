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
	| "below_two_nodes"
	| "distribute_below_three_nodes";

/**
 * 合法取值白名单（2026-10-23 契约消歧新增）。
 *
 * ⛔ 旧实现把非法 mode **静默收窄成 grid**（`p.mode === "along_edges" || … ? p.mode : "grid"`），
 * 而前端 `handleArrangeNodes` 的注释早已写明该风险：
 * 「mode 是非字符串 → String() 归一会放行，但派发层判 req.mode === 'align'（假）
 *   ⇒ 会**静默落到 grid 分支**（对齐意图被换成网格重排）」。
 * ⇒ 模型把 align 拼成 "aligned"、或把 distribute 拼成 "distributeX" 时，
 *   用户要「左对齐」却拿到「网格重排」，**且工具结果里没有任何降级标记**。
 * ⇒ 现在：非法取值**直接报错并列出允许值**（错误会回灌模型 ⇒ 它能自纠），
 *   不再静默换语义。
 */
const ALLOWED_MODES = ["grid", "along_edges", "align", "distribute"] as const;
const ALLOWED_ALIGN_MODES = ["left", "centerH", "right", "top", "centerV", "bottom"] as const;
const ALLOWED_AXES = ["x", "y"] as const;

function uiResult(payload: Record<string, unknown>, commands: unknown[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: unknown[]; affectedCount: number; _signal: { status: "ok" } };
} {
	// Task 3（spec §2.2）：arranged 为工具直报的实际生效数（L2 校验后 present 集合大小）；
	// 单向 UI 命令、无 Nest 写副作用 ⇒ _signal 恒 ok（missing/degraded 已在 content 自描述）。
	const arranged = typeof payload.arranged === "number" ? payload.arranged : 0;
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload, canvasCommands: commands }) }],
		details: { ok: true, canvasCommands: commands, affectedCount: arranged, _signal: { status: "ok" } },
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
			"自动重排/规整画布节点位置（只改坐标，不改内容）。" +
			"【先判层再选 mode】① 重排层（互斥择一）：" +
			"mode=grid —— 无顺序关系的集合铺成网格（用户说「排一下/铺开/理一理」）；" +
			"mode=along_edges —— 有向关系分层排布（用户说「按连线/引用链/流程顺序排」，需画布上有边）。" +
			"② 规整层（在现有位置上微调，可叠加）：" +
			"mode=align + align_mode(left|centerH|right|top|centerV|bottom) —— 六向精确对齐" +
			"（用户说「左对齐/水平居中/顶对齐」，即要求某一边或中线齐平）；" +
			"mode=distribute + axis(x|y) —— 等距分布，相邻间隙相等、需 ≥3 个节点" +
			"（用户说「等距/间距均匀/匀开」）。" +
			"⚠️ 重排结果本身已含对齐与等距（网格行列天然对齐且等距；顺连线同层竖排、层间左对齐）" +
			"⇒ 已经排整齐了就别再叠规整；用户要「救场式微调」时才用 align/distribute。" +
			"【何时该用】用户想整理/排列/对齐/铺开节点时用本工具，不要只读画布就作答。" +
			"【何时不该用】改节点文字用 set_node_text；新建节点用 upsert_media_node；" +
			"只想查看布局用 get_canvas_summary / get_canvas_layout——「看一眼」不要触发重排。" +
			"【参数】mode 只接受 grid|along_edges|align|distribute；align 必带 align_mode、distribute 必带 axis；" +
			"写错或缺参会直接报错并列出允许值（不要猜、不要留空）。",

		parameters: Type.Object({
			node_ids: Type.Array(Type.String(), {
				description: "Canvas node ids to arrange; at least 2 to have effect",
			}),
			mode: Type.String({
				description: "grid | along_edges | align | distribute; grid ignores edges, along_edges requires edges",
			}),
			align_mode: Type.Optional(Type.String({ description: "align 时必填: left|centerH|right|top|centerV|bottom" })),
			axis: Type.Optional(Type.String({ description: "distribute 时必填: x|y" })),
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
			align_mode?: string;
			axis?: string;
			gap?: number;
			edges?: ArrangeEdge[];
		}, _onUpdate, tc?: LnkpiToolContext) => {
			const nodeIds = Array.isArray(p.node_ids) ? [...new Set(p.node_ids.filter((id) => typeof id === "string"))] : [];
			const gap = typeof p.gap === "number" && Number.isFinite(p.gap) ? p.gap : 40;

			// 2026-10-23 契约消歧：非法 mode **不再静默收窄成 grid**（旧实现会把
			// 「aligned」「distributeX」等拼错值当 grid 执行 ⇒ 用户要左对齐却拿到网格重排，
			// 且工具结果里没有任何降级标记）。现在直接报错并列出允许值 ⇒ 错误回灌模型可自纠。
			const rawMode = p.mode;
			if (typeof rawMode !== "string" || !(ALLOWED_MODES as readonly string[]).includes(rawMode)) {
				throw new Error(
					`arrange_nodes: mode 必须是 ${ALLOWED_MODES.join(" | ")}，收到 ${JSON.stringify(rawMode)}。` +
					"不确定时：没有关系集合用 grid，有向关系用 along_edges，要对齐用 align，要等距用 distribute。",
				);
			}
			let mode = rawMode as (typeof ALLOWED_MODES)[number];

			// align / distribute 的**条件必填**：缺参或写错 ⇒ 报错（不静默发残缺命令 ——
			// 前端对缺 alignMode/axis 的命令会 no-op，用户看到「点了没反应」且无从得知原因）。
			if (mode === "align") {
				const alignMode = p.align_mode;
				if (typeof alignMode !== "string" || !(ALLOWED_ALIGN_MODES as readonly string[]).includes(alignMode)) {
					throw new Error(
						`arrange_nodes: mode=align 必须带 align_mode（${ALLOWED_ALIGN_MODES.join(" | ")}），收到 ${JSON.stringify(alignMode)}。`,
					);
				}
			}
			if (mode === "distribute") {
				const axis = p.axis;
				if (typeof axis !== "string" || !(ALLOWED_AXES as readonly string[]).includes(axis)) {
					throw new Error(
						`arrange_nodes: mode=distribute 必须带 axis（${ALLOWED_AXES.join(" | ")}），收到 ${JSON.stringify(axis)}。`,
					);
				}
			}

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
					if (present.size < 2) {
						degraded = degraded ?? "below_two_nodes";
					} else if (mode === "distribute" && present.size < 3) {
						// 等距分布需 ≥3 节点（前端 distributeNodes 对 <3 是 no-op ⇒ 静默无反应）
						// ⇒ 必须回灌，否则模型以为已经排好了。
						degraded = degraded ?? "distribute_below_three_nodes";
					}
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
					...(mode === "align" && p.align_mode ? { alignMode: p.align_mode } : {}),
					...(mode === "distribute" && p.axis ? { axis: p.axis } : {}),
				}],
			);
		},
	}];
}
