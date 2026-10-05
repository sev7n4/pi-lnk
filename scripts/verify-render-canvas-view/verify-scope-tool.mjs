#!/usr/bin/env node
/**
 * 生产复测①：直接调**线上 dist** 的 render_canvas_view，验三层 + focus 的产出。
 *
 * 跑在 pi-runtime pod 内：
 *   kubectl cp verify-scope-tool.mjs $POD:/tmp/ && kubectl exec $POD -- node /tmp/verify-scope-tool.mjs <canvasId>
 *
 * 前置：/tmp/layout.json 必须是**该画布**的 layout（容器内连不到宿主 5100，
 * 必须在宿主取好再 cp 进来；取法见 docs/agent/architecture.md 的「直连 pi-runtime 复测」章节）。
 *
 * 不含任何生产 id / 内网地址 —— 画布 id 由参数传入。
 */
import fs from "node:fs";

const CANVAS = process.argv[2];
if (!CANVAS) {
	console.error("用法: node verify-scope-tool.mjs <canvasId>   （还需 /tmp/layout.json）");
	process.exit(2);
}

// ⚠️ 路径是**线上容器内**的 dist 路径（与 pi-runtime 的 Dockerfile 一致）
const MOD = "/app/services/pi-runtime/dist/tools/render-canvas-view.js";
const { createRenderCanvasViewTools } = await import(MOD);

const layout = JSON.parse(fs.readFileSync(process.env.LAYOUT_FILE || "/tmp/layout.json", "utf8"));
const tool = createRenderCanvasViewTools({ fetchLayout: async () => layout })[0];

// 与线上 present-result.ts 的 SVG_MAX_CHARS 一致（超界整块丢弃 ⇒ svg 为 ""）
const MAX = 20000;

const byTitle = (kw) => layout.nodes.find((n) => n.type === "prompt" && (n.title || "").includes(kw));
const outline = byTitle("大綱");
const ep01 = layout.nodes.find((n) => (n.title || "").includes("EP01") && (n.title || "").includes("長老之死"));
const assets = byTitle("資產表");
const board = byTitle("分鏡腳本");

console.log(`\n════ 三层 + focus 复测（画布 ${CANVAS}）════`);
console.log(`${layout.nodes.length} 节点 / ${layout.edges.length} 边`);
console.log(`类型分布：${JSON.stringify(layout.nodes.reduce((a, n) => ((a[n.type] = (a[n.type] || 0) + 1), a), {}))}\n`);

const CASES = [
	["宏观 structure（讲原理）", { view: "layout", relation: "dependency", scope: "structure" }],
	["中观 ownership（看归属）", { view: "layout", relation: "dependency", scope: "ownership" }],
	["微观 detail（全量）", { view: "layout", relation: "dependency", scope: "detail" }],
	outline && ["微观 detail+focus=大纲", { view: "layout", relation: "dependency", scope: "detail", focus: outline.id }],
	ep01 && ["微观 detail+focus=EP01 hops2", { view: "layout", relation: "dependency", scope: "detail", focus: ep01.id, hops: 2 }],
	assets && ["微观 detail+focus=资产表", { view: "layout", relation: "dependency", scope: "detail", focus: assets.id }],
	board && ["微观 detail+focus=分镜脚本", { view: "layout", relation: "dependency", scope: "detail", focus: board.id }],
	["默认（不传 scope，应=宏观）", { view: "layout", relation: "dependency" }],
	["旧名 topology（向后兼容）", { view: "topology" }],
	["category（不画依赖边）", { view: "layout", relation: "category" }],
	["tree（层级）", { view: "tree" }],
	["matrix（交叉表）", { view: "matrix", rowBy: "type", colBy: "status" }],
	["focus 不存在（须报错）", { view: "layout", scope: "detail", focus: "__不存在的节点__" }],
	["scope 非法（须报错）", { view: "layout", scope: "nonsense" }],
].filter(Boolean);

let pass = 0;
const rows = [];
for (const [name, params] of CASES) {
	const res = await tool.execute("c", params, () => {}, { sessionId: "s" }, {}, {});
	const d = res.details || {};
	const svg = (d.canvasCommands && d.canvasCommands[0] && d.canvasCommands[0].svg) || "";
	const bytes = svg.length;
	const edges = (svg.match(/data-edge=/g) || []).length;
	const nodes = (svg.match(/data-node=/g) || []).length;
	const over = bytes > MAX;
	const shouldFail = name.includes("须报错");
	// ⚠️ 三种case 各有各的判据，别混：
	//   · 常规= 能出图且在预算内
	//   · 须报错 = d.ok === false
	//   · 全量detail = **预期被拦下**（数据规模使然），它不是失败
	const expectBlocked = name.includes("全量");
	const ok = shouldFail
		? d.ok === false
		: expectBlocked
			? d.ok === false
			: d.ok === true && bytes > 0 && !over;
	if (ok) pass++;
	rows.push({ name, ok, bytes, edges, nodes, blocked: d.ok === false });
	console.log(
		`${ok ? "✓" : "✗"} ${name.padEnd(26)} ${String(bytes).padStart(6)}B 节点=${String(nodes).padStart(3)} 边=${String(edges).padStart(3)}` +
			(shouldFail ? "（预期报错）" : over ? "❌超预算" : d.ok === false ? "⊘被拦下" : ""),
	);
	if (d.ok === false && d.error) console.log(`     ${String(d.error).slice(0, 150)}…`);
	const info = /<text[^>]*class="gv-info"[^>]*>([^<]*)</.exec(svg);
	if (info) console.log(`     ${info[1]}`);
}

const g = (kw) => rows.find((r) => r.name.includes(kw));
const ck = (n, c) => console.log(`${c ? "✓" : "✗"} ${n}`);
console.log("\n────── 关键断言 ──────");
ck("宏观能出图且在预算内", g("宏观").ok);
ck("中观能出图且在预算内", g("中观").ok);
ck("微观全量被拦下（预期，需拆局部）", g("全量").blocked);
if (g("focus=大纲")) ck("微观 + focus 能出图（微观的出口）", g("focus=大纲").ok);
ck("不传 scope 时默认=宏观", g("默认（不传").edges === g("宏观").edges);
ck("旧名 topology 向后兼容", g("topology").ok);
ck("category 不画依赖边", g("category").edges === 0);
ck("tree / matrix 仍能出图", g("tree").ok && g("matrix").ok);
ck("focus 不存在 ⇒ 报错（不静默退化）", g("focus 不存在").ok);
ck("scope 非法 ⇒ 报错", g("scope 非法").ok);
console.log(`\n结果：${pass}/${CASES.length}`);
process.exit(pass === CASES.length ? 0 : 1);
