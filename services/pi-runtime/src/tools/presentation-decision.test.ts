/**
 * D4 §4.5 呈现分工的判据测试（2026-10-09）。
 *
 * ⭐ **为什么需要它（真实缺陷，不是文档滞后）**：
 * 取证结论——`presentResultDual` **无条件双写** `svg_card` + `node_graph`，
 * 而前端 `stores/agent.ts` 的 `PRESENTATION_KIND_PRIORITY` 让 `node_graph` **总是赢**
 * （rank 2 > 1，见该文件 219-222行）。于是：
 *
 *   只要模型传了 `overlay`（emotion/budget/severity），静态图里那套D3-3 视觉语言
 *   （`data-sev` 属性 + ERROR/WARN 配色 + 图例）**全部被丢弃**，用户最终看到的是
 *   一张**没有任何严重度信息**的节点图——因为 `NodeGraphNode` 只有
 *   id/type/title/position/size/groupId/status，**根本没有 severity/mark 字段**
 *   （见 `node-graph-payload.ts` 的 `toNodeGraphNode`）。
 *
 * 规格 §4.5 的第一行「需要 overlay ⇒ 静态图」正是为拦住这件事而写。
 * 第三行「用户说『打开看看/点进去』⇒ 可交互节点图」是节点图**唯一**的正当理由。
 *
 * 判据表（规格 §4.5 原文）：
 *   | 需要 overlay（情绪/预算/严重度） | 静态图 |
 *   | 节点数 > 15| 静态图 |
 *   | 用户说「打开看看 / 点进去」     | 可交互节点图 |
 *   | 默认                            | 静态图 |
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { decidePresentation } from "./presentation-decision.js";

/** 造一条最小的画布节点（只有 id/title 是必需的）。 */
const n = (id: string) => ({ id, title: id });

describe("D4 §4.5 呈现分工：overlay 判据", () => {
	test("⛔ 带 overlay 时必须选静态图（否则 D3-3 的 severity 视觉被丢弃）", () => {
		for (const kind of ["emotion", "budget", "severity"] as const) {
			assert.equal(
				decidePresentation({ nodes: [n("a"), n("b")], overlay: { kind, data: {} } }),
				"svg_card",
				`overlay=${kind} 时选了节点图⇒ severity/预算/情绪视觉信息全部丢失`,
			);
		}
	});

	test("overlay.data 为空数组也算「带了 overlay」⇒ 仍选静态图", () => {
		// ⛔ 防「空数据=没传」的偷懒判据：模型可能传空数组，此时视觉语言仍已按 overlay 渲染。
		assert.equal(
			decidePresentation({ nodes: [n("a")], overlay: { kind: "severity", data: [] } }),
			"svg_card",
		);
	});
});

describe("D4 §4.5 呈现分工：节点数判据", () => {
	test("⛔ 节点数 > 15 时必须选静态图", () => {
		const nodes = Array.from({ length: 16 }, (_, i) => n(`n${i}`));
		assert.equal(decidePresentation({ nodes }), "svg_card", "16 个节点选了节点图");
	});

	test("节点数 = 15 时不触发该判据（边界含15）", () => {
		const nodes = Array.from({ length: 15 }, (_, i) => n(`n${i}`));
		// 15 刚好不> 15 ⇒ 不因数量落到静态图；但默认也是静态图，
		// 所以这里用「显式要看」来区分，证明它走的是可交互分支。
		assert.equal(decidePresentation({ nodes, wantsInteractive: true }), "node_graph");
	});
});

describe("D4 §4.5 呈现分工：可交互的唯一正当理由", () => {
	test("用户说「打开看看/点进去」⇒ 节点图（且无 overlay、无超量）", () => {
		assert.equal(decidePresentation({ nodes: [n("a"), n("b")], wantsInteractive: true }), "node_graph");
	});

	test("⛔ 即使显式要看，overlay 仍然优先（视觉不可退让）", () => {
		// 这一条是本测试文件的核心：规格表里overlay 行排第一，且不可被第三行覆盖。
		assert.equal(
			decidePresentation({
				nodes: [n("a"), n("b")],
				overlay: { kind: "severity", data: {} },
				wantsInteractive: true,
			}),
			"svg_card",
			"显式的『打开看看』压过了 overlay ⇒ 严重度信息又丢了",
		);
	});

	test("⛔ 即使显式要看，节点数 > 15 仍然优先", () => {
		const nodes = Array.from({ length: 40 }, (_, i) => n(`n${i}`));
		assert.equal(decidePresentation({ nodes, wantsInteractive: true }), "svg_card");
	});
});

describe("D4 §4.5 呈现分工：默认", () => {
	test("⛔ 默认必须是静态图（规格表最后一行）", () => {
		assert.equal(decidePresentation({ nodes: [n("a"), n("b")] }), "svg_card");
	});

	test("⛔ 空输入也必须是静态图，且不得抛（前端会把双写都发过来）", () => {
		assert.equal(decidePresentation({ nodes: [] }), "svg_card");
		assert.equal(decidePresentation({}), "svg_card");
	});
});
