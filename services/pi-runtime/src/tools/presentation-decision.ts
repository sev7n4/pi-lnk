/**
 * D4 §4.5 呈现分工的**纯判据**（2026-10-09）。
 *
 * ⭐ **它解决的是真实缺陷，不是文档滞后**：
 * `presentResultDual` 无条件双写 `svg_card` + `node_graph`，前端
 * `PRESENTATION_KIND_PRIORITY` 让 `node_graph` 总是赢（rank 2 > 1）⇒ **只要模型传了
 * `overlay`，D3-3 那套 severity 视觉（`data-sev` + ERROR/WARN 配色 + 图例）就被丢弃**，
 * 而 `NodeGraphNode` 根本没有 severity/mark 字段承载它。
 *
 * ⚠️ **本模块是纯函数，不发事件、不看 IO**——判据必须能被单测钉死。
 * 接线在 `render-canvas-view.ts`（把双写改成按此判据选）。
 */

/** 节点数超过此值 ⇒ 静态图（规格 §4.5 第二行）。 */
export const PRESENTATION_NODE_GRAPH_MAX_NODES = 15;

export type PresentationKind = "svg_card" | "node_graph";

export interface PresentationInput {
	/** 画布节点（只读数量与形态，不改内容）。 */
	nodes?: ReadonlyArray<unknown> | undefined;
	/**
	 * 工具入参里的 `overlay`。
	 *
	 * ⛔ **只要这个字段存在就走静态图**，不看 `data` 是否有内容——
	 * 模型可能传空数组，而视觉语言仍已按 overlay 渲染过；用「有内容」当判据
	 * 会让「传了空 overlay」静默落到节点图，是一条静默降级路径。
	 */
	overlay?: { kind: string; data?: unknown } | undefined;
	/**
	 * 用户是否说了「打开看看 / 点进去」这类**显式的可交互意图**。
	 *
	 * ⛔ 这是节点图**唯一**的正当理由（规格 §4.5 第三行）。
	 * 它**不能**压过 overlay 与节点数——那两行排在前面是因为可交互会让视觉信息退让。
	 */
	wantsInteractive?: boolean | undefined;
}

/**
 * 按规格 §4.5 选呈现形态。
 *
 * 优先级顺序即表格行序（先命中先返回）：
 * 1. 有 overlay → 静态图（视觉不可退让）
 * 2. 节点数 > 15 → 静态图
 * 3. 显式要交互 → 节点图
 * 4. 默认 → 静态图
 */
export function decidePresentation(input: PresentationInput): PresentationKind {
	if (input.overlay !== undefined && input.overlay !== null) return "svg_card";
	const count = Array.isArray(input.nodes) ? input.nodes.length : 0;
	if (count > PRESENTATION_NODE_GRAPH_MAX_NODES) return "svg_card";
	if (input.wantsInteractive === true) return "node_graph";
	return "svg_card";
}
