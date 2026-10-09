/**
 * D4 §4.5 判据**必须挂到 canvasCommands 的每条 command 上**（2026-10-09）。
 *
 * 🔴🔴 **本文件的存在理由是一次真实事故**：PR #321（`530c9efb`）把判据结果写进了
 * `content[0].text` —— 那是**给模型读的文本摘要**。而 Nest 侧 `extractCanvasCommands`
 * 只从 `result.details.canvasCommands` 提取命令（`apps/server/src/agent/pi-runtime/
 * pi-events.ts:311-340`）⇒ 前端 SSE 与落库 `executionEvents` **都拿不到该字段**，
 * 判据等于完全没下发，而当时 27/27 的生产断言全绿。
 *
 * ⛔ **每条否定式断言旁必须配有效性断言**，否则「拿到 `{}` 时不该存在 X」恒过且零证据
 * （上一版探针就是这么全 PASS 的）。本文件所有 `preferred` 断言都先断言
 * canvasCommands 真的非空、type 真的是那两种。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { presentResultDual, SVG_MAX_CHARS } from "./present-result.js";
import type { NodeGraphPayload } from "./types-node-graph.js";
import type { SvgCardPayload } from "./types-payload.js";

const svgPayload: SvgCardPayload = {
	type: "svg_card",
	svg: '<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>',
	title: "画布视图",
};
const nodeGraph: NodeGraphPayload = {
	type: "node_graph",
	title: "画布视图",
	nodes: [
		{ id: "n1", type: "image", title: "A", position: { x: 0, y: 0 } },
		{ id: "n2", type: "image", title: "B", position: { x: 10, y: 0 } },
	],
	edges: [{ source: "n1", target: "n2" }],
};

/** 取出双写产物里的两条 command，并**先证明它非空**（防空集假绿）。 */
function cmds(preferred: "svg_card" | "node_graph" | undefined, svg = svgPayload) {
	const res = presentResultDual(svg, nodeGraph, preferred);
	const cs = res.details.canvasCommands;
	// —— 有效性断言：不是空数组、type 就是这两种 ——
	assert.equal(Array.isArray(cs), true, "canvasCommands 不是数组");
	assert.equal(cs.length, 2, `期望双写 2 条，实际 ${cs.length}`);
	assert.deepEqual(
		cs.map((c) => c.type),
		["svg_card", "node_graph"],
		"双写顺序或类型变了，前端按 type 分派的契约被动过",
	);
	return {
		res,
		svgCard: cs[0] as SvgCardPayload & { preferredKind?: string },
		nodeGraphCmd: cs[1] as NodeGraphPayload & { preferredKind?: string },
	};
}

describe("presentResultDual：判据挂到 canvasCommands（真实下发通道）", () => {
	it("⛔ preferredKind 必须出现在 canvasCommands 里，而不是只在 content 文本里", () => {
		const { res, svgCard, nodeGraphCmd } = cmds("svg_card");
		// 有效性：两条 command 都真的带了这个字段（不是靠「不存在」蒙对）
		assert.equal(svgCard.preferredKind, "svg_card", "svg_card command 缺 preferredKind");
		assert.equal(
			nodeGraphCmd.preferredKind,
			"svg_card",
			"node_graph command 缺 preferredKind",
		);
		// 反向对照：content 文本里那个字段**不再**是唯一载体
		const summary = JSON.parse(res.content[0].text);
		assert.equal(summary.preferredPresentation, "svg_card");
	});

	it("判据选 node_graph 时，两条都标 node_graph（前端按 != type 跳过）", () => {
		const { svgCard, nodeGraphCmd } = cmds("node_graph");
		assert.equal(svgCard.preferredKind, "node_graph");
		assert.equal(nodeGraphCmd.preferredKind, "node_graph");
	});

	it("⛔ 两条必须同值：恰好一条与自身 type 不同（否则前端会把两条都跳过⇒ 空白）", () => {
		for (const kind of ["svg_card", "node_graph"] as const) {
			const { svgCard, nodeGraphCmd } = cmds(kind);
			const skipped = [
				svgCard.preferredKind !== "svg_card",
				nodeGraphCmd.preferredKind !== "node_graph",
			].filter(Boolean).length;
			assert.equal(
				skipped,
				1,
				`判据=${kind} 时被跳过的条数是 ${skipped}（0=都不渲染，2=都渲染）`,
			);
		}
	});

	it("省略第三参 ⇒ 默认 svg_card 优先（向后兼容，不改既有调用方语义）", () => {
		const res = presentResultDual(svgPayload, nodeGraph);
		const a = res.details.canvasCommands as Array<{ preferredKind?: string }>;
		assert.equal(a[0].preferredKind, "svg_card");
		assert.equal(a[1].preferredKind, "svg_card");
	});

	it("既有载荷字段一个不少（纯增量）", () => {
		const { svgCard, nodeGraphCmd } = cmds("svg_card");
		// svg_card 原 4 字段
		assert.equal(svgCard.type, "svg_card");
		assert.ok(svgCard.svg.includes("<rect"), "svg 丢了");
		assert.equal(svgCard.title, "画布视图");
		assert.deepEqual(svgCard.annotations, undefined, "不该凭空长出 annotations");
		// node_graph 原 4 字段
		assert.equal(nodeGraphCmd.type, "node_graph");
		assert.equal(nodeGraphCmd.nodes.length, 2);
		assert.equal(nodeGraphCmd.edges.length, 1);
		assert.equal(nodeGraphCmd.title, "画布视图");
	});
});

/**
 * 截断降级（**真实边界，不是假想**）：
 * `presentResultDual` 在 SVG 超 `SVG_MAX_CHARS` 时下发 `svg: ""`，前端
 * `AgentSvgCard` 会显示「已丢弃」降级卡。此时若仍把 `preferred` 给 svg_card，
 * 用户就只看到一句「已丢弃」——**而 node_graph 里其实有完整可交互的节点**。
 *
 * ⇒ 截断时判据必须翻转到 node_graph。这是有界失败 + 降级到另一条可用路，
 * 不是静默丢失。
 */
describe("presentResultDual：SVG 被截断时判据必须翻转", () => {
	const oversized: SvgCardPayload = {
		...svgPayload,
		svg: "x".repeat(SVG_MAX_CHARS + 1),
	};

	it("⛔ svg:\"\" 时 winner 必须翻成 node_graph（否则用户只看到「已丢弃」）", () => {
		const { svgCard, nodeGraphCmd } = cmds("svg_card", oversized);
		assert.equal(svgCard.svg, "", "前提不成立：oversized 没触发截断");
		assert.equal(
			svgCard.preferredKind,
			"node_graph",
			"被截断的 svg_card 不该再当 winner",
		);
		assert.equal(nodeGraphCmd.preferredKind, "node_graph", "截断时必须降级到 node_graph");
	});

	it("截断标记 truncated=true 仍照旧表达（不复用 ok）", () => {
		const res = presentResultDual(oversized, nodeGraph, "svg_card");
		assert.equal(res.details.truncated, true);
		assert.equal(JSON.parse(res.content[0].text).truncated, true);
	});

	it("未截断时判据不受影响（翻转只发生在真的被丢弃时）", () => {
		const atLimit: SvgCardPayload = { ...svgPayload, svg: "x".repeat(SVG_MAX_CHARS) };
		const res = presentResultDual(atLimit, nodeGraph, "svg_card");
		assert.equal(res.details.truncated, undefined, "正好等于上限不该算截断");
		assert.equal(
			(res.details.canvasCommands[0] as { preferredKind?: string }).preferredKind,
			"svg_card",
			"未截断时判据被误翻转了",
		);
	});
});
