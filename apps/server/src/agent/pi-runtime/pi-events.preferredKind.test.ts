/**
 * D4 §4.5 判据字段的**Nest 侧透传**（2026-10-09）。
 *
 * 🔴🔴 **本文件是一次真实事故的守卫**。PR #321（`530c9efb`）把判据结果写进了
 * `result.content[0].text` —— 那是给**模型**读的文本摘要。`extractCanvasCommands`
 * 一条命令都不从 `content` 提取（只读 `result.details.canvasCommands`）⇒ 前端 SSE 与
 * 落库 `executionEvents` **都拿不到判据**，功能是死的，而当时 27/27 生产断言全绿。
 *
 * ⭐ 本文件锁的是「字段真的穿过 Nest 到达事件」这件事本身，与 pi-runtime 侧的
 * 生产测试、apps/web 侧的组件测试构成一条完整链路：
 * `decidePresentation` → `canvasCommands[i].preferredKind` → **本文件** → SSE 事件 → 前端。
 * 少任何一段，那一段就是黑盒。
 *
 * ⛔ 每条断言都配有效性断言（先证明确实提取到了命令），避免「拿到 [] 时断言字段不存在」恒过。
 */
import { describe, expect, it } from "vitest";
import { extractCanvasCommands, type PiRuntimeEvent } from "./pi-events";

const toolEnd = (result: unknown, isError = false): PiRuntimeEvent =>
	({
		type: "tool_execution_end",
		ts: Date.now(),
		data: { toolCallId: "c1", toolName: "render_canvas_view", result, isError },
	}) as never;

const toolUpdate = (partialResult: unknown): PiRuntimeEvent =>
	({
		type: "tool_execution_update",
		ts: Date.now(),
		data: { toolCallId: "c1", toolName: "render_canvas_view", partialResult },
	}) as never;

/** 与 `presentResultDual` 产物同形的双写命令。 */
function dualDetails(preferredKind: "svg_card" | "node_graph") {
	return {
		content: [
			{
				type: "text",
				//⚠️ 这份文本里**也**有 preferredPresentation（给模型看的），
				// 故意保留，用来证明它**不**是前端的通道。
				text: JSON.stringify({ ok: true, preferredPresentation: preferredKind }),
			},
		],
		details: {
			ok: true,
			canvasCommands: [
				{ type: "svg_card", svg: "<svg/>", title: "画布", preferredKind },
				{
					type: "node_graph",
					title: "画布",
					nodes: [{ id: "n1", type: "image", title: "A" }],
					edges: [],
					preferredKind,
				},
			],
		},
	};
}

describe("extractCanvasCommands：preferredKind 必须真的穿过 Nest", () => {
	it("⛔ 判据字段在 tool_execution_end 路径上存活（end 是主路径）", () => {
		const cmds = extractCanvasCommands(toolEnd(dualDetails("svg_card")));

		// —— 有效性断言：确实提取到两条（否则下面的字段断言是空集假绿）——
		expect(Array.isArray(cmds)).toBe(true);
		expect(cmds).toHaveLength(2);
		expect(cmds.map((c) => c.type)).toEqual(["svg_card", "node_graph"]);

		// —— 真断言：两条都带着同一个 winner 值，且**没被剥掉**——
		expect(cmds.every((c) => c.preferredKind === "svg_card")).toBe(true);
	});

	it("⛔ 判据字段在 tool_execution_update 路径上也存活（update 是另一条入口）", () => {
		// B-6 既有事实：阻塞卡片只在 update 快照里。若只修了 end 路径，update 路径
		// 仍会丢字段 ⇒ 前端拿到 undefined ⇒ 静默退回旧行为。
		const cmds = extractCanvasCommands(toolUpdate(dualDetails("node_graph")));
		expect(cmds).toHaveLength(2);
		expect(cmds.every((c) => c.preferredKind === "node_graph")).toBe(true);
	});

	it("⛔ 判据不是从 content 文本里提取的（锁住通道，避免有人改成读 content）", () => {
		const cmds = extractCanvasCommands(toolEnd(dualDetails("svg_card")));
		// content 里明明写着 preferredPresentation: "svg_card"，但提取结果不该
		// 出现这个**键**（我们的字段名是 preferredKind，且来源是 details.canvasCommands）。
		expect(Object.keys(cmds[0])).not.toContain("preferredPresentation");
	});

	it("⛔ 判据为 node_graph 时 svg_card 那条也带 node_graph（同值契约）", () => {
		const cmds = extractCanvasCommands(toolEnd(dualDetails("node_graph")));
		expect(cmds[0]?.type).toBe("svg_card");
		// 两条同值 ⇒ 前端「preferredKind !== type ⇒ 跳过」只需一句、无状态
		expect(cmds[0]?.preferredKind).toBe("node_graph");
		expect(cmds[1]?.preferredKind).toBe("node_graph");
	});

	it("既有载荷字段一个不少（纯增量，没顺手改坏别的）", () => {
		const cmds = extractCanvasCommands(toolEnd(dualDetails("svg_card")));
		const svgCmd = cmds[0] as { svg?: string; title?: string };
		expect(svgCmd.svg).toBe("<svg/>");
		expect(svgCmd.title).toBe("画布");
		const ngCmd = cmds[1] as { nodes?: unknown[]; edges?: unknown[] };
		expect(ngCmd.nodes).toHaveLength(1);
		expect(ngCmd.edges).toEqual([]);
	});

	it("旧命令（无 preferredKind）原样通过，不被加工也不被丢弃", () => {
		const cmds = extractCanvasCommands(
			toolEnd({
				content: [],
				details: {
					ok: true,
					canvasCommands: [
						{ type: "focus_node", nodeId: "n1" },
						{ type: "undo" },
					],
				},
			}),
		);
		expect(cmds).toEqual([
			{ type: "focus_node", nodeId: "n1" },
			{ type: "undo" },
		]);
		expect(cmds.every((c) => c.preferredKind === undefined)).toBe(true);
	});
});
