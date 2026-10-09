import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRenderCanvasViewTools } from "../tools/render-canvas-view.js";
import type { GvEdge, GvNode } from "../tools/render-canvas-view.expressive.js";

/**
 * `render_canvas_view` 的黄金快照。
 *
 * ⛔ 存在的理由：D2 的验收判据是「对外输出逐字节不变」，但仓库里**没有任何快照设施**
 * （既有测试全是 `assert.match` 片段匹配）。没有迁移前采下来的基线，这条判据无法证明 ——
 * 只能凭感觉说「应该没变」。所以本文件必须在任何搬迁动作**之前**生成基线。
 */

export interface GoldenCase {
	/** 稳定标识：改了它就必须重新生成基线并在提交信息里说明理由。 */
	name: string;
	params: Record<string, unknown>;
	layout: { nodes: GvNode[]; edges: GvEdge[] };
	svg: string;
}

export interface GoldenFile {
	/** 生成时的 HEAD，便于 reviewer 知道基线来自哪个提交。 */
	commit: string;
	cases: GoldenCase[];
}

/** 3 节点基线：layout / topology / timeline / table 共用。 */
export const BASE3: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{ id: "n1", type: "prompt", title: "镜头 1", position: { x: 0, y: 0 } },
		{ id: "n2", type: "prompt", title: "镜头 2", position: { x: 100, y: 0 } },
		{ id: "n3", type: "prompt", title: "镜头 3", position: { x: 200, y: 0 } },
	],
	edges: [{ source: "n1", target: "n2" }],
};

/** 5 节点树：含真实父子关系（tree / swimlane 用）。 */
export const TREE5: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{ id: "n1", type: "outline", title: "大纲", position: { x: 0, y: 0 } },
		{ id: "n2", type: "ep", title: "EP01", parentNode: "n1", position: { x: 0, y: 100 } },
		{ id: "n3", type: "ep", title: "EP02", parentNode: "n1", position: { x: 0, y: 200 } },
		{ id: "n4", type: "ep", title: "EP03", parentNode: "n2", position: { x: 0, y: 300 } },
		{ id: "n5", type: "ep", title: "EP04", parentNode: "n2", position: { x: 0, y: 400 } },
	],
	edges: [
		{ source: "n1", target: "n2" },
		{ source: "n1", target: "n3" },
		{ source: "n2", target: "n4" },
		{ source: "n2", target: "n5" },
	],
};

/** 6 节点混合：两个维度都 ≥2 个取值（matrix 的 rowBy/colBy 需要）。 */
export const MIXED6: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{ id: "m1", type: "a", status: "todo", title: "甲", position: { x: 0, y: 0 } },
		{ id: "m2", type: "a", status: "done", title: "乙", position: { x: 100, y: 0 } },
		{ id: "m3", type: "b", status: "todo", title: "丙", position: { x: 200, y: 0 } },
		{ id: "m4", type: "b", status: "done", title: "丁", position: { x: 300, y: 0 } },
		{ id: "m5", type: "c", status: "todo", title: "戊", position: { x: 400, y: 0 } },
		{ id: "m6", type: "c", status: "done", title: "己", position: { x: 500, y: 0 } },
	],
	edges: [{ source: "m1", target: "m3" }],
};

/**
 * 长标题 fixture —— **专门覆盖 D3-2 的提炼路径**。
 *
 * ⭐ 为什么必须有它：原有 8 个 fixture 的标题全是短中文（`镜头 1` / `EP01` / `甲`），
 *全在各自视图的预算内 ⇒ 提炼是 no-op，快照**逐字节不变**。
 * 也就是说：快照全绿**证明不了提炼是否正确**，这里必须有一个真会触发的样本。
 *
 * 三个标题分别超出所在视图的预算：layout(45 汉字) / tree(11 汉字) / swimlane(8 汉字)。
 * 外加一个**中英混排**样本 —— 迁移前的 `clip()` 按字符数截，算不准混排的像素宽。
 *
 * ⭐⭐ 全部节点都带 `· 雨夜编` 这个**共有后缀** —— 这让 `shortLabels` 真的会剥。
 *   我第一版 fixture 没有共有后缀，于是变异「跳过 shortLabels」**测不出来**：
 *   没有后缀可剥，两条路径输出一模一样。⇒ 判据要覆盖「先剥后缀、再提炼」的**顺序**。
 *   L4 剥完剩 9 汉字（18 单位 ≤ 22）⇒ 顺序反了会被先提炼砍到 14 汉字，标签就变了。
 */
export const LONG_TITLES: { nodes: GvNode[]; edges: GvEdge[] } = {
	nodes: [
		{
			id: "L1",
			type: "prompt",
			// 69 汉字 = 138 单位 > layout 预算 90
			title: "第一章少年在雨夜的老宅里发现祖父留下的那本没有署名的黑色笔记本里面夹着一张褪色的车票 · 雨夜编",
			position: { x: 0, y: 0 },
		},
		{
			id: "L2",
			type: "prompt",
			// 69 汉字，同样超 tree(11) / swimlane(8) 预算
			title: "第二章少女在旧书店的阁楼里翻到那本笔记的残页发现墨迹下面还压着另一层被刮掉的字迹 · 雨夜编",
			position: { x: 100, y: 0 },
		},
		{
			id: "L3",
			type: "image",
			// 中英混排：单位宽与字符数不等价，旧 clip 会算错
			title: "Scene 04A雨夜老宅 · 内景 · 手持笔记本特写 · 缓慢推进 · 无对白 · ENV: rain · 雨夜编",
			position: { x: 200, y: 0 },
		},
		{
			id: "L4",
			type: "prompt",
			// 刚好在 tree 预算内（9 汉字 = 18 单位 ≤ 22）⇒ **不该被提炼**
			title: "第三章收尾与回望",
			position: { x: 300, y: 0 },
		},
	],
	edges: [
		{ source: "L1", target: "L2" },
		{ source: "L2", target: "L3" },
	],
};

export function goldenFixtures(): Array<Omit<GoldenCase, "svg">> {
	return [
		{ name: "layout-dependency", params: { view: "layout", relation: "dependency" }, layout: BASE3 },
		{ name: "layout-category", params: { view: "layout", relation: "category" }, layout: BASE3 },
		{ name: "topology-legacy", params: { view: "topology" }, layout: BASE3 },
		{ name: "tree", params: { view: "tree" }, layout: TREE5 },
		{ name: "timeline", params: { view: "timeline" }, layout: BASE3 },
		{ name: "swimlane-type", params: { view: "swimlane", groupBy: "type" }, layout: TREE5 },
		{ name: "matrix-type-status", params: { view: "matrix", rowBy: "type", colBy: "status" }, layout: MIXED6 },
		// D3-2：提炼路径的快照样本（短标题用例证明不了提炼，见 LONG_TITLES 注释）
		{ name: "layout-long-titles", params: { view: "layout", relation: "dependency" }, layout: LONG_TITLES },
		{ name: "tree-long-titles", params: { view: "tree" }, layout: LONG_TITLES },
		{ name: "swimlane-long-titles", params: { view: "swimlane", groupBy: "type" }, layout: LONG_TITLES },
		{
			name: "table-legacy-overlay",
			// OverlayItem.level 是字符串枚举（"error" / "warn"），不是数字。
			params: { view: "table", overlay: { kind: "severity", data: [{ node_id: "n1", level: "error" }] } },
			layout: BASE3,
		},
	];
}

/** 跑一次工具并取回 SVG；失败时抛出（不静默返回空串）。 */
export async function svgOfCase(
	params: Record<string, unknown>,
	layout: { nodes: GvNode[]; edges: GvEdge[] },
): Promise<string> {
	const tools = createRenderCanvasViewTools({ fetchLayout: async () => layout as never });
	const tool = tools.find((t) => t.name === "render_canvas_view")!;
	const r = await tool.execute("call-1", params as never, () => {}, { sessionId: "s1" }, {} as never, {} as never);
	const d = r.details as { ok: boolean; error?: string; canvasCommands?: Array<{ svg: string }> };
	assertOk(d, params);
	return d.canvasCommands![0].svg;
}

function assertOk(
	d: { ok: boolean; error?: string; canvasCommands?: Array<{ svg: string }> },
	params: Record<string, unknown>,
): void {
	if (!d.ok || !d.canvasCommands?.[0]?.svg) {
		throw new Error(`用例 ${JSON.stringify(params)} 未产出 svg：${d.error ?? "canvasCommands 为空"}`);
	}
}

export async function captureGolden(commit: string): Promise<GoldenFile> {
	const cases: GoldenCase[] = [];
	for (const fx of goldenFixtures()) {
		cases.push({ ...fx, svg: await svgOfCase(fx.params, fx.layout) });
	}
	return { commit, cases };
}

export const GOLDEN_PATH = new URL("./__snapshots__/golden.json", import.meta.url);

export function loadGolden(): GoldenFile {
	return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
}

export function saveGolden(g: GoldenFile): void {
	const p = fileURLToPath(GOLDEN_PATH);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(g, null, 2) + "\n");
}
