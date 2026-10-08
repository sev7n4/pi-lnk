# 图形化表达引擎 D2+D3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `render_canvas_view` 的五个视图从「直接拼 SVG 字符串」改成「先算坐标、再渲染」，并在此之上落地文字提炼与视觉语言规范，让画出来的那一次就看得清。

**Architecture:** 新增 `services/pi-runtime/src/graph/` 三层：`graph-ir.ts`（GraphIR 类型 + `resolveView` / `condenseLabel` 纯函数）→ `layout/*.ts`（IR → 坐标，每视图一个纯函数）→ `visual-role.ts`（IR → 视觉角色）。`render-canvas-view.views.ts` 的五个 `build*Svg` 退化为**坐标的纯消费者**。D2 阶段（Task 1–6）对外输出**逐字节不变**，靠黄金快照守住；D3 阶段（Task 7–9）才允许改字节。

**Tech Stack:** TypeScript · pi-runtime 服务（`services/pi-runtime`）· 测试用 **`node:test` + `node:assert/strict`，通过 `tsx --test` 执行**（本仓库**没有 vitest**，任何 `from "vitest"` 的测试都跑不起来）· 输出为 SVG 字符串。

**Spec:** `docs/superpowers/specs/2026-10-08-graph-expression-engine-design-v2.md`（已合并进 master，commit `21a3d5e7`）

**本计划的范围：** 只覆盖 **D2（IR 抽取）** 与 **D3（表达质量）**，不涉及前端。D4（呈现分工 + 嵌入画布，`apps/web`）与 D5（触发对齐 + `source=knowledge`）在 D3 落地后各开一份计划 —— 它们的输入是 D3 产出的 IR 形状，现在写会返工。

---

## Global Constraints

- **测试框架**：`node:test`，执行 `cd services/pi-runtime && ../../node_modules/.bin/tsx --test <file>`。禁止 `from "vitest"`。
- **变异验证（项目硬纪律）**：每个纯函数至少做一次变异验证 —— 人为改坏实现，确认对应用例转红，并在**提交信息里写明**「改了什么 → 哪条变红 → 还原后复绿」。
- **D2 阶段零参数变更**：Task 1–6 不得新增/删除/重命名工具的顶层参数。
- **字节上限**：单张 SVG ≤ `SVG_MAX_CHARS = 20000`（`render-canvas-view.expressive.ts:454`）。超界由 `svgBudgetReport` 显式报错，不得静默。
- **legacy 别名本轮不得废弃**：生产数据显示 `topology` 32 次、`table` 40 次（`docs/ops/graph-observation-baseline-2026-10-08.md`）。
- **label 预算**：`≤ 12 个汉字` 或 `≤ 24 个拉丁字符`（统一为 **24 单位宽**，1 CJK = 2 单位、1 拉丁 = 1 单位）。
- **⛔ N8**：不用 CSS 截断 / 输出侧 `clip()` 代替内容提炼。「字太多」是内容问题，预算在 **IR 构建侧**保证。
- **`verify-spec-figures` 同时扫描 `specs/` 与 `plans/`**：本文件若加 Mermaid 图须同样合规（本计划只用表格与代码块，无图）。
- **每次提交前**跑：`verify-spec-figures` / `verify-claims` / `verify-links` / `verify-tool-contract` / `verify-tool-tiering`。

---

## 对规格的两处修正（取证后改的，不是笔误）

写计划时核对了 `render-canvas-view.views.ts`（824 行），发现规格 §4.2(2) 与 §8 有两处与代码不符。**计划按下面执行，并在提交信息里注明。**

| # | 规格原文 | 实测 | 本计划的做法 |
|---|---|---|---|
| C1 | §4.2(2)「有向边必带箭头」⇒ 读起来像当前没有箭头 | **箭头已存在**：`marker-end="url(#gv-arrow)"` 出现在 4 处（:309 / :333 / :586 / :645 / :746） | 真正的缺口不是「没有箭头」，而是**方向由渲染层自行决定**：`buildTreeSvg` / `buildTimelineFlowSvg` 根本不接收 `relation`，无条件画箭头 ⇒ `relation=category`（无向）下也会出现箭头，违反 §4.2(2)。修正为：把 `relation` 传进 IR，箭头由 `edge.kind` 决定（Task 9），并加断言钉住 |
| C2 | §8 `layoutCompact`「26 节点时包围盒面积显著小于**透传**」 | **不存在「透传」**：`position` 在 `views.ts` 里**只用于 tree 的排序**（:557 / :560），五个视图的坐标全部来自 `boxesFrom` 的行列计算，不读画布 `position` ⇒ 没有可比对象 | 改用**绝对可测判据**：空白率 `whitespaceRatio = 1 - 节点面积和 / 包围盒面积`。Task 7 先**实测基线**，再断言紧凑后 ≤ 基线的 85% |

---

## Review Focus

规格暗示、但单看任务描述容易漏掉的输入与失效模式。每条已在所属任务的步骤里钉了测试。

| # | 输入 / 条件 | 合理期望 | 钉在哪 |
|---|---|---|---|
| R1 | **单节点 / 零节点** | 不得产出 `NaN` 坐标或除零（SVG 里出现 `x="NaN"` 是静默降级，浏览器整块不渲染） | Task 3 |
| R2 | **节点既无 `title` 又无 `label`** | 回落成 `id`，且 `<text>` 里不得是空串（空 text 节点 = 图上有个看不见的框） | Task 7 |
| R3 | **标题含 `&` 与 `<script>`** | `&` 必须**第一个**转义，否则 `&lt;` 会被二次转义成 `&amp;lt;` | Task 3 |
| R4 | **`view=table` + `overlay`** | 走行级渲染器、**不进 IR 坐标路径**，迁移后必须仍能渲染且 overlay 轨道保留（生产 40 次） | Task 1 |
| R5 | **所有节点都带 `mark`** | 强调色元素占比仍 ≤ 总数 20%（全部强调 = 没有强调） | Task 9 |

---

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `services/pi-runtime/src/graph/graph-ir.ts`（新增） | GraphIR 类型 + `resolveView` + `labelWidth` / `condenseLabel` + `graphIRFromGv` | 2 |
| `services/pi-runtime/src/graph/layout/types.ts`（新增） | `PlacedNode` / `PlacedEdge` / `GroupBox` / `LaidOut` + `bboxArea` / `whitespaceRatio` | 3 |
| `services/pi-runtime/src/graph/layout/layout.ts`（新增） | `layoutLayout(ir)` | 3 |
| `services/pi-runtime/src/graph/layout/tree.ts`（新增） | `layoutTree(ir)` | 4 |
| `services/pi-runtime/src/graph/layout/timeline.ts`（新增） | `layoutTimelineFlow(ir)` | 5 |
| `services/pi-runtime/src/graph/layout/grid.ts`（新增） | `layoutSwimlane(ir)` + `layoutMatrix(ir)` | 6 |
| `services/pi-runtime/src/graph/layout/compact.ts`（新增） | `layoutCompact(laid)` 紧凑化后处理 | 7 |
| `services/pi-runtime/src/graph/visual-role.ts`（新增） | `visualRoles(ir)` + `edgeDirected(ir, e)` | 9 |
| `services/pi-runtime/src/graph/snapshot.ts`（新增） | 黄金快照的采集与比对 | 1 |
| `services/pi-runtime/src/graph/__snapshots__/golden.json`（新增） | 黄金样本（D2 阶段只写一次；D3 阶段按任务重新生成） | 1 |
| `services/pi-runtime/src/tools/render-canvas-view.views.ts`（修改） | 五个 `build*Svg` 改为消费 `LaidOut` | 3–6, 9 |
| `services/pi-runtime/src/tools/render-canvas-view.ts`（修改） | 只改 dispatch 处传入 `relation`（Task 9） | 9 |

---

### Task 1: 黄金快照基线（**必须第一个做**）

**为什么在最前**：仓库里**没有任何快照设施**（`render-canvas-view.test.ts` 全是 `assert.match` 的片段匹配）。而 D2 的验收判据是「对外输出逐字节不变」。没有迁移前采下来的基线，这条判据无法证明 —— 只能凭感觉说「应该没变」。

**Files:**
- Create: `services/pi-runtime/src/graph/snapshot.ts`
- Create: `services/pi-runtime/src/graph/__snapshots__/golden.json`
- Create: `services/pi-runtime/src/graph/snapshot.test.ts`

**Interfaces:**
- Produces: `captureGolden(cases): GoldenFile`、`loadGolden(): GoldenFile`、`goldenCases(): GoldenCase[]`（后续所有迁移任务都消费这三个）

- [ ] **Step 1: 写采集器**

```ts
// services/pi-runtime/src/graph/snapshot.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createRenderCanvasViewTools } from "../tools/render-canvas-view.js";

export interface GoldenCase {
	/** 稳定标识：改了它就必须重新生成基线并说明理由。 */
	name: string;
	params: Record<string, unknown>;
	/** 画布布局（fetchLayout 的返回值）。 */
	layout: { nodes: unknown[]; edges: unknown[] };
	svg: string;
}

export interface GoldenFile {
	/** 生成时的 HEAD，便于 reviewer 知道基线来自哪个提交。 */
	commit: string;
	cases: GoldenCase[];
}

export const GOLDEN_PATH = new URL("./__snapshots__/golden.json", import.meta.url);

export function goldenFixtures(): Array<Omit<GoldenCase, "svg">> {
	return [
		{ name: "layout-dependency", params: { view: "layout", relation: "dependency" }, layout: LAYOUT_3 },
		{ name: "layout-category", params: { view: "layout", relation: "category" }, layout: LAYOUT_3 },
		{ name: "topology-legacy", params: { view: "topology" }, layout: LAYOUT_3 },
		{ name: "tree", params: { view: "tree" }, layout: LAYOUT_TREE },
		{ name: "timeline", params: { view: "timeline" }, layout: LAYOUT_3 },
		{ name: "swimlane-type", params: { view: "swimlane", groupBy: "type" }, layout: LAYOUT_TREE },
		{ name: "matrix-type-status", params: { view: "matrix", rowBy: "type", colBy: "status" }, layout: LAYOUT_MIXED },
		{ name: "table-legacy-overlay", params: { view: "table", overlay: { kind: "severity", data: [{ node_id: "n1", level: 3 }] } }, layout: LAYOUT_3 },
	];
}

export async function captureGolden(commit: string): Promise<GoldenFile> {
	const cases: GoldenCase[] = [];
	for (const fx of goldenFixtures()) {
		const tools = createRenderCanvasViewTools({
			fetchLayout: async () => fx.layout as never,
		});
		const tool = tools.find((t) => t.name === "render_canvas_view")!;
		const r = await tool.execute("call-1", fx.params as never, () => {}, { sessionId: "s1" }, {} as never, {} as never);
		const d = r.details as { ok: boolean; error?: string; canvasCommands?: Array<{ svg: string }> };
		if (!d.ok || !d.canvasCommands?.[0]?.svg) throw new Error(`用例 ${fx.name} 未产出 svg: ${d.error}`);
		cases.push({ name: fx.name, params: fx.params, layout: fx.layout, svg: d.canvasCommands[0].svg });
	}
	return { commit, cases };
}

export function loadGolden(): GoldenFile {
	return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
}

export function saveGolden(g: GoldenFile): void {
	writeFileSync(GOLDEN_PATH, JSON.stringify(g, null, 2) + "\n");
}
```

`LAYOUT_3` / `LAYOUT_TREE` / `LAYOUT_MIXED` 三个 fixture 直接抄 `render-canvas-view.test.ts` 里已有的 `LAYOUT`，并补两个：`LAYOUT_TREE` 要有 `parentNode` 形成真实父子（`n1` → `n2`/`n3`），`LAYOUT_MIXED` 要有 ≥2 种 `type` 且 ≥2 种 `status`（matrix 需要两个维度都有 ≥2 个取值才画得出格子）。

- [ ] **Step 2: 写重新生成的入口脚本（只在显式要求时才写盘）**

```ts
// scripts/gen-graph-snapshot.ts（新增）
import { execSync } from "node:child_process";
import { captureGolden, saveGolden } from "../services/pi-runtime/src/graph/snapshot.js";

const commit = execSync("git rev-parse HEAD").toString().trim();
const g = await captureGolden(commit);
saveGolden(g);
console.log(`写入 ${g.cases.length} 个用例，commit=${commit}`);
```

- [ ] **Step 3: 生成基线**

Run: `./node_modules/.bin/tsx scripts/gen-graph-snapshot.ts`

Expected: `src/graph/__snapshots__/golden.json` 生成，8 个用例，每个 `svg` 非空，控制台打印 `写入 8 个用例`。

> ⚠️ 后续 Task 7 / 8 / 9 重新生成基线时**复用这一条命令**，并在提交信息里写清本次变化的 diff 摘要。

- [ ] **Step 4: 写比对测试（含 R4）**

```ts
// services/pi-runtime/src/graph/snapshot.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { captureGolden, loadGolden } from "./snapshot.js";

test("黄金快照：8 个用例的 SVG 逐字节不变", async () => {
	const golden = loadGolden();
	const fresh = await captureGolden(golden.commit);
	assert.equal(fresh.cases.length, golden.cases.length);
	for (let i = 0; i < golden.cases.length; i++) {
		assert.equal(fresh.cases[i].svg, golden.cases[i].svg, `用例 ${golden.cases[i].name} 的 SVG 变了`);
	}
});

test("R4：view=table + overlay 仍走行级渲染且保留 overlay（生产 40 次）", async () => {
	const golden = loadGolden();
	const t = golden.cases.find((c) => c.name === "table-legacy-overlay")!;
	// 行级渲染器的标记：<table>-ish 行结构与 overlay 分级同时存在
	assert.match(t.svg, /severity|level/);
	assert.equal(t.svg.includes("NaN"), false);
});
```

- [ ] **Step 5: 跑测试确认绿**

Run: `cd services/pi-runtime && ../../node_modules/.bin/tsx --test src/graph/snapshot.test.ts`
Expected: 2 passed。（若 R4 的 `assert.match` 选错了特征串，改成该 fixture 实际输出里稳定存在的字符串 —— 先打印 `t.svg.slice(0,400)` 看一眼再定。）

- [ ] **Step 6: 变异验证**

把 `snapshot.ts` 的 `captureGolden` 里 `fx.params` 换成 `{}`（去掉 view 参数），重跑 Step 5 ⇒ 第 1 条用例必须转红。还原后复绿。

- [ ] **Step 7: Commit**

```bash
git add services/pi-runtime/src/graph/
git commit -m "test(pi-runtime): render_canvas_view 黄金快照基线（D2 前置）

D2 的验收判据是「对外输出逐字节不变」，但仓库里没有任何快照设施
（既有测试全是 assert.match 片段匹配）⇒ 没有迁移前采下来的基线，
这条判据无法证明。本任务先把 8 个用例的 SVG 字节固定下来。

含 table+overlay（生产 40 次，走行级渲染器不进 IR 坐标路径）。

变异验证：captureGolden 去掉 view 参数 ⇒ 逐字节用例转红，还原复绿。"
```

---

### Task 2: GraphIR 与两个纯函数

**Files:**
- Create: `services/pi-runtime/src/graph/graph-ir.ts`
- Create: `services/pi-runtime/src/graph/graph-ir.test.ts`

**Interfaces:**
- Consumes: `GvNode` / `GvEdge`（`render-canvas-view.expressive.ts:28` / `:37`）
- Produces: `GraphIR` / `GraphIRNode` / `GraphIREdge` / `GraphView` / `resolveView` / `condenseLabel` / `labelWidth` / `graphIRFromGv`（Task 3–9 全部依赖这些名字与类型）

- [ ] **Step 1: 写失败的测试**

```ts
// services/pi-runtime/src/graph/graph-ir.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveView, condenseLabel, labelWidth, isGraphView } from "./graph-ir.js";

test("resolveView：topology 归一到 layout（legacy 不双计）", () => {
	assert.equal(resolveView("topology"), "layout");
	assert.equal(resolveView("layout"), "layout");
});

test("resolveView：table 保持行级视图，未知取值返回 undefined", () => {
	assert.equal(resolveView("table"), "table");
	assert.equal(isGraphView("table"), false);
	assert.equal(resolveView("nonsense"), undefined);
});

test("resolveView：topology 与 layout 产出同一 view（v1 Review Focus #4）", () => {
	assert.equal(resolveView("topology"), resolveView("layout"));
});

test("labelWidth：1 汉字 = 2 单位，1 拉丁 = 1 单位", () => {
	assert.equal(labelWidth("镜头"), 4);
	assert.equal(labelWidth("abcd"), 4);
	assert.equal(labelWidth("镜a"), 3);
});

test("condenseLabel：13 汉字压到 12 汉字 + 省略号", () => {
	const s = "一二三四五六七八九十甲乙丙丁";
	assert.equal(condenseLabel(s).length, 13);
	assert.match(condenseLabel(s), /…$/);
});

test("condenseLabel：25 个拉丁字符压到 24 + 省略号", () => {
	const s = "abcdefghijklmnopqrstuvwxy";
	assert.equal(condenseLabel(s), "abcdefghijklmnopqrstuvwxy".slice(0, 24) + "…");
});

test("condenseLabel：预算内不动、空串返回空串", () => {
	assert.equal(condenseLabel("镜头一"), "镜头一");
	assert.equal(condenseLabel(""), "");
});

test("condenseLabel：先去掉首尾空白再计量（避免空格吃掉预算）", () => {
	assert.equal(condenseLabel("  镜头一  "), "镜头一");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && ../../node_modules/.bin/tsx --test src/graph/graph-ir.test.ts`
Expected: FAIL，`Cannot find module './graph-ir.js'`

- [ ] **Step 3: 实现**

```ts
// services/pi-runtime/src/graph/graph-ir.ts
import type { GvEdge, GvNode } from "../tools/render-canvas-view.expressive.js";

export const GRAPH_VIEWS = ["layout", "tree", "timeline", "swimlane", "matrix"] as const;
export const ROW_VIEWS = ["table"] as const;
export type GraphView = (typeof GRAPH_VIEWS)[number];
export type RowView = (typeof ROW_VIEWS)[number];
export type ResolvedView = GraphView | RowView;

/** legacy 视图名 → 规范名。归一必须在 **IR 入口**完成 ⇒ IR 的 view 字段不含 legacy 值。 */
const LEGACY_ALIAS: Readonly<Record<string, ResolvedView>> = { topology: "layout" };

export function resolveView(v: unknown): ResolvedView | undefined {
	if (typeof v !== "string") return undefined;
	const hit = LEGACY_ALIAS[v];
	if (hit) return hit;
	return (GRAPH_VIEWS as readonly string[]).includes(v) || (ROW_VIEWS as readonly string[]).includes(v)
		? (v as ResolvedView)
		: undefined;
}

export function isGraphView(v: ResolvedView): v is GraphView {
	return (GRAPH_VIEWS as readonly string[]).includes(v);
}

/**
 * 标签预算（单位宽）：12 汉字 × 2 = 24，24 拉丁 × 1 = 24 ⇒ 用同一个数表达两种边界。
 * ⭐ 统一成「单位宽」而不是「字符数」，否则中英混排时预算不可比。
 */
export const LABEL_BUDGET = 24;
const CJK = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;

export function labelWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += CJK.test(ch) ? 2 : 1;
	return w;
}

export function condenseLabel(raw: string, budget: number = LABEL_BUDGET): string {
	const s = raw.trim();
	if (s === "") return "";
	if (labelWidth(s) <= budget) return s;
	// 省略号本身占 1 单位，预算里先扣掉。
	const cap = budget - 1;
	let w = 0;
	let out = "";
	for (const ch of s) {
		const cw = CJK.test(ch) ? 2 : 1;
		if (w + cw > cap) break;
		w += cw;
		out += ch;
	}
	return out.trimEnd() + "…";
}

export interface GraphIRNode {
	id: string;
	type?: string;
	/** 提炼后的短标签，满足 LABEL_BUDGET。 */
	label: string;
	/** 完整文本。⛔ 不进节点框。 */
	description?: string;
	status?: string;
	parentNode?: string;
	sourceKind: "canvas" | "knowledge" | "derived";
	mark?: { kind: string; level: number; text?: string };
	color?: string;
	seq?: number;
}

export interface GraphIREdge {
	source: string;
	target: string;
	kind: "sequence" | "dependency" | "containment" | "flow";
	label?: string;
}

export interface GraphIR {
	view: GraphView;
	/** ⭐ C1 修正：relation 进 IR，箭头由 edge.kind 决定，不由渲染层自行决定。 */
	relation: "dependency" | "category";
	title?: string;
	nodes: GraphIRNode[];
	edges: GraphIREdge[];
	groupBy?: "type" | "status" | "parentNode";
	scope?: "structure" | "ownership" | "detail";
	focus?: string;
	hops?: number;
	focusAnchor?: "spread" | "bus" | "aggregate";
	showType?: boolean;
	colors?: Record<string, string | undefined>;
	emphasize?: readonly string[];
}

/**
 * GvNode[] → GraphIR。
 *
 * ⚠️ 本阶段 **不做** condenseLabel：`label` 原样取 `title ?? id`，
 * 与迁移前 `nodeRect` 的 `opts.label ?? n.title ?? n.id` 完全一致。
 * 提炼在 Task 8 落地 —— 提前做会破坏 D2「逐字节不变」的验收判据。
 */
export function graphIRFromGv(input: {
	view: GraphView;
	relation: "dependency" | "category";
	nodes: readonly GvNode[];
	edges: readonly GvEdge[];
	groupBy?: "type" | "status" | "parentNode";
	scope?: "structure" | "ownership" | "detail";
	showType?: boolean;
	colors?: Record<string, string | undefined>;
	emphasize?: readonly string[];
	focus?: string;
	hops?: number;
	focusAnchor?: "spread" | "bus" | "aggregate";
	title?: string;
}): GraphIR {
	const edgeKind: GraphIREdge["kind"] = input.relation === "dependency" ? "dependency" : "category";
	return {
		view: input.view,
		relation: input.relation,
		...(input.title !== undefined ? { title: input.title } : {}),
		nodes: input.nodes.map((n) => ({
			id: n.id,
			...(n.type !== undefined ? { type: n.type } : {}),
			label: n.title ?? n.id,
			description: n.title !== undefined && n.title !== n.id ? n.title : undefined,
			...(n.status !== undefined ? { status: n.status } : {}),
			...(n.parentNode !== undefined ? { parentNode: n.parentNode } : {}),
			sourceKind: "canvas",
		})),
		edges: input.edges.map((e) => ({ source: e.source, target: e.target, kind: edgeKind })),
		...(input.groupBy !== undefined ? { groupBy: input.groupBy } : {}),
		...(input.scope !== undefined ? { scope: input.scope } : {}),
		...(input.showType !== undefined ? { showType: input.showType } : {}),
		...(input.colors !== undefined ? { colors: input.colors } : {}),
		...(input.emphasize !== undefined ? { emphasize: input.emphasize } : {}),
		...(input.focus !== undefined ? { focus: input.focus } : {}),
		...(input.hops !== undefined ? { hops: input.hops } : {}),
		...(input.focusAnchor !== undefined ? { focusAnchor: input.focusAnchor } : {}),
	};
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd services/pi-runtime && ../../node_modules/.bin/tsx --test src/graph/graph-ir.test.ts`
Expected: 8 passed

- [ ] **Step 5: 变异验证（两次）**

① 把 `LEGACY_ALIAS` 的 `topology` 删掉 ⇒ 「topology 归一到 layout」转红。
② 把 `condenseLabel` 的 `labelWidth(s) <= budget` 改成 `< budget` ⇒ 「预算内不动」转红。
每次还原后复绿。

- [ ] **Step 6: Commit**

---

### Task 3: 布局层骨架 + layout 视图迁移

**Files:**
- Create: `services/pi-runtime/src/graph/layout/types.ts`
- Create: `services/pi-runtime/src/graph/layout/layout.ts`
- Create: `services/pi-runtime/src/graph/layout/layout.test.ts`
- Modify: `services/pi-runtime/src/tools/render-canvas-view.views.ts:206-427`（`buildLayoutSvg`）

**Interfaces:**
- Consumes: Task 2 的 `GraphIR` / `graphIRFromGv`
- Produces: `PlacedNode` / `PlacedEdge` / `GroupBox` / `LaidOut` / `bboxArea` / `whitespaceRatio` / `layoutLayout`（Task 4–7 依赖）

- [ ] **Step 1: 写坐标类型（含 R1 / R3 的断言位置）**

```ts
// services/pi-runtime/src/graph/layout/types.ts
import type { GraphIR } from "../graph-ir.js";

export interface PlacedNode {
	id: string;
	x: number; y: number; w: number; h: number; row: number;
	/** 已按 LABEL_BUDGET 提炼（本阶段等于原始 title/id）。 */
	label: string;
	description?: string;
	seq?: number;
	misplaced?: boolean;
	type?: string;
	color?: string;
}
export interface PlacedEdge {
	source: string; target: string;
	/** SVG path 的 d 属性。 */
	path: string;
	/** ⭐ C1 修正：由 edge.kind 决定，渲染层不得自行决定。 */
	directed: boolean;
	label?: string;
}
export interface GroupBox { key: string; label?: string; x: number; y: number; w: number; h: number }
export interface LaidOut {
	width: number; height: number;
	nodes: PlacedNode[]; edges: PlacedEdge[]; groups: GroupBox[];
	showType: boolean;
	colors?: Record<string, string | undefined>;
	emphasize?: readonly string[];
}
export type LayoutFn = (ir: GraphIR) => LaidOut;

export function bboxArea(l: LaidOut): number {
	if (l.nodes.length === 0) return 0;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const n of l.nodes) {
		x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
		x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
	}
	return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

export function nodeAreaSum(l: LaidOut): number {
	return l.nodes.reduce((a, n) => a + n.w * n.h, 0);
}

/** 空白率 = 1 - 节点面积和 / 包围盒面积。C2 修正后的可测判据。 */
export function whitespaceRatio(l: LaidOut): number {
	const b = bboxArea(l);
	if (b === 0) return 0;
	return 1 - nodeAreaSum(l) / b;
}
```

- [ ] **Step 2: 把 `buildLayoutSvg` 的坐标计算搬进 `layoutLayout`**

读 `render-canvas-view.views.ts:206-427`，把其中 `boxesFrom(...)` 的四个回调（`xOf` / `wOf` / `yOf` / `hOf`）与行序逻辑**逐行搬**进 `layoutLayout(ir): LaidOut`。`buildLayoutSvg` 改为：

```ts
export function buildLayoutSvg(
	nodesIn: readonly GvNode[],
	edgesIn: readonly GvEdge[],
	opts: LayoutOpts,
): string {
	const ir = graphIRFromGv({
		view: "layout",
		relation: opts.drawEdges ? "dependency" : "category",
		nodes: nodesIn, edges: edgesIn,
		groupBy: opts.groupBy, scope: opts.scope, showType: opts.showType,
		colors: opts.colors,
		...(opts.focus !== undefined ? { focus: opts.focus } : {}),
	});
	return renderLaidOut(layoutLayout(ir));
}
```

`renderLaidOut` 是本任务在 `views.ts` 里新增的渲染函数：消费 `LaidOut`，内部**原样保留** `nodeRect` / `edgePath` / `clip` / palette / 图例的现有代码。

- [ ] **Step 3: 补 R1 / R3 的测试**

```ts
// services/pi-runtime/src/graph/layout/layout.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { layoutLayout } from "./layout.js";
import { graphIRFromGv } from "../graph-ir.js";

function ir(nodes: Array<{ id: string; title?: string }>, relation: "dependency" | "category" = "dependency") {
	return graphIRFromGv({ view: "layout", relation, nodes, edges: [] });
}

test("R1：单节点不除零，坐标全部有限", () => {
	const l = layoutLayout(ir([{ id: "n1", title: "只有一个" }]));
	assert.equal(l.nodes.length, 1);
	for (const n of l.nodes) {
		assert.equal(Number.isFinite(n.x), true);
		assert.equal(Number.isFinite(n.y), true);
		assert.ok(n.w > 0 && n.h > 0);
	}
});

test("R1：零节点不抛错，面积为 0 而不是 NaN", () => {
	const l = layoutLayout(ir([]));
	assert.equal(l.nodes.length, 0);
	assert.equal(Number.isNaN(l.width), false);
	assert.equal(Number.isNaN(l.height), false);
});

test("R3：label 含 & 与 <script> 时原样进 label（转义由渲染层负责，布局层不得提前破坏）", () => {
	const raw = 'a & b <script>alert(1)</script>';
	const l = layoutLayout(ir([{ id: "n1", title: raw }]));
	assert.equal(l.nodes[0].label, raw);
});

test("layout 视图：relation=category 时不产出有向边", () => {
	const l = layoutLayout(graphIRFromGv({
		view: "layout", relation: "category",
		nodes: [{ id: "n1" }, { id: "n2" }],
		edges: [{ source: "n1", target: "n2" }],
	}));
	assert.equal(l.edges.every((e) => e.directed === false), true);
});
```

- [ ] **Step 4: 跑布局单测**

Run: `cd services/pi-runtime && ../../node_modules/.bin/tsx --test src/graph/layout/layout.test.ts`
Expected: 4 passed

- [ ] **Step 5: 跑黄金快照确认逐字节不变**

Run: `cd services/pi-runtime && ../../node_modules/.bin/tsx --test src/graph/snapshot.test.ts`
Expected: 2 passed。**若红**：说明坐标计算搬错了 —— 逐字段 diff `LaidOut` 与迁移前 `boxesFrom` 的输出，不要改黄金文件。

- [ ] **Step 6: 跑既有回归**

Run: `cd services/pi-runtime && ../../node_modules/.bin/tsx --test src/tools/render-canvas-view.test.ts src/tools/render-canvas-view.expressive.test.ts src/tools/render-canvas-view.color.test.ts src/tools/render-canvas-view.dualwrite.test.ts`
Expected: 全绿。

- [ ] **Step 7: 变异验证**

把 `layoutLayout` 里行高的 `ROW_H` 加 1 ⇒ 黄金快照逐字节用例转红。还原复绿。

- [ ] **Step 8: Commit**

---

### Task 4: tree 视图迁移

**Files:**
- Create: `services/pi-runtime/src/graph/layout/tree.ts`
- Create: `services/pi-runtime/src/graph/layout/tree.test.ts`
- Modify: `services/pi-runtime/src/tools/render-canvas-view.views.ts:466-632`（`buildTreeSvg`）

**Interfaces:**
- Consumes: `GraphIR`、`LaidOut`、`renderLaidOut`（Task 3）
- Produces: `layoutTree(ir): LaidOut`

- [ ] **Step 1: 写失败的测试**

```ts
// services/pi-runtime/src/graph/layout/tree.test.ts
test("根节点判定看入边：无 parentNode 但指向别人的节点是根", () => {
	const l = layoutTree(graphIRFromGv({
		view: "tree", relation: "category",
		nodes: [{ id: "outline" }, { id: "ep01", parentNode: "outline" }, { id: "ep02", parentNode: "outline" }],
		edges: [{ source: "outline", target: "ep01" }, { source: "outline", target: "ep02" }],
	}));
	assert.equal(l.nodes[0].id, "outline");
});

test("R1：单节点的树不抛错、坐标有限", () => {
	const l = layoutTree(graphIRFromGv({ view: "tree", relation: "category", nodes: [{ id: "only" }], edges: [] }));
	assert.equal(l.nodes.length, 1);
	assert.equal(Number.isFinite(l.nodes[0].x), true);
});
```

- [ ] **Step 2: 跑测试确认失败**（`Cannot find module './tree.js'`）

- [ ] **Step 3: 搬迁**

把 `views.ts:466-632` 里 `orderNodes` / `childOf` / `hasIncoming` / 深度与缩进（`TREE_INDENT = 26` / `TREE_DEPTH_W = 150`）的计算**逐行搬**进 `layoutTree`。`buildTreeSvg` 改为 `renderLaidOut(layoutTree(ir))`。

- [ ] **Step 4: 跑测试确认绿** + **Step 5: 黄金快照逐字节不变**（同 Task 3 Step 5/6）

- [ ] **Step 6: 变异验证**：把 `TREE_INDENT` 从 26 改成 27 ⇒ 快照转红。还原复绿。

- [ ] **Step 7: Commit**

---

### Task 5: timeline 视图迁移

**Files:**
- Create: `services/pi-runtime/src/graph/layout/timeline.ts`
- Create: `services/pi-runtime/src/graph/layout/timeline.test.ts`
- Modify: `services/pi-runtime/src/tools/render-canvas-view.views.ts:633-667`（`buildTimelineFlowSvg`）

**Interfaces:**
- Produces: `layoutTimelineFlow(ir): LaidOut`

- [ ] **Step 1: 写失败的测试**

```ts
test("timeline：节点按业务序纵向排列，y 单调递增", () => {
	const l = layoutTimelineFlow(graphIRFromGv({
		view: "timeline", relation: "category",
		nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }], edges: [],
	}));
	assert.equal(l.nodes.length, 3);
	assert.ok(l.nodes[1].y > l.nodes[0].y);
	assert.ok(l.nodes[2].y > l.nodes[1].y);
});

test("R1：零节点的 timeline 高度为有限值（不得 NaN）", () => {
	const l = layoutTimelineFlow(graphIRFromGv({ view: "timeline", relation: "category", nodes: [], edges: [] }));
	assert.equal(Number.isFinite(l.height), true);
});
```

- [ ] **Step 2–3:** 跑测试确认失败 → 搬迁（`buildTimelineFlowSvg` 只有 34 行，逻辑简单）。

- [ ] **Step 4–5:** 绿 → 黄金快照逐字节不变。

- [ ] **Step 6: 变异验证**：`ROW_H` +1 ⇒ 快照转红。

- [ ] **Step 7: Commit**

---

### Task 6: swimlane + matrix 迁移

**Files:**
- Create: `services/pi-runtime/src/graph/layout/grid.ts`
- Create: `services/pi-runtime/src/graph/layout/grid.test.ts`
- Modify: `services/pi-runtime/src/tools/render-canvas-view.views.ts:671-824`（`buildSwimlaneSvg` / `buildMatrixSvg`）

**Interfaces:**
- Produces: `layoutSwimlane(ir): LaidOut`、`layoutMatrix(ir): LaidOut`

- [ ] **Step 1: 写失败的测试**

```ts
test("matrix：行维度取值 < 2 时不产出格子（画不出矩阵就别画）", () => {
	const l = layoutMatrix(graphIRFromGv({
		view: "matrix", relation: "category",
		nodes: [{ id: "n1", type: "a" }, { id: "n2", type: "a" }], edges: [],
		groupBy: "type",
	}));
	assert.equal(l.nodes.length, 0);
});

test("swimlane：R1 单节点不除零", () => {
	const l = layoutSwimlane(graphIRFromGv({
		view: "swimlane", relation: "category",
		nodes: [{ id: "only", type: "a" }], edges: [], groupBy: "type",
	}));
	assert.equal(l.nodes.length, 1);
	assert.equal(Number.isFinite(l.nodes[0].x), true);
});

test("swimlane：无显式边时不得自作主张按相邻顺序串箭头（方向由 IR 决定）", () => {
	const l = layoutSwimlane(graphIRFromGv({
		view: "swimlane", relation: "category",
		nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }], edges: [], groupBy: "type",
	}));
	// category 关系 ⇒ 任何边都不得有向
	assert.equal(l.edges.every((e) => e.directed === false), true);
});
```

- [ ] **Step 2–3:** 失败 → 搬迁。**注意** `views.ts:732-746` 那段「无边时自动串联相邻节点」的 fallback 要一并搬进 `layoutSwimlane`，但它的 `directed` 必须置为 `false`（`relation=category` 时）—— 这正是 Review Focus 里「渲染层自行决定方向」的实例。

- [ ] **Step 4–5:** 绿 → 黄金快照逐字节不变（若因 `directed` 变化而红 ⇒ **这是预期内的**，先把该用例的 `directed` 影响隔离：确认只有 arrows 的 `marker-end` 属性消失，然后在 Task 9 统一处理；本任务改为断言「除 marker-end 外逐字节不变」并在提交信息里写明）。

- [ ] **Step 6: 变异验证**：`STAGE_COUNT` 从 5 改成 6 ⇒ 快照转红。

- [ ] **Step 7: Commit**

> **D2 到此结束。** 此时五个视图的坐标全部来自 `graph/layout/`，`build*Svg` 只做渲染，黄金快照逐字节不变 ⇒ 纯重构成立。

---

### Task 7: D3-1 布局紧凑化

**Files:**
- Create: `services/pi-runtime/src/graph/layout/compact.ts`
- Create: `services/pi-runtime/src/graph/layout/compact.test.ts`
- Modify: `services/pi-runtime/src/graph/layout/layout.ts`（在 `layoutLayout` 末尾应用）
- Update: `services/pi-runtime/src/graph/__snapshots__/golden.json`（**预期变化**）

**Interfaces:**
- Produces: `layoutCompact(laid: LaidOut): LaidOut`

- [ ] **Step 1: 先量基线（不预设阈值）**

写一个临时用例打印 26 节点的空白率：

```ts
// 先只打印，不断言
test("测量：26 节点 layout 的空白率基线", () => {
	const nodes = Array.from({ length: 26 }, (_, i) => ({ id: `n${i}`, title: `节点 ${i}`, type: i % 3 === 0 ? "a" : "b" }));
	const l = layoutLayout(graphIRFromGv({ view: "layout", relation: "dependency", nodes, edges: [] }));
	console.log("bboxArea=", bboxArea(l), "nodeAreaSum=", nodeAreaSum(l), "whitespaceRatio=", whitespaceRatio(l));
});
```

Run 后把 `whitespaceRatio` 的实测值记为 **`R0`**，写进下一步的常量。**若 `R0` 已经很低（< 0.3）**，说明当前布局本来就紧凑 —— 在提交信息里写明「无需紧凑化」并把本任务降级为只补断言，不要为了改而改。

- [ ] **Step 2: 写断言（阈值来自 Step 1 的实测）**

```ts
/** Step 1 实测基线：26 节点 layout 的空白率。改动布局后若此值变化，需说明理由。 */
const R0 = 0.62; // ← 用 Step 1 打印出的实际值替换

test("D3-1：26 节点紧凑化后空白率 ≤ 基线的 85%", () => {
	const nodes = Array.from({ length: 26 }, (_, i) => ({ id: `n${i}`, title: `节点 ${i}`, type: i % 3 === 0 ? "a" : "b" }));
	const raw = layoutLayout(graphIRFromGv({ view: "layout", relation: "dependency", nodes, edges: [] }));
	const c = layoutCompact(raw);
	assert.ok(whitespaceRatio(c) <= R0 * 0.85, `紧凑后 ${whitespaceRatio(c)} 未低于 ${R0 * 0.85}`);
});

test("layoutCompact：不改变节点集合与顺序（只动坐标）", () => {
	const nodes = Array.from({ length: 26 }, (_, i) => ({ id: `n${i}`, title: `节点 ${i}`, type: i % 3 === 0 ? "a" : "b" }));
	const raw = layoutLayout(graphIRFromGv({ view: "layout", relation: "dependency", nodes, edges: [] }));
	const c = layoutCompact(raw);
	assert.deepEqual(c.nodes.map((n) => n.id), raw.nodes.map((n) => n.id));
	assert.deepEqual(c.edges.length, raw.edges.length);
});

test("layoutCompact：零节点与单节点安全返回，不 NaN", () => {
	for (const nodes of [[], [{ id: "only", title: "只有一个" }]]) {
		const raw = layoutLayout(graphIRFromGv({ view: "layout", relation: "category", nodes, edges: [] }));
		const c = layoutCompact(raw);
		assert.equal(c.nodes.length, nodes.length);
		for (const n of c.nodes) {
			assert.equal(Number.isFinite(n.x), true);
			assert.equal(Number.isFinite(n.y), true);
		}
	}
});
```

- [ ] **Step 3: 实现 `layoutCompact`**

思路（按实际代码选一种，不要两种都上）：① 压缩空行 —— 把 `row` 重新编号，去掉全空行；② 收窄宽度 —— 用同列最大 `w` 而不是固定 `W=720`。**宽度收窄要小心**：`render-canvas-view.ts` 的 `svgBudgetReport` 与图例位置依赖 `W`，改宽度前先跑既有回归。

- [ ] **Step 4: 跑测试确认绿**

- [ ] **Step 5: 重新生成黄金快照并人工 diff**

Run: `cd services/pi-runtime && GRAPH_SNAPSHOT_UPDATE=1 <Task 1 Step 3 的命令>`
然后 `git diff src/graph/__snapshots__/golden.json --stat`，确认只有坐标数字变化、**没有节点消失或文字变化**。在提交信息里写明变化摘要。

- [ ] **Step 6: 变异验证**：让 `layoutCompact` 直接 `return laid`（空实现）⇒ 「≤ 基线 85%」转红。

- [ ] **Step 7: Commit**

---

### Task 8: D3-2 文字提炼落地（移除渲染侧截断）

**Files:**
- Modify: `services/pi-runtime/src/graph/graph-ir.ts`（`graphIRFromGv` 启用 `condenseLabel`）
- Modify: `services/pi-runtime/src/tools/render-canvas-view.views.ts`（`nodeRect` 去掉 `clip()`）
- Update: `services/pi-runtime/src/graph/__snapshots__/golden.json`（**预期变化**）
- Create: `services/pi-runtime/src/graph/graph-ir.condense.test.ts`

**Interfaces:**
- Consumes: `condenseLabel` / `LABEL_BUDGET`（Task 2）

- [ ] **Step 1: 写失败的测试（含 R2）**

```ts
test("R2：节点无 title 时 label 回落 id，且不是空串", () => {
	const ir = graphIRFromGv({ view: "layout", relation: "category", nodes: [{ id: "n1" }], edges: [] });
	assert.equal(ir.nodes[0].label, "n1");
	assert.notEqual(ir.nodes[0].label, "");
});

test("超长标题：label 被提炼到预算内，原文完整保留在 description", () => {
	const raw = "这是一个非常非常长的节点标题用来验证文字提炼是否真的生效而不是靠截断";
	const ir = graphIRFromGv({ view: "layout", relation: "category", nodes: [{ id: "n1", title: raw }], edges: [] });
	assert.ok(labelWidth(ir.nodes[0].label) <= LABEL_BUDGET);
	assert.equal(ir.nodes[0].description, raw);
});

test("⛔ N8：节点框内不再出现渲染侧截断（label 已满足预算，无需 clip）", async () => {
	const raw = "这是一个非常非常长的节点标题用来验证文字提炼是否真的生效而不是靠截断";
	const { tool } = makeTool(raw); // 复用 render-canvas-view.test.ts 里的 makeTool，把 title 换成 raw
	const svg = await svgOf({ view: "layout", relation: "dependency" });
	// 提炼后的标签必须完整落在节点框内：svg 里能找到它，且它不是原文
	assert.ok(svg.includes(condenseLabel(raw)));
	assert.equal(svg.includes(raw), false);
	// ⛔ views.ts 里的 clip() 必须已删除（删除后此函数不再被引用）
	assert.equal(/clip\(/.test(readFileSync(new URL("../tools/render-canvas-view.views.ts", import.meta.url), "utf8")), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**
  1. `graphIRFromGv` 里 `label: condenseLabel(n.title ?? n.id)`，`description` 保留 `n.title` 原文。
  2. `views.ts` 的 `nodeRect` 里删掉 `clip(body, ...)`，直接用 `opts.label`。
  3. 保留 `maxChars` 的**兜底**判断？⛔ **不留** —— N8 明确禁止用截断代替提炼。若个别 label 仍超框，说明 `condenseLabel` 预算需要调，改预算而不是加截断。

- [ ] **Step 4: 跑测试确认绿** + 既有回归

- [ ] **Step 5: 重新生成黄金快照并人工 diff**

确认变化**只包含**：长标题被缩短、`description` 不进节点框。若发现正常长度的标题也被改了 ⇒ `condenseLabel` 的 CJK 判定有误，回头修 Task 2。

- [ ] **Step 6: 变异验证**：把 `condenseLabel(n.title ?? n.id)` 改回 `n.title ?? n.id` ⇒ 「超长标题」用例转红。

- [ ] **Step 7: Commit**

---

### Task 9: D3-3 视觉语言规范落地

**Files:**
- Create: `services/pi-runtime/src/graph/visual-role.ts`
- Create: `services/pi-runtime/src/graph/visual-role.test.ts`
- Modify: `services/pi-runtime/src/tools/render-canvas-view.views.ts`（容器改虚线框、箭头按 `directed`）
- Modify: `services/pi-runtime/src/tools/render-canvas-view.ts:644-653`（给 `buildLayoutSvg` 传 `relation`）
- Update: `services/pi-runtime/src/graph/__snapshots__/golden.json`（**预期变化**）

**Interfaces:**
- Consumes: `GraphIR`、`LaidOut`
- Produces: `visualRoles(ir): Map<string, VisualRole>`、`edgeDirected(ir, e): boolean`

- [ ] **Step 1: 写失败的测试（含 R5）**

```ts
import { visualRoles, edgeDirected } from "./visual-role.js";

test("R5：全部节点都带 mark 时，强调色仍 ≤ 总数 20%", () => {
	const nodes = Array.from({ length: 10 }, (_, i) => ({
		id: `n${i}`, title: `n${i}`, mark: { kind: "severity", level: i } as const,
	}));
	const ir = graphIRFromGv({ view: "layout", relation: "dependency", nodes, edges: [] });
	const roles = visualRoles(ir);
	const accent = [...roles.values()].filter((r) => r === "accent").length;
	assert.ok(accent <= Math.ceil(10 * 0.2), `强调色 ${accent} 个，超过 20%`);
});

test("mark 缺失时回落点缀色，不是强调色", () => {
	const ir = graphIRFromGv({ view: "layout", relation: "category", nodes: [{ id: "n1", title: "a" }], edges: [] });
	assert.equal(visualRoles(ir).get("n1"), "muted");
});

test("edgeDirected：dependency 有向、category 无向（C1 修正）", () => {
	const dep = graphIRFromGv({ view: "layout", relation: "dependency", nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] });
	const cat = graphIRFromGv({ view: "layout", relation: "category", nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] });
	assert.equal(edgeDirected(dep, dep.edges[0]), true);
	assert.equal(edgeDirected(cat, cat.edges[0]), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```ts
export type VisualRole = "primary" | "accent" | "muted";
const ACCENT_MAX_RATIO = 0.2;

export function visualRoles(ir: GraphIR): Map<string, VisualRole> {
	const marked = ir.nodes.filter((n) => n.mark !== undefined);
	// 按 level 降序取前 20%，其余回落点缀色 —— 全部强调等于没有强调。
	const cap = Math.ceil(ir.nodes.length * ACCENT_MAX_RATIO);
	const top = new Set(
		marked.sort((a, b) => (b.mark?.level ?? 0) - (a.mark?.level ?? 0)).slice(0, cap).map((n) => n.id),
	);
	return new Map(ir.nodes.map((n) => [n.id, top.has(n.id) ? "accent" : n.type !== undefined ? "primary" : "muted"]));
}

export function edgeDirected(ir: GraphIR, e: GraphIREdge): boolean {
	return e.kind === "dependency" || (e.kind === "flow" && ir.relation === "dependency");
}
```

- [ ] **Step 4: 跑测试确认绿**

- [ ] **Step 5: 渲染层落地**
  1. 边的 `marker-end` 只在 `PlacedEdge.directed === true` 时输出；
  2. 分组容器（原本 :375 的实线分隔线 / 分组背景）改 `stroke-dasharray="4 3"` 的虚线框；
  3. `render-canvas-view.ts:644` 给 `buildLayoutSvg` 传入 `relation`（当前只传了 `drawEdges`，需确认 `LayoutOpts.drawEdges` 与 `relation` 的对应关系保持一致）。

- [ ] **Step 6: 跑既有回归 + 重新生成黄金快照并 diff**

确认变化只包含：箭头的增删、容器的实线→虚线。

- [ ] **Step 7: 变异验证（两次）**
  ① 把 `ACCENT_MAX_RATIO` 改成 1.0 ⇒ R5 用例转红。
  ② 把 `edgeDirected` 恒返回 `true` ⇒ category 无向用例转红。

- [ ] **Step 8: Commit**

---

## 验收清单（全部任务完成后）

- [ ] `cd services/pi-runtime && ../../node_modules/.bin/tsx --test src/graph/**/*.test.ts src/tools/render-canvas-view*.test.ts` 全绿
- [ ] `./services/pi-runtime/node_modules/.bin/tsc --noEmit -p services/pi-runtime` 无新增错误
- [ ] `verify-spec-figures` / `verify-claims` / `verify-links` / `verify-tool-contract` / `verify-tool-tiering` 全 0 错误
- [ ] D2 阶段的黄金快照在 Task 6 结束时**仍逐字节不变**（Task 7–9 的三次重生成各自有 diff 说明）
- [ ] 每个纯函数（`resolveView` / `condenseLabel` / `layoutLayout` / `layoutTree` / `layoutTimelineFlow` / `layoutSwimlane` / `layoutMatrix` / `layoutCompact` / `visualRoles` / `edgeDirected`）都做过至少一次变异验证，且写在提交信息里
- [ ] **目视验收**（规格 §10.1）：深浅两种主题各截一张图，与图 3 右侧对照 —— 这一条**本计划做不到**（前端不在范围内），需 D4 计划补

## 下一步

D2+D3 合并后，另开两份计划：
- **D4**：`apps/web` 的 `AgentNodeGraph.vue` 消费 IR + 视觉角色；呈现分工；嵌入画布为结构化节点组（不是位图）。
- **D5**：触发规则对齐 + `source=knowledge` / `mixed`。⛔ **前置是需求侧证据**（当前用户明确要图仅占轮次 1.2%），不是 D4 完成。
