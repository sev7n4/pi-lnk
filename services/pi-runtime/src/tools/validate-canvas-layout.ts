/**
 * VISP Phase 2（Path C，spec docs/superpowers/specs/2026-11-05-agent-canvas-visual-perception-design.md
 * §2.1 S-4 / §4.3 R-V5·R-V6·R-V8 / §5.4 / §8）：
 * validate_canvas_layout —— 确定性布局校验工具（tier=present，纯只读）。
 *
 * 数据面：POST /agent/internal/get-canvas-layout（同 render_canvas_view / arrange_nodes 校验姿势，
 * NestClient 只有 post；只读端点同样是 POST 语义）。节点盒 = absolutePosition + size
 * （服务端 getNodeSize 已按真实渲染尺寸算好，工具侧不重复实现尺寸表）。
 *
 * 校验逻辑：packages/shared/canvas/layout.ts validateCanvasLayout 的**镜像**而非 import——
 * pi-runtime 的依赖面刻意不含 @lnkpi/shared（independence.test.ts 物理锁，见 package.json）。
 * parity 由 validate-canvas-layout.contract-mirror.test.ts 以同源 fixture 锁定；
 * 改任一侧实现必须同步另一侧与两份测试（canvas-group GROUP_COLOR_KEYS / read-media
 * resolveSidebarRefLocal 同款先例）。
 *
 * R-V6：报告是事实源——模型可以自述「没重叠」，但担保必须以本报告为准。
 * R-V8：Nest 失败 → ok:false 明确错误文本，不编造报告。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

// ---- 镜像：packages/shared/src/canvas/layout.ts validateCanvasLayout（SSOT，勿单改）----

type LayoutViolationType = "OVERLAP" | "OVERFLOW" | "MIN_SPACING";

interface LayoutViolation {
	type: LayoutViolationType;
	nodeIds: string[];
	metric: string;
	severity: "low" | "medium" | "high";
}

interface NodeBox {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface ValidateInput {
	nodes: NodeBox[];
	canvas?: { width: number; height: number };
	minSpacing?: number;
}

/** 两矩形的最短间距（不相交时 ≥0；相交返回 0，重叠对由 OVERLAP 报、此处跳过防双报）。 */
function rectGap(a: NodeBox, b: NodeBox): number {
	const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
	const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
	return Math.max(dx, dy);
}

/**
 * 确定性布局校验（与 shared 版逐语义一致，改任一侧必须同步）。
 * - OVERLAP：成对交集面积 > 0（相切不算），severity=high
 * - OVERFLOW：节点越出 canvas 边界（仅提供 canvas 时判定），severity=medium
 * - MIN_SPACING：成对间距 < minSpacing（重叠对跳过），severity=low
 * 输出顺序：按输入序 i<j 遍历 ⇒ 同输入逐字节同输出（§8-6）。
 */
export function validateCanvasLayoutLocal(input: ValidateInput): LayoutViolation[] {
	const nodes = input.nodes;
	const minSpacing = input.minSpacing ?? 0;
	const violations: LayoutViolation[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i]!;
		if (input.canvas) {
			const over: string[] = [];
			if (a.x < 0) over.push(`左边界超出画布 ${Math.round(-a.x)}px`);
			if (a.y < 0) over.push(`上边界超出画布 ${Math.round(-a.y)}px`);
			if (a.x + a.width > input.canvas.width)
				over.push(`右边界超出画布 ${Math.round(a.x + a.width - input.canvas.width)}px`);
			if (a.y + a.height > input.canvas.height)
				over.push(`下边界超出画布 ${Math.round(a.y + a.height - input.canvas.height)}px`);
			if (over.length > 0) {
				violations.push({ type: "OVERFLOW", nodeIds: [a.id], metric: over.join("；"), severity: "medium" });
			}
		}
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j]!;
			const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
			const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
			if (w > 0 && h > 0) {
				violations.push({
					type: "OVERLAP",
					nodeIds: [a.id, b.id],
					metric: `交集 ${Math.round(w)}x${Math.round(h)}px`,
					severity: "high",
				});
				continue; // 重叠对已由 OVERLAP 报告，不再判 MIN_SPACING（防双报）
			}
			if (minSpacing > 0) {
				const gap = rectGap(a, b);
				if (gap < minSpacing) {
					violations.push({
						type: "MIN_SPACING",
						nodeIds: [a.id, b.id],
						metric: `间距 ${Math.round(gap)}px < 阈值 ${Math.round(minSpacing)}px`,
						severity: "low",
					});
				}
			}
		}
	}
	return violations;
}

// ---- 工具 ----

/** get-canvas-layout 只取用到的字段（绝对位置 + 服务端已算好的尺寸）。 */
interface LayoutSnapshot {
	nodes?: Array<{
		id?: string;
		absolutePosition?: { x?: number; y?: number };
		size?: { w?: number; h?: number };
	}>;
}

/** 报告文本（spec §5.4 形态）：人类可读、量化、确定性。 */
export function formatViolationReport(nodeCount: number, violations: LayoutViolation[]): string {
	if (violations.length === 0) return `【布局校验】画布 ${nodeCount} 个节点，未检出违规。`;
	const lines = violations.map(
		(v) => `- ${v.type} ${v.nodeIds.join(" × ")}：${v.metric}（severity=${v.severity}）`,
	);
	return `【布局校验】画布 ${nodeCount} 个节点，检出 ${violations.length} 处违规：\n${lines.join("\n")}`;
}

export function buildValidateCanvasLayoutTools(client: NestClient): LnkpiTool[] {
	return [
		{
			tier: "present",
			name: "validate_canvas_layout",
			label: "布局校验",
			description:
				"Run a deterministic layout check on the current canvas and get a violation report " +
				"(OVERLAP: nodes overlapping; MIN_SPACING: nodes closer than the min spacing threshold; " +
				"severity is computed by geometric rules, not opinions). " +
				"Use this as the source of truth after batch-creating nodes, arranging layout, or BEFORE " +
				"claiming things like 'these nodes don't overlap' — the report, not your impression, is authoritative. " +
				"触发时机：用户问「节点有没有重叠/间距够不够/有没有超出」，或你准备向用户主张任何布局结论" +
				"（如「没重叠」「排列整齐」「分布均匀」）时，必须先调用本工具，以报告为准，不凭印象。 " +
				"Params: min_spacing (optional, px threshold, e.g. 20).",
			parameters: Type.Object({
				min_spacing: Type.Optional(
					Type.Number({ description: "最小间距阈值（px），如 20；缺省不判间距" }),
				),
			}),
			execute: async (_id, p: { min_spacing?: number }, _u, tc: LnkpiToolContext) => {
				let snapshot: LayoutSnapshot;
				try {
					snapshot = (await client.post("/agent/internal/get-canvas-layout", {
						sessionId: tc.sessionId,
					})) as LayoutSnapshot;
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									ok: false,
									error: `布局校验失败：画布布局读取不可用（${err instanceof Error ? err.message : String(err)}）。请勿编造校验结论。`,
								}),
							},
						],
						details: undefined,
					};
				}
				const raw = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
				const boxes: NodeBox[] = [];
				for (const n of raw) {
					if (typeof n?.id !== "string") continue;
					const x = n.absolutePosition?.x;
					const y = n.absolutePosition?.y;
					const w = n.size?.w;
					const h = n.size?.h;
					if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number")
						continue; // 形态异常节点跳过（fail-soft，不编造几何）
					boxes.push({ id: n.id, x, y, width: w, height: h });
				}
				const minSpacing =
					typeof p?.min_spacing === "number" && Number.isFinite(p.min_spacing) && p.min_spacing > 0
						? p.min_spacing
						: undefined;
				const violations = validateCanvasLayoutLocal({ nodes: boxes, minSpacing });
				const summary = formatViolationReport(boxes.length, violations);
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: true, data: { violations, summary } }) }],
					details: undefined,
				};
			},
		},
	];
}
