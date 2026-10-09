/**
 * D4 §4.5 端到端：判据必须真的随载荷下发（2026-10-09）。
 *
 * ⭐ **这是本PR 的核心修复**：`node_graph` 无条件优先于 `svg_card`（前端
 * `PRESENTATION_KIND_PRIORITY`），而 `NodeGraphNode` 没有 severity/mark 字段
 * ⇒ 模型传了 `overlay` 时用户看到的是**没有任何严重度信息**的节点图。
 *
 *判据只能落在 `preferredPresentation` 这个字段上：
 * - ⛔ 不能改双写（`dualwrite.test.ts` 把「必须两条都发」锁成活契约）
 * - ⛔ 不能让前端自己判断（前端拿得到 `nodes.length`，但 `overlay.kind`
 *   不在这两条 command 的形状里 ⇒只有后端知道）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRenderCanvasViewTools } from "./render-canvas-view.js";

type Cmd = { type: string; svg?: string; nodes?: unknown[]; edges?: unknown[] };

type ToolResult = {
	content?: Array<{ type: string; text: string }>;
	details?: { canvasCommands?: Cmd[]; ok?: boolean };
};

async function callTool(
	params: Record<string, unknown>,
	nodeCount = 3,
): Promise<{ cmds: Cmd[]; summary: Record<string, unknown> }> {
	const nodes = Array.from({ length: nodeCount }, (_, i) => ({
		id: `img-${i}`,
		type: "image",
		title: `节点${i}`,
		position: { x: i * 100, y: 0 },
	}));
	const tools = createRenderCanvasViewTools({
		fetchLayout: async () => ({ nodes, edges: [] }),
	});
	const tool = tools[0];
	const res = (await tool.execute(
		"t1",
		params as never,
		() => {},
		{ sessionId: "s1" } as never,
		{} as never,
		{} as never,
	)) as ToolResult;
	const text = res.content?.[0]?.text ?? "{}";
	return { cmds: res.details?.canvasCommands ?? [], summary: JSON.parse(text) };
}

describe("D4 §4.5 端到端：preferredPresentation随载荷下发", () => {
	it("⛔ 带 overlay 时必须是 svg_card（否则 severity 视觉被节点图吃掉）", async () => {
		for (const kind of ["emotion", "budget", "severity"]) {
			// ⚠️ `view=timeline` 不是随意选的：**overlay 是行级指标，只在 timeline/table
			//   受支持**，默认的 `view=layout` 会直接 `fail()`（实测返回
			//   "overlay.kind=emotion not supported on view=layout"）⇒ 用 layout 测这条
			//   会拿到 ok:false，拿不到任何 command。
			const { cmds, summary } = await callTool({
				view: "timeline",
				overlay: { kind, data: [{ node_id: "img-0" }] },
			});
			assert.equal(summary.ok, true, `overlay=${kind} 时工具整体失败：${JSON.stringify(summary)}`);
			// 有效性断言：两条都还在（双写契约没被破坏）
			assert.deepEqual(
				cmds.map((c) => c.type),
				["svg_card", "node_graph"],
				`overlay=${kind} 破坏了双写契约`,
			);
			assert.equal(
				summary.preferredPresentation,
				"svg_card",
				`overlay=${kind} 的判据没下发或不对`,
			);
		}
	});

	it("⛔ 无 overlay、默认场景也必须是 svg_card（规格表最后一行）", async () => {
		const { summary } = await callTool({});
		assert.equal(summary.preferredPresentation, "svg_card");
	});

	it("⛔ 节点数 > 15 时必须是 svg_card", async () => {
		const { cmds, summary } = await callTool({}, 20);
		assert.deepEqual(cmds.map((c) => c.type), ["svg_card", "node_graph"]);
		assert.equal(summary.preferredPresentation, "svg_card", "20 个节点选了节点图");
	});

	it("⛔ 判据字段必须真的在载荷里（防「断言恒过」）", async () => {
		const { summary } = await callTool({});
		assert.ok(
			"preferredPresentation" in summary,
			`summary 里没有 preferredPresentation，实际字段: ${Object.keys(summary).join(",")}`,
		);
	});

	it("原有字段一个都不能少（纯增量，不是替换）", async () => {
		const { summary } = await callTool({});
		for (const k of ["ok", "type", "bytes", "truncated", "nodeGraph"]) {
			assert.ok(k in summary, `summary 丢了原有字段 ${k}`);
		}
	});
});

describe("D4 §4.5：interactive 入参接通 wantsInteractive（2026-10-10）", () => {
	/**
	 * ⭐ 背景：规格 §4.5 第三行「用户说『打开看看/点进去』⇒ 可交互节点图」
	 * 是节点图唯一的正当理由，但 `wantsInteractive` 此前恒为 undefined
	 * （工具读不到用户原话）。本 PR 把提取权交给模型——它本来就读得到用户
	 * 原话，通过新的 `interactive` 入参结构化传入，与 `overlay` 通道同构。
	 *
	 * ⛔ 语义（decidePresentation 已锁死，这里测的是接线）：
	 * - interactive=true 且无 overlay、无超量 ⇒ node_graph
	 * - interactive=true 压不过 overlay / 节点数 > 15（视觉不可退让）
	 * - interactive=false / 缺省 ⇒ svg_card（严格 `=== true`，防 truthy 误判：
	 *   字符串 "false"、数字 0 之类的脏数据都不得触发交互分支）
	 */

	it("interactive=true（无 overlay、3 节点）⇒ 节点图", async () => {
		const { cmds, summary } = await callTool({ interactive: true });
		assert.equal(summary.preferredPresentation, "node_graph", "模型显式传了交互意图，仍给静态图");
		// 双通道同值（#323 的契约：preferredKind 挂在两条 command 上，同值）
		for (const c of cmds) {
			assert.equal(
				(c as { preferredKind?: string }).preferredKind,
				"node_graph",
				`command ${c.type} 的 preferredKind 与判据不一致`,
			);
		}
	});

	it("⛔ interactive=true + overlay ⇒ 仍 svg_card（视觉不可退让）", async () => {
		const { summary } = await callTool({
			view: "timeline",
			overlay: { kind: "severity", data: [{ node_id: "img-0", level: "warn" }] },
			interactive: true,
		});
		assert.equal(summary.ok, true);
		assert.equal(summary.preferredPresentation, "svg_card", "交互意图压过了 overlay ⇒ severity 视觉又丢了");
	});

	it("⛔ interactive=true + 节点数 > 15 ⇒ 仍 svg_card", async () => {
		const { summary } = await callTool({ interactive: true }, 20);
		assert.equal(summary.preferredPresentation, "svg_card", "交互意图压过了节点数上限");
	});

	it("⛔ interactive=false / 字符串 'false' / 缺省 ⇒ 都必须 svg_card（严格判真）", async () => {
		for (const v of [false, "false", 0, undefined]) {
			const params = v === undefined ? {} : { interactive: v };
			const { summary } = await callTool(params);
			assert.equal(
				summary.preferredPresentation,
				"svg_card",
				`interactive=${JSON.stringify(v)} 触发了交互分支（truthy 误判）`,
			);
		}
	});

	it("schema 必须声明 interactive（可选 boolean，带提取指引）", () => {
		const tools = createRenderCanvasViewTools({ fetchLayout: async () => ({ nodes: [], edges: [] }) });
		const schema = (tools[0] as unknown as { parameters?: { properties?: Record<string, { type?: string; description?: string }> } }).parameters;
		assert.ok(schema, "工具没有 parameters schema（#320 教训：schema 在 .parameters）");
		const interactive = schema.properties?.interactive;
		assert.ok(interactive, `schema.properties 缺 interactive，实际字段: ${Object.keys(schema.properties ?? {}).join(",")}`);
		assert.equal(interactive.type, "boolean");
		assert.ok(
			interactive.description?.includes("interactive"),
			"description 必须写给模型看：什么时候传 true",
		);
	});
});
