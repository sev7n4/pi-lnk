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

export function goldenFixtures(): Array<Omit<GoldenCase, "svg">> {
	return [
		{ name: "layout-dependency", params: { view: "layout", relation: "dependency" }, layout: BASE3 },
		{ name: "layout-category", params: { view: "layout", relation: "category" }, layout: BASE3 },
		{ name: "topology-legacy", params: { view: "topology" }, layout: BASE3 },
		{ name: "tree", params: { view: "tree" }, layout: TREE5 },
		{ name: "timeline", params: { view: "timeline" }, layout: BASE3 },
		{ name: "swimlane-type", params: { view: "swimlane", groupBy: "type" }, layout: TREE5 },
		{ name: "matrix-type-status", params: { view: "matrix", rowBy: "type", colBy: "status" }, layout: MIXED6 },
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
