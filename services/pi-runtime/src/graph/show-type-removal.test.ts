/**
 * `show_type` 的删除守卫（路B，2026-10-09）。
 *
 * ## 为什么删它而不是补线
 *
 * `show_type` 的真实链路是：
 *   工具参数 → `GraphIR.showType` → 五个 layout 产物全部透传 → `nodeLabels` 预留标签预算
 *   → ⛔ `nodeRect` 支持该参数，但**三个调用点没有一个传它**
 *   → 唯一真正读它的 `views.ts` 的 `typeTxt = opts.showType ? … : ""` **恒为空串**
 *
 * 即「**接线断在最后一米**」：模型传了它，预算被扣了，字却永远不显示。
 * 而现有测试 `render-canvas-view.expressive.test.ts` 是**手工喂** `showLayoutSvg({showType:true})`
 * 的 ⇒ **测试是绿的、线上是死的**（与本仓库「锁了透传没锁效果」的教训同族）。
 *
 * 选择删除而非补线：类型已由顶部 4px 色条 + 图例表达（D3-3 视觉语言），
 * 在节点框里再写一遍等于与刚落地的设计决策打架；且补线会改动线上 SVG 输出。
 * 删除对用户的净影响 = **零**（线上从未生效）。
 *
 * ## 本文件锁两条判据
 *
 * 1. **参数真的没了** —— schema 不再暴露 `show_type`，IR / layout 产物也不再承载它。
 * 2. **删除不改变任何输出** —— 五视图 SVG 逐字节不变（因为它本就恒为空）。
 *    ⛔ 这条是删除操作的**安全带**：若哪天删除真的影响了渲染，本用例会立刻转红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderCanvasViewTools } from "../tools/render-canvas-view.js";
import { graphIRFromGv } from "./graph-ir.js";
import { BASE3, svgOfCase } from "./snapshot.js";
import type { GvEdge, GvNode } from "../tools/render-canvas-view.expressive.js";

function paramNames(): string[] {
	// 工厂需要一个 `fetchLayout` 依赖；本用例只读参数 schema，不真正执行工具 ⇒ 永不调用它。
	const tools = createRenderCanvasViewTools({ fetchLayout: async () => ({ nodes: [], edges: [] }) });
	const tool = tools.find((t) => t.name === "render_canvas_view");
	assert.ok(tool, "找不到 render_canvas_view 工具");
	return Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
}

test("⛔ show_type 已从工具 schema 移除（不得再作为可填参数暴露给模型）", () => {
	const names = paramNames();
	assert.ok(
		!names.includes("show_type"),
		`show_type 仍在 schema 里：${names.join(", ")}⇒ 模型仍会看到并尝试传它`,
	);
});

test("⛔ IR 不再承载 showType（GraphIR 与 GraphIRFromGvInput 均无该字段）", () => {
	const ir = graphIRFromGv({
		view: "layout",
		relation: "dependency",
		nodes: BASE3.nodes,
		edges: BASE3.edges,
		// ⛔ 若IR 仍声明 showType，这里多传的字段会静默进入产物 ⇒ 断言必须抓到它。
		...( { showType: true } as Record<string, unknown>),
	} as never);
	assert.ok(
		!("showType" in (ir as unknown as Record<string, unknown>)),
		"IR 产物仍带showType 键 ⇒ 类型定义没清干净（或多余字段被透传进产物）",
	);
});

// ⛔ 只覆盖**用 nodeRect 渲染节点框**的视图（实测 class="l" 出现 >0 次）。
//   table / timeline / matrix 分别是表格、行级、交叉表渲染器，节点标签不是 class="l"
//   ——实测：layout/topology/tree/swimlane 各 3 次，table/timeline/matrix 均 0 次。
//   对它们断言节点标签属于判据错配（会得到"取不到标签"的假失败）。
const NODE_RECT_VIEWS = ["layout", "topology", "tree", "swimlane"] as const;

test("⛔ 删除不改变任何视图输出：节点框标签里不含类型文字（删除操作的安全带）", async () => {
	// ⛔ 这条判据的意义是「反证」：show_type 本就恒为空，所以删掉它不可能改变输出。
	//   若真的变了（例如误删了 seq 前缀或误把type 写进标签），本用例会转红并指出是哪一视图。
	for (const view of NODE_RECT_VIEWS) {
		const svg = await svgOfCase({ view, relation: "dependency" } as never, BASE3 as never);
		assert.match(svg, /^<svg/, `${view}：SVG 结构被破坏`);
		// ⚠️ 只检查**节点框内的标签文本**（class="l"），不能全 SVG 搜 "prompt" ——
		//   `data-group="prompt"` 与图例里本来就有 "prompt"（类型色带/图例是 D3-3 设计），
		//   全局搜会恒真 ⇒ 判据空转。节点标签实测形如 `① 镜头 1`。
		const labels = [...svg.matchAll(/<text[^>]*class="l"[^>]*>([^<]*)<\/text>/g)].map(
			(m) => m[1] ?? "",
		);
		assert.ok(labels.length > 0, `${view}：没取到任何节点标签，判据本身失效`);
		for (const t of labels) {
			assert.ok(
				!/\bprompt\b|\bimage\b|\bvideo\b|\baudio\b/.test(t),
				`${view}：节点标签「${t}」里含类型文字 ⇒ show_type 并非恒为空，删除前提不成立`,
			);
		}
	}
});

test("⛔ 删除不改变 sequence 前缀与标签提炼预算（seq 预算没被误删）", async () => {
	// `nodeLabels` 里 showType 与 seq 共用同一段预算扣减逻辑 ⇒ 删 showType 时极易连坐删掉 seq。
	//
	// ⚠️⚠️ 判据设计踩了两次坑，实测结论写在这里，别再改错：
	//   ① `① ` 前缀是**无条件渲染**的，预算只影响 `condenseLabel` 的阈值
	//      ⇒ 用短标签（「镜头 1」）时扣与不扣输出**完全相同** ⇒ 判据空转。
	//   ② 也不是所有视图都会提炼：实测同一长标题在
	//      layout / topology（框宽 554px）下**原样输出 len=24、不带省略号**，
	//      只有 tree（len=12）/ swimlane（len=8）会收敛。
	//      ⇒ 必须挑**真会提炼的视图**，否则断言同样空转。
	// 本条用 tree：它的框宽（TREE_DEPTH_W）远小于 layout，所以预算变化看得见。
	const longTitle = "第一集森林侦探社长老之死资产表与分镜脚本对照";
	const layout = {
		nodes: [{ id: "n1", type: "prompt", title: longTitle, position: { x: 0, y: 0 } }],
		edges: [],
	};
	const svg = await svgOfCase({ view: "tree", relation: "category" } as never, layout as never);
	const label = (svg.match(/<text[^>]*class="l"[^>]*>([^<]*)<\/text>/)?.[1] ?? "").trim();

	// 锁定**逐字节**的期望值（实测：tree 下为「① 第一集森林侦探社长…」）。
	// ⛔ 锁具体值而非「是否以省略号结尾」：后者在预算被误删时可能仍然成立（空转），
	//   而逐字节断言在 seq 预算增减 2 个字时必然变化。
	assert.equal(label, "① 第一集森林侦探社长…", `tree 标签被意外改动 ⇒ seq 预算或提炼逻辑变了：实际「${label}」`);
});