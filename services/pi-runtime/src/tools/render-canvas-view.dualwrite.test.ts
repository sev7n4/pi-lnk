/**
 * 双写端到端断言（2026-10-07）：`render_canvas_view` 成功时**同时**产出
 * `svg_card` 与 `node_graph` 两个 command。
 *
 * 为什么要锁：
 * 1. 前端 PR 会按 `type === "node_graph"` 分派；后端哪天不小心只发 svg_card，
 *    前端会**静默**什么都不渲染（无报错）—— 这类"少一个type"的退化最难查。
 * 2. `svg_card` 那条路必须**逐字节不变**（前端旧路径还在用）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRenderCanvasViewTools } from "./render-canvas-view.js";

type Cmd = { type: string; svg?: string; nodes?: unknown[]; edges?: unknown[] };

async function callTool(params: Record<string, unknown>): Promise<Cmd[]> {
	const tools = createRenderCanvasViewTools({
		fetchLayout: async () => ({
			nodes: [
				{ id: "img-1", type: "image", title: "角色三视图", position: { x: 10, y: 20 } },
				{ id: "img-2", type: "image", title: "场景", position: { x: 300, y: 20 } },
				{ id: "group-1", type: "group", title: "角色组" },
				{ id: "img-3", type: "image", title: "在组里", parentNode: "group-1" },
			],
			edges: [{ source: "img-1", target: "img-2" }],
		}),
	});
	const tool = tools[0];
	// ⚠️ 第 4 个参数才是 toolContext（`{sessionId}`）—— 传undefined 会让
	//   工具内部 `tc.sessionId` 抛 "Cannot read properties of undefined"。
	const res = (await tool.execute("t1", params as never, () => {}, { sessionId: "s1" } as never, {} as never, {} as never)) as {
		details?: { canvasCommands?: Cmd[]; ok?: boolean };
	};
	return res.details?.canvasCommands ?? [];
}

describe("render_canvas_view 双写（2026-10-07）", () => {
	it("成功时同时产出 svg_card 与 node_graph", async () => {
		const cmds = await callTool({});
		const types = cmds.map((c) => c.type);
		assert.ok(types.includes("svg_card"), "旧路径 svg_card 必须保留（前端还在用）");
		assert.ok(types.includes("node_graph"), "必须有 node_graph（前端 Vue Flow 的数据源）");
	});

	it("svg_card 载荷逐字不变（type + svg 字符串）", async () => {
		const cmds = await callTool({});
		const svg = cmds.find((c) => c.type === "svg_card");
		assert.ok(svg?.svg && svg.svg.length > 0, "svg 必须非空（前端旧路径依赖它）");
	});

	it("node_graph 载荷含全部画布节点（不被 p.node_ids 过滤）", async () => {
		const cmds = await callTool({ node_ids: ["img-1"] });
		const ng = cmds.find((c) => c.type === "node_graph") as { nodes?: Array<{ id: string }> } | undefined;
		assert.ok(ng?.nodes);
		// 节点图的语义是"画布上有什么"，不是"这一个问题相关的那几个"
		assert.equal(ng.nodes.length, 4, "应包含全部 4 个节点（含 group）");
		assert.ok(ng.nodes.some((n) => n.id === "img-3"), "含被 parentNode 分组的节点");
	});

	it("node_graph 的 parentNode 映射为 groupId", async () => {
		const cmds = await callTool({});
		const ng = cmds.find((c) => c.type === "node_graph") as
			| { nodes?: Array<{ id: string; groupId?: string }> }
			| undefined;
		const n3 = ng?.nodes?.find((n) => n.id === "img-3");
		assert.equal(n3?.groupId, "group-1");
	});

	it("失败路径（node_ids 不存在）不产出任何 command", async () => {
		const cmds = await callTool({ node_ids: ["不存在"] });
		assert.equal(cmds.length, 0, "fail() 应走isError 路径而不是双写");
	});
});