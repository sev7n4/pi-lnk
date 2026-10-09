/**
 * 只读可视投影（tier="present"）的统一返回构造器。
 *
 * ⚠️ `canvasCommands` **必须**在 `details` 下：Nest 侧 `extractCanvasCommands`
 * 只从 `tool_execution_end.result.details.canvasCommands` / `tool_execution_update
 * .partialResult.details.canvasCommands` 提取（apps/server/src/agent/pi-runtime/
 * pi-events.ts:297-326）。放回 content 会被模型当文本读、卡片不落屏——
 * 与 `result-with-actions.ts` 文件头记录的 PR #65 同款失败模式。
 * 故 `content` 只回摘要（`type` / `title` / `bytes` / `truncated`），**不回载荷本体**。
 *
 * 语义约定：`ok` 恒为 true（工具本身成功执行）。截断只经 `truncated` 表达、**不复用 `ok`**
 * ——本项目里 `ok:false` 一律读作「工具失败、agent 该重试」，而截断不是失败。
 */
import type { SvgCardPayload } from "./types-payload.js";

/**
 * SVG 长度上界：超界的载荷被**整块丢弃**（`svg: ""` + `truncated: true`），前端降级为 `pre` 占位。
 *
 * 不做部分渲染是有意的：`slice` 会从标签/属性中间切断并丢掉 `</svg>`，产出无法解析的
 * XML，下游渲染卡拿到就崩。本构造器是通用载荷容器、**不解析 SVG 结构**；保证产物
 * 良构是 Task 2 各 `build*` 函数的职责（它们应在界内产出良构 SVG）。
 */
export const SVG_MAX_CHARS = 20000;

export function presentResult(payload: SvgCardPayload): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: SvgCardPayload[]; truncated?: boolean };
} {
	const truncated = payload.svg.length > SVG_MAX_CHARS;
	const svg = truncated ? "" : payload.svg;
	const clipped: SvgCardPayload = { ...payload, svg };
	const details: {
		ok: true;
		canvasCommands: SvgCardPayload[];
		truncated?: boolean;
	} = { ok: true, canvasCommands: [clipped] };
	if (truncated) details.truncated = true;
	return {
		content: [
			{
				type: "text",
				// ⚠️ 必须是 JSON：既有测试用 `JSON.parse(r.content[0].text)` 断言字段
				//   （`present-result.test.ts` 的 summary()）。改成自然语言会让它抛
				//   `Unexpected token` ⇒ 破坏性变更。别"优化"这个文案。
				text: JSON.stringify({
					ok: true,
					type: payload.type,
					...(payload.title ? { title: payload.title } : {}),
					bytes: clipped.svg.length,
					truncated,
				}),
			},
		],
		details,
	};
}
/**
 * 双写版（2026-10-07）：同时产出 `svg_card` 与 `node_graph`。
 *
 * ⚠️ **为什么双写**：`node_graph` 是给前端节点图库（Vue Flow）用的结构化载荷，
 * 而 `svg_card` 是 717 行手写 SVG 的产物。前端尚未接`node_graph` 时，多出来的 command
 * 会被 `AgentSideRail` 忽略（无害）⇒ 可以**先上后端、前端后接**，不必等前端就绪。
 * 等前端灰度验证通过，再把 `svg_card` 那条路删掉。
 */
export function presentResultDual(
	payload: SvgCardPayload,
	nodeGraph: import("./types-node-graph.js").NodeGraphPayload,
	/**
	 * D4 §4.5 呈现分工的判据结果（`decidePresentation` 的返回值）。
	 *
	 * ⚠️ **为什么下发而不是后端单发**：`render-canvas-view.dualwrite.test.ts`
	 * 把「成功时**同时**产出两条 command」锁成了活契约（前端按 `type` 分派，
	 * 少一条会静默什么都不渲染）。所以这里**保留双写**，只把「该显示哪个」的
	 * 结论交给前端。
	 *
	 * ⭐ 不这样做会导致**视觉信息静默丢失**：`NodeGraphNode` 没有 severity/mark
	 * 字段（见 `node-graph-payload.ts` 的 `toNodeGraphNode`），而前端
	 * `PRESENTATION_KIND_PRIORITY` 让 `node_graph` 无条件赢
	 * （`apps/web/src/stores/agent.ts:219-222`）⇒ 模型传了 `overlay` 时，
	 * 静态图里的 `data-sev` / ERROR·WARN 配色 / 图例全被丢掉。
	 *
	 * ⛔ **不能靠前端自己判断 overlay**：前端拿得到节点数，但拿不到 `overlay.kind`
	 * （它不在这两条 command 的形状里）⇒ 只有后端知道。所以判据必须在后端算。
	 */
	preferred: import("./presentation-decision.js").PresentationKind = "svg_card",
): {
	content: [{ type: "text"; text: string }];
	details: {
		ok: true;
		canvasCommands: (SvgCardPayload | import("./types-node-graph.js").NodeGraphPayload)[];
		truncated?: boolean;
	};
} {
	const truncated = payload.svg.length > SVG_MAX_CHARS;
	const svg = truncated ? "" : payload.svg;
	const clipped: SvgCardPayload = { ...payload, svg };
	const details: {
		ok: true;
		canvasCommands: (SvgCardPayload | import("./types-node-graph.js").NodeGraphPayload)[];
		truncated?: boolean;
	} = { ok: true, canvasCommands: [clipped, nodeGraph] };
	if (truncated) details.truncated = true;
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					ok: true,
					type: payload.type,
					...(payload.title ? { title: payload.title } : {}),
					bytes: clipped.svg.length,
					truncated,
					// D4 §4.5：把「该显示哪个」显式告诉前端，别让前端的固定优先级
					// 无条件选 node_graph（那会丢掉 overlay 的 severity 视觉）。
					preferredPresentation: preferred,
					// 双写时带上 node_graph 的规模，让模型知道结构化载荷已就绪
					nodeGraph: {
						nodes: nodeGraph.nodes.length,
						edges: nodeGraph.edges.length,
						...(nodeGraph.totalNodeCount != null
							? { totalNodeCount: nodeGraph.totalNodeCount }
							: {}),
					},
				}),
			},
		],
		details,
	};
}
