# 工具契约标准化 + 画布渲染卡片 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 pi-runtime agent 加一个只读 SVG 渲染卡片工具（`render_canvas_view`），并落地 5 项工具契约标准化（含vendor 契约面漂移机检）。

**Architecture:** 工具走既有 `canvas_command` SSE 通道（`details.canvasCommands` → Nest `extractCanvasCommands` → 前端），产出 `type:"svg_card"` 携带净化后的 SVG。落库走 `executionEvents`（与 `ask_user` 同款），刷新后前端重放恢复。前端新增 `AgentSvgCard.vue` 用原生 `DOMParser` 白名单净化后注入，**不用 iframe**（无 CSP 兜底）。

**Tech Stack:** TypeScript · typebox · NestJS · Vue 3 (`<script setup lang="ts">`) · node:test (pi-runtime) · vitest (web) · tsx (scripts)

**Spec:** `docs/superpowers/specs/2026-10-03-tool-contract-and-canvas-render-card-design.md`（343 行）

## Global Constraints

- **基线必须是 `origin/master`，不是本地 `master`**。本地 master `8e18810` 落后 origin/master `a561d2d`，且主仓有 20+ 文件并行改动（含已暂存删除 `D charts/pi-lnk-runtime/templates/configmap.yaml`）。**严禁**在主仓直接开工，**严禁** `git reset --hard`。
- **工作目录**：用 `git worktree add` 从 `origin/master` 建隔离 worktree（分支 `feat/canvas-view-card`）。worktree 内跑测试前需软链三处 `node_modules`（根 / `services/pi-runtime` / `apps/web`），**不必 `pnpm install`**。
- **提交纪律**：主仓有并行窗口时 `git commit -o <path>` 只提交指定路径；`git add <单文件>` 防不住已暂存内容。
- **`prompt-registry` 已在 `origin/master`**（实测 `git ls-tree origin/master:prompt-registry` → `MANIFEST.yaml` + `rules/` 8 条），`pnpm prompt:lint` 脚本**已存在**。新增规则必须同步 4 处：`rules/*.md` 文件、`MANIFEST.yaml`、`COMPOSED_IDS`、`FALLBACK_BY_ID` + `prompt-registry.fallback.ts` 常量。**不需要**新建 lint 基础设施。
- **CI 目前不跑 `prompt:lint`**（实测 `git show origin/master:.github/workflows/ci.yml | grep -c prompt:lint` → `0`）。本plan 顺带把它接进 CI。
- **提交前必须跑 `pnpm -r build`（tsc）**。vitest 走 esbuild 只转译不查类型，vitest 绿 ≠ tsc 绿。
- **不新增运行时依赖**。SVG 净化用浏览器原生 `DOMParser`，不引 DOMPurify（供应链面）。
- **不复活 `topo_preview` 老通道**、**不改存量 40 个工具的 return 形状**、**不动画布节点类型**（spec §2 显式不做清单）。
- **`overlay` + `view='topology'` 必须返回错误**，不静默忽略。

## Review Focus

以下五条是 spec 暗示但没有任务正面覆盖的输入/情形，最可能咬人。每条已在对应 Task 里给了钉住它的测试。

1. **SVG 文本节点里的用户内容含 `<`/`&`/`"`** —— 节点标题是用户输入，未 `escapeHtml` 则标签被解析，卡片内容静默丢失。→ Task 5
2. **`svg_card` 与 `ask_user` 在同一轮同时产出** —— Nest `:1002` 落库条件扩为 `ask_user || svg_card` 后，`ask_user` 的 callId 去重逻辑（`findIndex` + `splice`）不能误删 svg_card 条目。→ Task 7
3. **同一轮产出两张 svg_card** —— `lastAssistant().presentation` 是单值，后一张会覆盖前一张。判据：明确接受"最后一张胜出"，并写测试锁死该行为，不留未定义语义。→ Task 6
4. **`overlay` 数据结构非法**（如 `kind:'emotion'` 但 `data` 不是数组）—— 静默渲染空轨道会让 agent 以为叠加生效了。→ Task 4
5. **刷新后 `executionEvents` 重放时 `canvas_command` 事件到达早于 assistant 消息创建** —— `replayExecutionTraceEvents` 走 `loadHistory`，若重放逻辑假设消息已存在会崩或丢卡。→ Task 7

---

## File Structure

| 文件 | 责任 |
|---|---|
| `services/pi-runtime/src/tools/types.ts` | `ToolTier` 加 `present` |
| `services/pi-runtime/src/tools/present-result.ts` | 只读投影的统一返回构造器 + SVG 长度上界 |
| `services/pi-runtime/src/tools/svg-sanitize.ts` | 服务端最小转义（agent 侧产出即已转义，不依赖前端救） |
| `services/pi-runtime/src/tools/render-canvas-view.ts` | 工具定义：读画布 → 组装 SVG → `presentResult` |
| `services/pi-runtime/src/tools/registry.ts` | 装配 `buildRenderCanvasViewTools` |
| `services/pi-runtime/src/tools/tiering.ts` | `ALWAYS_ON_TOOL_NAMES` 加名 + `:126` 旁加注释 |
| `apps/server/src/agent/pi-runtime/pi-events.ts` | `PiCanvasCommand` 加字段（不改 filter） |
| `apps/server/src/agent/agent.service.ts` | 落库条件扩为 `ask_user \|\| svg_card` |
| `apps/web/src/stores/agent.ts` | `setPresentation()` + 重放恢复 |
| `apps/web/src/components/agent/executionTraceReducer.ts` | `canvas_command`+`svg_card` 重放分支 |
| `apps/web/src/components/agent/AgentSideRail.vue` | `svg_card` switch 分支 + 模板挂载点 |
| `apps/web/src/components/agent/presentation/AgentSvgCard.vue` | 前端白名单净化 + 注入 + 降级 |
| `prompt-registry/rules/canvas_view_policy.md` | 何时调（三层 when + 负向黑名单） |
| `scripts/lint-tool-descriptions.ts` | description 四条惯例校验 |
| `scripts/verify-tool-contract.ts` | vendor 契约面漂移机检 A1–A4 |

---

## Task 1: `present` tier + `presentResult` 构造器

**Files:**
- Modify: `services/pi-runtime/src/tools/types.ts`（`ToolTier`，第 12-20 行）
- Create: `services/pi-runtime/src/tools/present-result.ts`
- Test: `services/pi-runtime/src/tools/present-result.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  ```ts
  // present-result.ts
  export const SVG_MAX_CHARS = 20000;
  export interface SvgCardPayload {
    type: "svg_card";
    svg: string;
    title?: string;
    annotations?: Array<{ nodeId: string; text: string; severity: "info" | "warn" }>;
  }
  export function presentResult(payload: SvgCardPayload): {
    content: [{ type: "text"; text: string }];
    details: { ok: true; canvasCommands: SvgCardPayload[]; truncated?: boolean };
  };
  ```
  `ToolTier` 新增字面量 `"present"`。

- [ ] **Step 1: 建 worktree 并软链 node_modules**

```bash
cd /Users/4seven/workspace/pi-lnk
git fetch origin
git worktree add .worktrees/canvas-view-card -b feat/canvas-view-card origin/master
cd .worktrees/canvas-view-card
for p in . services/pi-runtime apps/web; do ln -s /Users/4seven/workspace/pi-lnk/$p/node_modules $p/node_modules; done
ls -l services/pi-runtime/node_modules | head -1   # 确认是 symlink
```

预期：`services/pi-runtime/node_modules` 指向主仓。若 `ln` 报已存在，用 `ln -sf`。

- [ ] **Step 2: 写失败测试**

`services/pi-runtime/src/tools/present-result.test.ts`：

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { presentResult, SVG_MAX_CHARS } from "./present-result.js";

describe("presentResult", () => {
  it("把 payload 放进 details.canvasCommands（不是 content）", () => {
    const r = presentResult({ type: "svg_card", svg: "<svg/>" });
    assert.equal(r.details.ok, true);
    assert.equal(r.details.canvasCommands.length, 1);
    assert.equal(r.details.canvasCommands[0].type, "svg_card");
    // content 只是回显，真实载荷必须在 details
    assert.ok(r.content[0].text.includes("svg_card"));
  });

  it("svg 超上界时截断并置 truncated=true", () => {
    const long = "<svg>" + "x".repeat(SVG_MAX_CHARS) + "</svg>";
    const r = presentResult({ type: "svg_card", svg: long });
    assert.equal(r.details.truncated, true);
    assert.ok(r.details.canvasCommands[0].svg.length < long.length);
  });

  it("未超上界时不带 truncated 键", () => {
    const r = presentResult({ type: "svg_card", svg: "<svg/>" });
    assert.equal("truncated" in r.details, false);
  });

  it("annotations 透传且 severity 原样保留", () => {
    const r = presentResult({
      type: "svg_card",
      svg: "<svg/>",
      annotations: [{ nodeId: "n1", text: "超时长", severity: "warn" }],
    });
    assert.equal(r.details.canvasCommands[0].annotations?.[0].severity, "warn");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/present-result.test.ts
```

预期：FAIL，报 `Cannot find module './present-result.js'`。

- [ ] **Step 4: 实现 `present-result.ts`**

```ts
/**
 * 只读可视投影（tier="present"）的统一返回构造器。
 *
 * ⚠️ `canvasCommands` **必须**在 `details` 下：Nest 侧 `extractCanvasCommands`
 * 只从 `tool_execution_end.result.details.canvasCommands` / `tool_execution_update
 * .partialResult.details.canvasCommands` 提取（apps/server/src/agent/pi-runtime/
 * pi-events.ts:297-326）。放回 content 会被模型当文本读、卡片不落屏——
 * 与 `result-with-actions.ts` 文件头记录的 PR #65 同款失败模式。
 */
import type { SvgCardPayload } from "./types-payload.js";

/** SVG 长度上界：超了截断并在 details 显式回报，防超长撑爆气泡。 */
export const SVG_MAX_CHARS = 20000;

export function presentResult(payload: SvgCardPayload): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: SvgCardPayload[]; truncated?: boolean };
} {
	const truncated = payload.svg.length > SVG_MAX_CHARS;
	const svg = truncated ? payload.svg.slice(0, SVG_MAX_CHARS) : payload.svg;
	const clipped: SvgCardPayload = { ...payload, svg };
	const details: {
		ok: true;
		canvasCommands: SvgCardPayload[];
		truncated?: boolean;
	} = { ok: true, canvasCommands: [clipped] };
	if (truncated) details.truncated = true;
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: !truncated, canvasCommands: [clipped] }) }],
		details,
	};
}
```

在 `services/pi-runtime/src/tools/types-payload.ts` 新建类型（避免与 `types.ts` 的 `ToolTier` 循环依赖）：

```ts
/** tier="present" 工具产出的只读可视投影载荷（spec §4.2/§4.3）。 */
export interface SvgCardPayload {
	type: "svg_card";
	svg: string;
	title?: string;
	annotations?: Array<{ nodeId: string; text: string; severity: "info" | "warn" }>;
}
```

- [ ] **Step 5: `types.ts` 加 `present` tier**

把第 12-20 行的 `ToolTier` 改为：

```ts
export type ToolTier =
	| "read"
	| "write_light"
	| "lifecycle"
	| "gen"
	| "graph_batch"
	| "destructive"
	| "ui_command"
	| "skill"
	/**
	 * 只读可视投影：产出**给用户看**的卡片，不写库、不改节点、不参与编排。
	 * 与 `ui_command` 的区别：ui_command 是"命令前端做事"（focus/undo），
	 * 本值是"agent 产出一份只读投影数据"。
	 */
	| "present";
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/present-result.test.ts
```

预期：4 个 test 全 PASS。

- [ ] **Step 7: 类型检查 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit
git commit -o services/pi-runtime/src/tools/types.ts -o services/pi-runtime/src/tools/types-payload.ts -o services/pi-runtime/src/tools/present-result.ts -o services/pi-runtime/src/tools/present-result.test.ts -m "feat(tools): 新增 present tier 与 presentResult 构造器"
```

预期：tsc 无错误；`git show --stat --oneline HEAD | tail -5` 显示恰好 4 个文件。

---

## Task 2: `render_canvas_view` 工具 —— 参数校验与只读契约

**Files:**
- Create: `services/pi-runtime/src/tools/render-canvas-view.ts`
- Test: `services/pi-runtime/src/tools/render-canvas-view.test.ts`

**Interfaces:**
- Consumes: `presentResult` / `SvgCardPayload`（Task 1）
- Produces:
  ```ts
  // render-canvas-view.ts
  export type ViewKind = "timeline" | "topology" | "table";
  export type OverlayKind = "emotion" | "budget" | "severity";
  export function buildTimelineSvg(rows: TimelineRow[], overlay?: Overlay): string;
  export function buildTopologySvg(nodes: TopoNode[], edges: TopoEdge[]): string;
  export function buildTableSvg(rows: TableRow[], overlay?: Overlay): string;
  export function createRenderCanvasViewTools(deps: {
    fetchLayout: (sessionId: string) => Promise<unknown>;
  }): LnkpiTool[];
  ```
  其中 `TimelineRow = { shotId: string; label: string; durationSec: number; dialogueChars?: number; emotion?: number }`。

**本 Task 只做参数校验 + SVG 构造函数 + 读画布，不做前端。**

- [ ] **Step 1: 写失败测试（参数校验与只读契约）**

`services/pi-runtime/src/tools/render-canvas-view.test.ts`：

```ts
import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import { createRenderCanvasViewTools, buildTimelineSvg } from "./render-canvas-view.js";

const LAYOUT = {
	nodes: [
		{ id: "n1", type: "prompt", title: "镜头 1", position: { x: 0, y: 0 } },
		{ id: "n2", type: "prompt", title: "镜头 2", position: { x: 100, y: 0 } },
		{ id: "n3", type: "prompt", title: "镜头 3", position: { x: 200, y: 0 } },
	],
	edges: [{ source: "n1", target: "n2" }],
};

function makeTool(overrides: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const tools = createRenderCanvasViewTools({
		fetchLayout: async () => {
			calls.push("fetchLayout");
			return LAYOUT;
		},
	});
	const tool = tools.find((t) => t.name === "render_canvas_view")!;
	return { tool, calls };
}

async function run(tool: ReturnType<typeof makeTool>["tool"], params: unknown) {
	return tool.execute("call-1", params as never, () => {}, { sessionId: "s1" }, {} as never, {} as never);
}

describe("render_canvas_view 参数契约", () => {
	it("overlay 传给 topology 时返回 ok:false 而非静默忽略", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "topology", overlay: { kind: "emotion", data: {} } });
		assert.equal((r.details as { ok: boolean }).ok, false);
		assert.match((r.details as { error: string }).error, /overlay/);
	});

	it("overlay.kind 非枚举值时返回 ok:false", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "timeline", overlay: { kind: "bogus", data: [] } });
		assert.equal((r.details as { ok: boolean }).ok, false);
	});

	it("数据源节点不存在时返回 ok:false 且不编造行", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "timeline", node_ids: ["不存在"] });
		const d = r.details as { ok: boolean; missing?: string[] };
		assert.equal(d.ok, false);
		assert.deepEqual(d.missing, ["不存在"]);
	});

	it("view 缺省时默认 timeline", async () => {
		const { tool } = makeTool();
		const r = await run(tool, {});
		assert.equal((r.details as { ok: boolean }).ok, true);
	});

	it("不调任何 Nest 写端点：只读 fetchLayout 一次", async () => {
		const { tool, calls } = makeTool();
		await run(tool, { view: "topology" });
		assert.deepEqual(calls, ["fetchLayout"]);
	});
});

describe("buildTimelineSvg", () => {
	it("超预算行（台词字数 > 时长 × 4.5）带 warn class", () => {
		const svg = buildTimelineSvg([
			{ shotId: "S1", label: "镜1", durationSec: 2, dialogueChars: 20 },
		]);
		assert.match(svg, /warn/);
	});

	it("未超预算不带 warn class", () => {
		const svg = buildTimelineSvg([
			{ shotId: "S1", label: "镜1", durationSec: 10, dialogueChars: 20 },
		]);
		assert.doesNotMatch(svg, /warn/);
	});

	it("overlay=emotion 时输出情绪折线 polyline", () => {
		const svg = buildTimelineSvg(
			[
				{ shotId: "S1", label: "镜1", durationSec: 3, emotion: 2 },
				{ shotId: "S2", label: "镜2", durationSec: 3, emotion: 8 },
			],
			{ kind: "emotion", data: {} },
		);
		assert.match(svg, /<polyline/);
	});

	it("overlay=data 非数组时抛错而非渲染空轨道", () => {
		assert.throws(
			() =>
				buildTimelineSvg([{ shotId: "S1", label: "a", durationSec: 1 }], {
					kind: "emotion",
					data: { bad: true },
				} as never),
			/emotion/,
		);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/render-canvas-view.test.ts
```

预期：FAIL，`Cannot find module './render-canvas-view.js'`。

- [ ] **Step 3: 实现 `render-canvas-view.ts`（第一版：校验 + SVG 构造）**

```ts
/**
 * render_canvas_view（tier="present"）：把画布上已有的节点/边/表格以只读 SVG 卡片呈现。
 *
 * spec docs/superpowers/specs/2026-10-03-tool-contract-and-canvas-render-card-design.md
 * §4.1 落点判据 / §4.5 SVG 安全 / §4.7 视图维度 / §5.1 入参契约。
 *
 * 行为契约（不可放宽）：
 *   - **只读**：只调 fetchLayout，不 POST 任何 Nest 写端点
 *   - **不编造**：数据源缺失 → ok:false + missing 清单，不填假行
 *   - **非静默降级**：overlay 传给 topology → 报错，不忽略
 *   - **不阻塞**：不 await 用户，立即 resolve
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import { presentResult } from "./present-result.js";

const VIEWS = ["timeline", "topology", "table"] as const;
const OVERLAYS = ["emotion", "budget", "severity"] as const;

export type ViewKind = (typeof VIEWS)[number];
export type OverlayKind = (typeof OVERLAYS)[number];

export interface TimelineRow {
	shotId: string;
	label: string;
	durationSec: number;
	dialogueChars?: number;
	emotion?: number;
}
export interface TopoNode { id: string; title: string }
export interface TopoEdge { source: string; target: string }
export interface TableRow { id: string; cells: string[] }
export interface Overlay { kind: OverlayKind; data: unknown }

/** 中文口播语速上限：4–5 字/秒，取 4.5 作判据（spec §5.1）。 */
const CHARS_PER_SEC = 4.5;

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** overlay 形状校验：kind 必须在枚举内，data 必须是数组（emotion/budget/severity 一致）。 */
function assertOverlay(overlay: Overlay | undefined): void {
	if (!overlay) return;
	if (!OVERLAYS.includes(overlay.kind)) {
		throw new Error(`overlay.kind 非法：${String(overlay.kind)}，可选 ${OVERLAYS.join(" | ")}`);
	}
	if (!Array.isArray(overlay.data)) {
		throw new Error(`overlay.kind=${overlay.kind} 的 data 必须是数组，收到 ${typeof overlay.data}`);
	}
}

export function buildTimelineSvg(rows: TimelineRow[], overlay?: Overlay): string {
	assertOverlay(overlay);
	const W = 720;
	const rowH = 34;
	const trackH = overlay ? 90 : 0;
	const h = 40 + rows.length * rowH + trackH;
	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img">`,
		`<style>.bar{fill:#dbe4ee}.bar.over{fill:#f2b8b5}.lbl{font:12px sans-serif;fill:#334}.warn{stroke:#c0392b;stroke-width:2}</style>`,
	];
	rows.forEach((r, i) => {
		const y = 30 + i * rowH;
		const w = Math.max(4, Math.round((r.durationSec / 20) * (W - 160)));
		const over = r.dialogueChars !== undefined && r.dialogueChars > r.durationSec * CHARS_PER_SEC;
		parts.push(
			`<text x="8" y="${y + 14}" class="lbl">${esc(r.label)}</text>`,
			`<rect x="120" y="${y}" width="${w}" height="20" class="bar${over ? " over" : ""}"${over ? ' data-warn="1"' : ""}/>`,
			`<text x="${124 + w}" y="${y + 14}" class="lbl">${r.durationSec}s</text>`,
		);
	});
	if (overlay?.kind === "emotion") {
		const pts = rows
			.map((r, i) => `${120 + Math.round((i / Math.max(1, rows.length - 1)) * (W - 160))},${30 + rows.length * rowH + (80 - (r.emotion ?? 0))}`)
			.join(" ");
		parts.push(`<polyline points="${pts}" fill="none" stroke="#4a7ebb" stroke-width="2"/>`);
	}
	parts.push("</svg>");
	return parts.join("");
}

export function buildTopologySvg(nodes: TopoNode[], edges: TopoEdge[]): string {
	const W = 720;
	const h = 40 + nodes.length * 30;
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img">`,
		`<style>.n{fill:#eef2f7;stroke:#8aa}.t{font:12px sans-serif;fill:#334}.e{stroke:#8aa;stroke-width:1.5}</style>`,
	];
	nodes.forEach((n, i) => {
		const y = 24 + i * 30;
		parts.push(`<rect x="120" y="${y}" width="${W - 140}" height="22" class="n"/>`);
		parts.push(`<text x="128" y="${y + 15}" class="t">${esc(n.title)}</text>`);
	});
	edges.forEach((e) => {
		const a = nodes.findIndex((n) => n.id === e.source);
		const b = nodes.findIndex((n) => n.id === e.target);
		if (a < 0 || b < 0) return;
		const y1 = 24 + a * 30 + 11;
		const y2 = 24 + b * 30 + 11;
		parts.push(`<line x1="140" y1="${y1}" x2="${W - 20}" y2="${y2}" class="e"/>`);
		void byId;
	});
	parts.push("</svg>");
	return parts.join("");
}

export function buildTableSvg(rows: TableRow[], overlay?: Overlay): string {
	assertOverlay(overlay);
	const W = 720;
	const rowH = 26;
	const h = 36 + rows.length * rowH;
	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img">`,
		`<style>.t{font:12px sans-serif;fill:#334}.row0{fill:#fafbfc}.sev-error{fill:#fdecea}.sev-warn{fill:#fff6e5}</style>`,
	];
	rows.forEach((r, i) => {
		const y = 26 + i * rowH;
		const sev = overlay?.kind === "severity" ? String((overlay.data as Array<{ level?: string }>)[i]?.level ?? "") : "";
		const cls = sev === "error" ? "sev-error" : sev === "warn" ? "sev-warn" : i % 2 ? "" : "row0";
		parts.push(`<rect x="8" y="${y}" width="${W - 16}" height="${rowH - 2}" class="${cls}"/>`);
		parts.push(`<text x="14" y="${y + 16}" class="t">${esc(r.cells.join(" | "))}</text>`);
	});
	parts.push("</svg>");
	return parts.join("");
}

function fail(error: string, missing?: string[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: false; error: string; missing?: string[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: false, error, missing }) }],
		details: { ok: false, error, ...(missing ? { missing } : {}) },
	};
}

export function createRenderCanvasViewTools(deps: {
	fetchLayout: (sessionId: string) => Promise<unknown>;
}): LnkpiTool[] {
	return [
		{
			tier: "present",
			name: "render_canvas_view",
			label: "渲染画布视图卡片",
			description:
				"Render a read-only SVG card visualizing existing canvas data (shot timeline, asset-to-shot topology, or a structured table), optionally with an overlay track carrying business semantics (emotion curve, budget overrun, or severity color scale). Requires the source nodes to already exist; returns an error listing what is missing instead of inventing rows. Read-only projection: does NOT edit any node, does NOT create nodes, does NOT trigger generation — user edits go through set_node_text on the source node, then re-render. overlay=kind is rejected on view=topology rather than silently ignored. severity=warn marks items over budget (dialogue chars exceeding duration x 4.5 for Chinese at 4-5 chars/sec).",
			parameters: Type.Object({
				view: Type.Optional(
					Type.Union(VIEWS.map((v) => Type.Literal(v)), {
						description: "View shape: timeline (horizontal time axis), topology (directed dependencies), table (2D grid). Defaults to timeline.",
					}),
				),
				overlay: Type.Optional(
					Type.Object({
						kind: Type.Union(OVERLAYS.map((k) => Type.Literal(k)), {
							description: "Business-semantics overlay: emotion (intensity curve), budget (overrun highlight), severity (row color scale).",
						}),
						data: Type.Array(Type.Unknown(), { description: "Overlay payload array" }),
					}),
				),
				node_ids: Type.Optional(Type.Array(Type.String(), { description: "Source node ids; omitted means all canvas nodes" })),
				title: Type.Optional(Type.String({ description: "Card title" })),
				annotations: Type.Optional(
					Type.Array(
						Type.Object({
							node_id: Type.String({ description: "Annotated node id" }),
							text: Type.String({ description: "Annotation text" }),
							severity: Type.Union([Type.Literal("info"), Type.Literal("warn")], {
								description: "info = neutral note; warn = over budget, rendered highlighted",
							}),
						}),
						{ description: "Per-node annotations" },
					),
				),
			}),
			execute: async (_id, p: { view?: ViewKind; overlay?: Overlay; node_ids?: string[]; title?: string }, _u, tc: LnkpiToolContext) => {
				const view: ViewKind = p.view ?? "timeline";
				if (!VIEWS.includes(view)) return fail(`view 非法：${String(p.view)}，可选 ${VIEWS.join(" | ")}`);
				if (p.overlay && view === "topology") {
					return fail(`overlay not supported on view=topology（收到 kind=${String(p.overlay.kind)}）`);
				}
				if (p.overlay) {
					try {
						assertOverlay(p.overlay);
					} catch (err) {
						return fail(err instanceof Error ? err.message : String(err));
					}
				}
				const raw = (await deps.fetchLayout(tc.sessionId)) as {
					nodes?: Array<{ id: string; title?: string; type?: string }>;
					edges?: Array<{ source: string; target: string }>;
				};
				const allNodes = raw?.nodes ?? [];
				const known = new Set(allNodes.map((n) => n.id));
				const wanted = p.node_ids ?? allNodes.map((n) => n.id);
				const missing = wanted.filter((id) => !known.has(id));
				if (missing.length > 0) {
					return fail(`数据源节点不存在：${missing.join("、")}`, missing);
				}
				const nodes = allNodes.filter((n) => wanted.includes(n.id));
				const svg =
					view === "topology"
						? buildTopologySvg(
								nodes.map((n) => ({ id: n.id, title: n.title ?? n.id })),
								(raw?.edges ?? []).filter((e) => wanted.includes(e.source) && wanted.includes(e.target)),
							)
						: view === "table"
							? buildTableSvg(
									nodes.map((n) => ({ id: n.id, cells: [n.id, n.title ?? ""] })),
									p.overlay,
								)
							: buildTimelineSvg(
									nodes.map((n, i) => ({
										shotId: n.id,
										label: n.title ?? n.id,
										durationSec: i + 1,
									})),
									p.overlay,
								);
				return presentResult({
					type: "svg_card",
					svg,
					...(p.title ? { title: p.title } : {}),
					...(p.annotations
						? {
								annotations: p.annotations.map((a) => ({
									nodeId: a.node_id,
									text: a.text,
									severity: a.severity,
								})),
							}
						: {}),
				});
			},
		},
	];
}
```

**注意**：上面的 `execute` 里 `p.annotations` 的类型未在签名里声明——把签名补成：

```ts
execute: async (
	_id,
	p: {
		view?: ViewKind;
		overlay?: Overlay;
		node_ids?: string[];
		title?: string;
		annotations?: Array<{ node_id: string; text: string; severity: "info" | "warn" }>;
	},
	_u,
	tc: LnkpiToolContext,
) => {
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/render-canvas-view.test.ts
```

预期：9 个 test 全 PASS（5 契约 + 4 SVG）。

若 `overlay=data 非数组` 那条失败，说明 `assertOverlay` 被 `execute` 里的 try 吞了——测试直接调 `buildTimelineSvg` 不经 `execute`，不会被吞；此时检查 `assertOverlay` 是否真的在 `buildTimelineSvg` 首行调用。

- [ ] **Step 5: 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
git commit -o services/pi-runtime/src/tools/render-canvas-view.ts -o services/pi-runtime/src/tools/render-canvas-view.test.ts -m "feat(tools): 新增 render_canvas_view 只读投影工具"
```

---

## Task 3: 装配 + tiering 常驻 + Nest 字段

**Files:**
- Modify: `services/pi-runtime/src/tools/registry.ts`
- Modify: `services/pi-runtime/src/tools/tiering.ts`（`ALWAYS_ON_TOOL_NAMES` 第 22-62 行；`:126` 加注释）
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（`PiCanvasCommand` 第 271-283 行）
- Test: `services/pi-runtime/src/tools/tiering.test.ts`（改）

**Interfaces:**
- Consumes: `createRenderCanvasViewTools`（Task 2）
- Produces: `registry.ts` 导出 `buildRenderCanvasViewTools(client: NestClient): LnkpiTool[]`

- [ ] **Step 1: 写失败测试（tiering）**

在 `services/pi-runtime/src/tools/tiering.test.ts` 末尾追加：

```ts
import { ALWAYS_ON_TOOL_NAMES } from "./tiering.js";

describe("render_canvas_view 常驻", () => {
	it("必须在 ALWAYS_ON_TOOL_NAMES 内（延迟工具触发率为 0，延迟即不可达）", () => {
		assert.equal(ALWAYS_ON_TOOL_NAMES.has("render_canvas_view"), true);
	});
});
```

若该文件已有 `describe` 块，把 import 合并到文件顶部既有 import 区，不要重复引入 `assert`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/tiering.test.ts
```

预期：FAIL，`false !== true`。

- [ ] **Step 3: `tiering.ts` 加名**

在 `ALWAYS_ON_TOOL_NAMES` 里 `"arrange_nodes",` 那行之后插入：

```ts
	// present（2026-10-03 spec §5.2）：解释/澄清类高频场景要出图，
	// 放进延迟集 = 依赖 load_tools 激活，而 load_tools 触发率实测为 0 ⇒ 延迟即不可达。
	"render_canvas_view",
```

并在 `createLoadToolsTool` 返回值的 `} as LnkpiTool;`（约第 126 行）**正上方**加注释，不改代码：

```ts
	// ⚠️ 这处 `as LnkpiTool` 是全仓唯一的类型逃逸口（spec §4.8 A3）。
	// scripts/verify-tool-contract.ts 的 A3 断言会统计逃逸口数量：新增逃逸口即红。
	// 清理它要改 createLoadToolsTool 的返回类型推导（属存量整改，spec §2 明确不做）。
	} as LnkpiTool;
```

- [ ] **Step 4: `registry.ts` 装配**

在 import 区加：

```ts
import { createRenderCanvasViewTools } from "./render-canvas-view.js";
```

在文件末尾加：

```ts
/**
 * present 批次：render_canvas_view（tier=present，spec 2026-10-03 §5.1）。
 * 纯只读：只走 client.get /agent/internal/get-canvas-layout，不 POST 任何写端点。
 */
export function buildRenderCanvasViewTools(client: NestClient): LnkpiTool[] {
	return createRenderCanvasViewTools({
		fetchLayout: async (sessionId) => client.get("/agent/internal/get-canvas-layout", { sessionId }),
	});
}
```

**先核实 `NestClient` 的真实方法名**：读 `services/pi-runtime/src/tools/nest-client.ts`。若没有 `get`，改用 `post`（`canvas-read.ts:129` 用的是 `client.post("/agent/internal/get-canvas-layout", { sessionId })`）——**以实测为准，不要照抄上面的 `client.get`**。

- [ ] **Step 5: `pi-events.ts` 加字段**

把 `PiCanvasCommand`（第 271-283 行）末尾的 `}` 之前插入：

```ts
	/** render_canvas_view 工具产出；仅 type="svg_card" 时有。extractCanvasCommands filter 不变（只校验 type:string），新字段透传。 */
	svg?: string;
	title?: string;
	annotations?: Array<{ nodeId: string; text: string; severity: "info" | "warn" }>;
```

- [ ] **Step 6: 跑测试 + 类型检查**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/tiering.test.ts src/tools/render-canvas-view.test.ts
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit
pnpm --filter @lnkpi/server exec tsc --noEmit
```

预期：全绿。

- [ ] **Step 7: 提交**

```bash
git commit -o services/pi-runtime/src/tools/registry.ts -o services/pi-runtime/src/tools/tiering.ts -o services/pi-runtime/src/tools/tiering.test.ts -o apps/server/src/agent/pi-runtime/pi-events.ts -m "feat(tools): 装配 render_canvas_view 并登记 svg_card 通道字段"
```

---

## Task 4: 前端 `AgentSvgCard.vue` 白名单净化

**Files:**
- Create: `apps/web/src/components/agent/presentation/AgentSvgCard.vue`
- Create: `apps/web/src/components/agent/presentation/AgentSvgCard.test.ts`
- Modify: `apps/web/src/components/agent/presentation/types.ts`（`AgentPresentationBody` 加 `svg?`/`annotations?`）

**Interfaces:**
- Consumes: 无前端依赖（独立组件）
- Produces:
  ```ts
  // AgentSvgCard.vue
  const props: { svg: string; title?: string; annotations?: Array<{ nodeId: string; text: string; severity: 'info'|'warn' }> }
  // 渲染 <div data-testid="svg-card"> 或降级 <pre data-testid="svg-card-fallback">
  ```
  导出纯函数供测试：`export function sanitizeSvg(dirty: string): { ok: boolean; svg: string }`

**本 Task 解决 Review Focus #1（用户内容含 `<`/`&`/`"`）。**

- [ ] **Step 1: 写失败测试**

`apps/web/src/components/agent/presentation/AgentSvgCard.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentSvgCard from './AgentSvgCard.vue'

const wrap = (svg: string) => mount(AgentSvgCard, { props: { svg } })

describe('AgentSvgCard 净化', () => {
  it('剥离 script 标签', () => {
    const w = wrap('<svg><script>alert(1)</script><rect/></svg>')
    expect(w.element.querySelector('script')).toBeNull()
  })

  it('剥离 on* 事件属性', () => {
    const w = wrap('<svg><rect onclick="alert(1)" onload="x()"/></svg>')
    const rect = w.element.querySelector('rect')!
    expect(rect.getAttribute('onclick')).toBeNull()
    expect(rect.getAttribute('onload')).toBeNull()
  })

  it('剥离 foreignObject', () => {
    const w = wrap('<svg><foreignObject><div>x</div></foreignObject></svg>')
    expect(w.element.querySelector('foreignObject')).toBeNull()
  })

  it('剥离 javascript: href', () => {
    const w = wrap('<svg><a href="javascript:alert(1)"><rect/></a></svg>')
    const a = w.element.querySelector('a')
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:')
  })

  it('剥离外部 url() 引用', () => {
    const w = wrap('<svg><rect fill="url(https://evil.example/x)"/></svg>')
    expect(w.element.innerHTML).not.toContain('evil.example')
  })

  it('输入不是合法 SVG 时降级为 pre 且不崩', () => {
    const w = wrap('这不是 svg <<<')
    expect(w.find('[data-testid="svg-card-fallback"]').exists()).toBe(true)
  })

  it('合法 SVG 正常渲染容器', () => {
    const w = wrap('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(true)
  })

  it('Review Focus #1：节点标题含尖括号时不被当成标签解析', () => {
    const w = wrap('<svg xmlns="http://www.w3.org/2000/svg"><text>&lt;script&gt;x&lt;/script&gt;</text></svg>')
    // 文本节点里的 <script> 必须保持为文本，不能变成元素
    expect(w.element.querySelector('text script')).toBeNull()
    expect(w.html()).toContain('&lt;script&gt;')
  })

  it('annotations 渲染且 warn 有区别样式', () => {
    const w = mount(AgentSvgCard, {
      props: {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
        annotations: [{ nodeId: 'n1', text: '超时长', severity: 'warn' }],
      },
    })
    expect(w.text()).toContain('超时长')
    expect(w.html()).toContain('warn')
  })
})
```

**先核实测试工具**：`apps/web/package.json` 是否有 `@vue/test-utils`。若无，本 Task 改为纯函数测试——把净化逻辑抽到 `apps/web/src/components/agent/presentation/svg-sanitize.ts`，测该纯函数（`sanitizeSvg`），组件挂载测试留到 Task 6 一并做。**不要为了测试装新依赖**（Global Constraints 禁新增运行时依赖；devDependency 也先问）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/agent/presentation/AgentSvgCard.test.ts
```

预期：FAIL，找不到模块。

- [ ] **Step 3: 实现 `svg-sanitize.ts`（纯函数，可单测）**

`apps/web/src/components/agent/presentation/svg-sanitize.ts`：

```ts
/**
 * agent 产出的 SVG 是**不可信输入**（节点标题、表格文本都来自用户）。
 * 净化用浏览器原生 DOMParser，不引 DOMPurify（spec §4.5：不新增依赖）。
 *
 * 剥离清单：script / foreignObject / on* 事件属性 / javascript: href / 外部 url() 引用。
 * 未知或非 SVG 根节点 → ok:false，调用方降级 <pre>。
 */

const BANNED_TAGS = new Set(['script', 'foreignObject', 'iframe', 'object', 'embed', 'use'])

export function sanitizeSvg(dirty: string): { ok: boolean; svg: string } {
  if (typeof dirty !== 'string' || dirty.trim() === '') return { ok: false, svg: '' }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(dirty, 'image/svg+xml')
  } catch {
    return { ok: false, svg: '' }
  }
  const root = doc.documentElement
  // image/svg+xml 解析失败时浏览器会产出 <parsererror> 根
  if (!root || root.nodeName === 'parsererror' || root.nodeName.toLowerCase() !== 'svg') {
    return { ok: false, svg: '' }
  }
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (BANNED_TAGS.has(child.nodeName)) {
        child.remove()
        continue
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value.trim().toLowerCase()
        if (name.startsWith('on')) child.removeAttribute(attr.name)
        else if ((name === 'href' || name === 'xlink:href') && value.startsWith('javascript:')) {
          child.removeAttribute(attr.name)
        } else if (name === 'style' && /url\s*\(\s*['"]?https?:/i.test(attr.value)) {
          child.removeAttribute(attr.name)
        } else if (name === 'fill' && /url\s*\(\s*['"]?https?:/i.test(attr.value)) {
          child.removeAttribute(attr.name)
        }
      }
      walk(child)
    }
  }
  walk(root)
  return { ok: true, svg: new XMLSerializer().serializeToString(root) }
}
```

- [ ] **Step 4: 实现 `AgentSvgCard.vue`**

```vue
<script setup lang="ts">
/**
 * 只读 SVG 卡片（spec §4.5 / §4.7）。
 * 输入是 agent 产出的不可信 SVG ⇒ 必须经 sanitizeSvg 白名单净化后才注入。
 * 净化失败降级 <pre>，不抛错、不阻塞卡片其余内容（对齐 AgentMermaidBlock 的降级范式）。
 *
 * ⚠️ 本组件**不含 stepper**：svg_card 走 executionEvents 落库恢复（无 stepper 字段），
 * 不能塞进 AgentPresentationHost 的 stepper 布局。
 */
import { computed } from 'vue'
import { sanitizeSvg } from './svg-sanitize'

const props = defineProps<{
  svg: string
  title?: string
  annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }>
}>()

const clean = computed(() => sanitizeSvg(props.svg))
</script>

<template>
  <figure class="agent-svg-card rounded-lg border p-3" data-testid="svg-card-figure">
    <figcaption v-if="title" class="mb-2 text-xs font-medium">{{ title }}</figcaption>
    <div
      v-if="clean.ok"
      class="agent-svg-card__canvas text-[var(--neo-fg)]"
      data-testid="svg-card"
      v-html="clean.svg"
    />
    <pre
      v-else
      class="whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--neo-muted)]"
      data-testid="svg-card-fallback"
    >{{ svg }}</pre>
    <ul v-if="annotations?.length" class="mt-2 space-y-0.5 text-[10px]">
      <li
        v-for="a in annotations"
        :key="a.nodeId"
        :class="a.severity === 'warn' ? 'text-red-600 font-medium' : 'text-[var(--neo-muted)]'"
      >{{ a.text }}</li>
    </ul>
  </figure>
</template>
```

- [ ] **Step 5: `types.ts` 加字段**

在 `AgentPresentationBody` 里 `mermaid?: string` 之后插入：

```ts
  /** render_canvas_view 产出：净化前 SVG（spec §4.5）。 */
  svg?: string
  annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }>
```

- [ ] **Step 6: 跑测试**

```bash
cd apps/web && npx vitest run src/components/agent/presentation/AgentSvgCard.test.ts
```

预期：9 个 test 全 PASS。

若 `@vue/test-utils` 缺失（Step 1 已说明），改测纯函数：

```ts
import { describe, it, expect } from 'vitest'
import { sanitizeSvg } from './svg-sanitize'

describe('sanitizeSvg', () => {
  it('剥离 script', () => {
    const r = sanitizeSvg('<svg><script>alert(1)</script><rect/></svg>')
    expect(r.ok).toBe(true)
    expect(r.svg).not.toContain('script')
  })
  it('剥离 on*', () => {
    const r = sanitizeSvg('<svg><rect onclick="x()"/></svg>')
    expect(r.svg).not.toContain('onclick')
  })
  it('剥离 foreignObject', () => {
    expect(sanitizeSvg('<svg><foreignObject/></svg>').svg).not.toContain('foreignObject')
  })
  it('剥离 javascript: href', () => {
    expect(sanitizeSvg('<svg><a href="javascript:x()"/></svg>').svg).not.toContain('javascript:')
  })
  it('剥离外部 url()', () => {
    expect(sanitizeSvg('<svg><rect fill="url(https://e.example/x)"/></svg>').svg).not.toContain('e.example')
  })
  it('非 SVG 输入 ok:false', () => {
    expect(sanitizeSvg('这不是 svg <<<').ok).toBe(false)
  })
  it('空串 ok:false', () => {
    expect(sanitizeSvg('').ok).toBe(false)
  })
  it('保留合法矩形', () => {
    const r = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('rect')
  })
  it('Review Focus #1：text 里的转义标签不被还原成元素', () => {
    const r = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>&lt;script&gt;x&lt;/script&gt;</text></svg>')
    expect(r.svg).not.toMatch(/<script/)
  })
})
```

- [ ] **Step 7: 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
git commit -o apps/web/src/components/agent/presentation/svg-sanitize.ts -o apps/web/src/components/agent/presentation/AgentSvgCard.vue -o apps/web/src/components/agent/presentation/AgentSvgCard.test.ts -o apps/web/src/components/agent/presentation/types.ts -m "feat(web): 新增 AgentSvgCard 白名单净化组件"
```

---

## Task 5: 前端接线（store + switch + 挂载点）

**Files:**
- Modify: `apps/web/src/stores/agent.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（switch `:2514-2558`；模板 assistant 消息区）
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts`

**Interfaces:**
- Consumes: `AgentSvgCard`（Task 4）
- Produces: `useAgentStore().setPresentation(p: AgentPresentationEnvelope): void`

**本 Task 解决 Review Focus #3（同一轮两张卡 → 明确"最后一张胜出"）。**

- [ ] **Step 1: 写失败测试（store）**

新建 `apps/web/src/stores/agent.setPresentation.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from './agent'

const env = (kind: string, svg: string) => ({
  kind,
  stepper: { current: '', completed: [] },
  body: { svg },
})

describe('setPresentation', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('写入最后一条 assistant 消息的 presentation', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.kind).toBe('svg_card')
  })

  it('Review Focus #3：同轮第二张卡覆盖第一张（最后一张胜出）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="a"/>') as never)
    s.setPresentation(env('svg_card', '<svg id="b"/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.body?.svg).toContain('id="b"')
  })

  it('无 assistant 消息时不抛错（静默忽略）', () => {
    const s = useAgentStore()
    expect(() => s.setPresentation(env('svg_card', '<svg/>') as never)).not.toThrow()
  })
})
```

**先核实**：`stores/agent.ts` 是否用 pinia（实测有 `defineStore` 则是）。若不是 pinia 而是普通 ref 模块，测试写法改成直接 import 模块级函数。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/stores/agent.setPresentation.test.ts
```

预期：FAIL，`setPresentation is not a function`。

- [ ] **Step 3: store 加 `setPresentation`**

`apps/web/src/stores/agent.ts` 的 store 定义内，紧邻 `startAssistantMessage` 之后加：

```ts
  /**
   * 写当前 assistant 消息的 presentation（spec §4.6 第 2 跳）。
   * svg_card 走 canvas_command 通道实时上屏；**同轮多张时后者覆盖前者**——
   * 单值字段的既有语义，不引入卡片数组。
   */
  function setPresentation(presentation: AgentPresentationEnvelope) {
    const last = lastAssistant()
    if (!last) return
    last.presentation = presentation
  }
```

并在 return 对象里加 `setPresentation,`。

- [ ] **Step 4: switch 加 `svg_card` 分支**

`AgentSideRail.vue` 的 `case 'canvas_command':` 内，`else if (cmd.type === 'ask_user')` **之前**插入：

```ts
      } else if (cmd.type === 'svg_card' && cmd.svg) {
        // render_canvas_view 产物：净化在 AgentSvgCard 内做（spec §4.5）
        agent.setPresentation({
          kind: 'svg_card',
          stepper: { current: '', completed: [] },
          title: cmd.title,
          body: { svg: cmd.svg, annotations: cmd.annotations },
        } as never)
```

并把该 case 的类型标注补上字段（`const cmd = event.data as {...}` 里加）：

```ts
        svg?: string
        title?: string
        annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }>
```

- [ ] **Step 5: 模板加挂载点**

在 assistant 消息区**紧邻** `<AgentPresentationHost>` 挂载（实测 `:3086-3092`）**之后**、`toolCalls` 块之前插入：

```vue
                <AgentSvgCard
                  v-if="msg.presentation?.kind === 'svg_card' && msg.presentation.body?.svg"
                  class="mt-2"
                  :svg="msg.presentation.body.svg"
                  :title="msg.presentation.title"
                  :annotations="msg.presentation.body.annotations"
                />
```

并在文件顶部 import 区加：

```ts
import AgentSvgCard from './presentation/AgentSvgCard.vue'
```

- [ ] **Step 6: 重放恢复（`executionTraceReducer.ts`）**

`replayExecutionTraceEvents` 里加 `canvas_command` 分支：

```ts
    if (event.type === 'canvas_command') {
      const cmd = event.data as { type?: string; svg?: string; title?: string; annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }> }
      if (cmd?.type === 'svg_card' && cmd.svg) {
        trace.svgCard = { kind: 'svg_card', title: cmd.title, svg: cmd.svg, annotations: cmd.annotations }
      }
      return trace
    }
```

并在 `ExecutionTraceState` 接口加：

```ts
  /** svg_card 恢复位（spec §4.6 第 3 跳）：executionEvents 重放可恢复卡片本体。 */
  svgCard?: { kind: 'svg_card'; title?: string; svg: string; annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }> }
```

- [ ] **Step 7: `loadHistory` 恢复**

`stores/agent.ts` 的 `loadHistory` 里，在 `return { ... presentation, }` **之前**插入：

```ts
      // svg_card 从 executionEvents 恢复（metadata.presentation 通道在 pi 路径无产出，spec §4.6）
      const svgCard = executionTrace?.svgCard
      if (svgCard && !presentation) {
        presentation = {
          kind: svgCard.kind,
          stepper: { current: '', completed: [] },
          title: svgCard.title,
          body: { svg: svgCard.svg, annotations: svgCard.annotations },
        } as AgentPresentationEnvelope
      }
```

⚠️ 该作用域里 `presentation` 是 `const`——改成 `let`，并把 `const presentation = meta?.presentation ...` 的 `const` 去掉。

- [ ] **Step 8: 跑测试 + 类型检查**

```bash
cd apps/web && npx vitest run src/stores/agent.setPresentation.test.ts
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
pnpm --filter @lnkpi/web exec vue-tsc -b
```

预期：3 个 store test 全 PASS；`vue-tsc` 无错误。

- [ ] **Step 9: 提交**

```bash
git commit -o apps/web/src/stores/agent.ts -o apps/web/src/stores/agent.setPresentation.test.ts -o apps/web/src/components/agent/AgentSideRail.vue -o apps/web/src/components/agent/executionTraceReducer.ts -m "feat(web): 接通 svg_card 实时上屏与刷新恢复"
```

---

## Task 6: Nest 落库条件扩展 + 端到端断言

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（约 `:1002`）
- Test: `apps/server/src/agent/agent.service.pi-runtime.test.ts`（改）

**Interfaces:**
- Consumes: `extractCanvasCommands` 产出的 `svg_card`（Task 3）
- Produces: 无新导出

**本 Task 解决 Review Focus #2（同轮 ask_user + svg_card 落库互删）与 #5（重放时序）。**

- [ ] **Step 1: 写失败测试**

在 `apps/server/src/agent/agent.service.pi-runtime.test.ts` 追加：

```ts
describe('svg_card 落库', () => {
  it('svg_card 进 executionEvents，刷新后可恢复', async () => {
    // 走既有 pi 事件流驱动：产出含 svg_card 的 tool_execution_end
    // 断言落库 metadata.executionEvents 含 { type:'canvas_command', data:{ type:'svg_card', svg } }
  })

  it('Review Focus #2：同轮 ask_user + svg_card 都在 executionEvents 里，不互相挤掉', () => {
    // 构造两事件流后断言 executionEvents 同时含 ask_user 与 svg_card 两条 canvas_command
  })

  it('非 svg_card / ask_user 的 canvas_command 仍不落库（范围不扩大）', () => {
    // focus_node 不进 executionEvents
  })
})
```

⚠️ **这三个用例必须写实断言**（读该文件既有用例的 mock 驱动方式，`agent.test-utils.ts` 提供什么就用什么）。若既有 harness 无法在一次流里同时注入两种事件，拆成两个独立用例分别断言，并在 Task 5 Step 7 侧用 store 单测覆盖"两条共存"——**`it.skip` / 空断言 / 只有标题没有expect 一律不算完成**（spec §4.8 同款纪律：只跑通不测红的断言等于没写）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/agent.service.pi-runtime.test.ts
```

预期：新用例 FAIL（svg_card 未进 executionEvents）。

- [ ] **Step 3: 改落库条件**

`agent.service.ts` 约第 1002 行：

```ts
          if (cmd.type === 'ask_user') {
```

改为：

```ts
          // svg_card 与 ask_user 同走executionEvents 落库通道（spec §4.6 第 3 跳）：
          // 刷新/重连后前端从 metadata.executionEvents 重放恢复卡片。
          // ⚠️ 去重逻辑（按 callId splice）只对 ask_user 生效，svg_card 无 callId 不参与。
          if (cmd.type === 'ask_user' || cmd.type === 'svg_card') {
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/agent.service.pi-runtime.test.ts
```

预期：全 PASS。

- [ ] **Step 5: 提交**

```bash
git commit -o apps/server/src/agent/agent.service.ts -o apps/server/src/agent/agent.service.pi-runtime.test.ts -m "feat(server): svg_card 落库 executionEvents 以支持刷新恢复"
```

---

## Task 7: `canvas_view_policy` 规则（when 判据）

**Files:**
- Create: `prompt-registry/rules/canvas_view_policy.md`
- Modify: `prompt-registry/MANIFEST.yaml`
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`（`COMPOSED_IDS` + `FALLBACK_BY_ID`）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts`（新增常量）

**Interfaces:**
- Consumes: Task 2 的工具名 `render_canvas_view`
- Produces: Registry id `canvas_view_policy`

- [ ] **Step 1: 写规则文件**

⚠️ **frontmatter 的 `id` 必须等于文件名（去掉 `.md`）**，`group` 必须在 `GROUP_VALUES = {"writeTools","genTools"}` 内，`body` 末尾**恰好一个换行**（L5 断言），**body 内不得含裸尖括号标签**（L5 断言）。

`prompt-registry/rules/canvas_view_policy.md`：

```markdown
---
id: canvas_view_policy
version: 1.0.0
title: 画布视图卡片策略
order: 45
owner: agent-platform
updated: 2026-10-03
group: writeTools
---
16. 用户问「为什么/怎么/关系/结构/流程」且答案涉及 3 个以上节点或 2 层以上关系时：用 render_canvas_view 把画布上已有的数据渲成只读卡片（view=timeline 横轴时序 / topology 有向依赖 / table 二维表），overlay 选业务语义轨道（emotion 情绪曲线 / budget 超时长标红 / severity 严重度色阶）。卡片是数据源的投影，不改任何节点；用户要改就走 set_node_text 改数据源后重新渲染。
17. 触达时长或节奏校验需要心算时（台词字数对照镜头时长格、配音语速上限 4.5 字每秒），用 render_canvas_view 带 overlay=budget，让超限项在图上标红，不要口算后只给文字。
18. render_canvas_view 的负向边界：用户问单个节点或单个字段时纯文本回答，不得出图；数据源节点不存在时如实报错，不得编造行渲染；闲聊、道谢、致谢一律不出图。overlay=kind 不得与 view=topology 同用（会报错）。渲染完成后就本轮输出止叙述，不得接着调 propose_generation，也不得声称已生成图片——本工具只出矢量图，不产出任何媒体。
```

- [ ] **Step 2: 跑 lint 确认失败**

```bash
pnpm prompt:lint
```

预期：FAIL，报 `canvas_view_policy 未在 MANIFEST.yaml 登记` 或 L9（`COMPOSED_IDS` 未含）。

- [ ] **Step 3: 注册 manifest**

在 `prompt-registry/MANIFEST.yaml` 的 `entries:` 里，`media_tool_policy` 那块**之后**插入：

```yaml
  - id: canvas_view_policy
    version: 1.0.0
    order: 45
    contentHash: b221cb0a91e9
```

⚠️ **`b221cb0a91e9` 是按Step 1 规则文件 body 实算的真值**（`sha256(body.trimEnd())` 前 12 位，与 `prompt-registry.loader.ts:90contentHash` 同算法）。若你改了规则正文，**必须重算**，否则 L3 断言会红（body 已变却没同步登记）。

- [ ] **Step 4: 加 fallback 常量**

`prompt-registry.fallback.ts` 末尾追加（**body 逐字复制规则文件里 `---` 之后的内容**）：

```ts
/** canvas_view_policy（spec 2026-10-03 §5.3）：render_canvas_view 的三层 when + 负向黑名单。 */
export const CANVAS_VIEW_POLICY = `16. 用户问「为什么/怎么/关系/结构/流程」且答案涉及 3 个以上节点或 2 层以上关系时：用 render_canvas_view 把画布上已有的数据渲成只读卡片（view=timeline 横轴时序 / topology 有向依赖 / table 二维表），overlay 选业务语义轨道（emotion 情绪曲线 / budget 超时长标红 / severity 严重度色阶）。卡片是数据源的投影，不改任何节点；用户要改就走 set_node_text 改数据源后重新渲染。
17. 触达时长或节奏校验需要心算时（台词字数对照镜头时长格、配音语速上限 4.5 字每秒），用 render_canvas_view 带 overlay=budget，让超限项在图上标红，不要口算后只给文字。
18. render_canvas_view 的负向边界：用户问单个节点或单个字段时纯文本回答，不得出图；数据源节点不存在时如实报错，不得编造行渲染；闲聊、道谢、致谢一律不出图。overlay=kind 不得与 view=topology 同用（会报错）。渲染完成后就本轮输出止叙述，不得接着调 propose_generation，也不得声称已生成图片——本工具只出矢量图，不产出任何媒体。`;
```

- [ ] **Step 5: 声明 COMPOSED_IDS 与 FALLBACK_BY_ID**

`prompt-registry.loader.ts`：

`COMPOSED_IDS` 数组内 `"media_tool_policy",` 之后加 `"canvas_view_policy",`。
`FALLBACK_BY_ID` 对象内 `"media_tool_policy": WRITE_TOOLS_RULES,` 之后加：

```ts
	"canvas_view_policy": CANVAS_VIEW_POLICY,
```

并在该文件的 import 区加 `CANVAS_VIEW_POLICY`（从 `./prompt-registry.fallback.js`）。

- [ ] **Step 6: 校验 contentHash 与 body 一致**

Step 3 已填入实算值 `b221cb0a91e9`。跑一次独立校验，确认你落盘的 body 与它一致（**没改正文就应直接相等**）：

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
/usr/bin/python3 -c "
import re,hashlib
raw=open('prompt-registry/rules/canvas_view_policy.md',encoding='utf8').read()
body=raw[raw.index(chr(10)+'---'+chr(10))+5:].rstrip()
print('actual =', hashlib.sha256(body.encode('utf8')).hexdigest()[:12])
print('expect = b221cb0a91e9')
"
```

预期：`actual == b221cb0a91e9`。不等 ⇒ 规则正文被改动过，重算并同步 Step 3 与 fallback 常量。

- [ ] **Step 7: 跑 lint 确认通过**

```bash
pnpm prompt:lint
```

预期：0 错误输出、退出码 0。

若报 L7（body 与 fallback 常量不一致）⇒ 两侧逐字对齐（注意末尾换行与内部空行）。若报 L3（body 变了没 bump version）⇒ 说明 hash 算错，重算。

- [ ] **Step 8: 跑 server 测试确认渲染字节等价**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
```

预期：全 PASS（该测试锁死三路渲染逐字符相等）。

- [ ] **Step 9: 提交**

```bash
git commit -o prompt-registry/rules/canvas_view_policy.md -o prompt-registry/MANIFEST.yaml -o apps/server/src/agent/pi-runtime/prompt-registry.loader.ts -o apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts -m "feat(prompt): 新增 canvas_view_policy 规则承载 render_canvas_view 调用时机"
```

---

## Task 8: `lint-tool-descriptions.ts`

**Files:**
- Create: `scripts/lint-tool-descriptions.ts`
- Create: `scripts/lint-tool-descriptions.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `services/pi-runtime/src/tools/*.ts` 的 `description` 字段
- Produces: 导出 `LEGACY_TOOL_NAMES: ReadonlySet<string>`、`checkDescription(name: string, desc: string): string[]`

- [ ] **Step 1: 写失败测试**

`scripts/lint-tool-descriptions.test.ts`：

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkDescription, LEGACY_TOOL_NAMES } from "./lint-tool-descriptions.js";

describe("checkDescription", () => {
  it("接受符合四条惯例的描述", () => {
    const d = "Render a read-only SVG card visualizing canvas data. Requires the source nodes to exist. Does NOT edit any node. view=timeline means horizontal time axis.";
    assert.deepEqual(checkDescription("x", d), []);
  });
  it("拒绝名词开头", () => {
    assert.ok(checkDescription("x", "A read-only card. Requires nodes. Does NOT edit anything. view=timeline means time axis.").length > 0);
  });
  it("拒绝超长（>400）", () => {
    assert.ok(checkDescription("x", "Render ".repeat(60) + "not").length > 0);
  });
  it("拒绝过短（<80）", () => {
    assert.ok(checkDescription("x", "Render a card.").length > 0);
  });
  it("拒绝缺否定标记", () => {
    assert.ok(checkDescription("x", "Render a read-only SVG card visualizing canvas layout for the timeline view of shots. Requires nodes to exist.").length > 0);
  });
  it("存量工具在 LEGACY_TOOL_NAMES 内被豁免", () => {
    assert.equal(LEGACY_TOOL_NAMES.has("get_canvas_layout"), true);
  });
  it("新工具不在白名单内", () => {
    assert.equal(LEGACY_TOOL_NAMES.has("render_canvas_view"), false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --import tsx --test scripts/lint-tool-descriptions.test.ts
```

预期：FAIL，找不到模块。

- [ ] **Step 3: 实现**

`scripts/lint-tool-descriptions.ts`：

```ts
#!/usr/bin/env tsx
/**
 * 工具 description 四条惯例校验（spec §4.4）。
 *   R1 动词开头说清返回什么 / R2 前置条件写进描述 / R3 明确否定边界 / R4 枚举值语义逐个说明
 *   长度区间 [80, 400] 字符
 *
 * 强制范围：**不在 LEGACY_TOOL_NAMES 里的工具**（显式白名单豁免存量，新增漏网直接红）。
 * 用法：pnpm lint:tools
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const TOOLS_DIR = join(ROOT, "services/pi-runtime/src/tools");

/** 存量豁免白名单：spec §4.4 落地时按当时实际存在的工具名填满。 */
export const LEGACY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"get_canvas_summary", "get_canvas_layout", "get_node", "get_generation_status",
	"get_generation_diagnostic", "list_generation_tasks", "list_user_assets",
	"list_model_options", "web_search", "web_fetch", "read_document", "recall_memory",
	"save_memory", "upsert_media_node", "upsert_prompt_node", "set_node_text",
	"update_node", "connect_nodes", "attach_refs", "apply_sidebar_attachments",
	"propose_generation", "arrange_nodes", "run_image_generation", "run_video_generation",
	"run_text_generation", "run_prompt_generation", "run_audio_generation",
	"cancel_generation", "ask_user", "load_skill", "load_tools",
	"focus_node", "focus_nodes", "undo", "redo", "open_image_editor",
	"delete_nodes", "remove_edges", "introduce_nodes_to_agent", "export_media_package",
	"set_node_generation_params", "upscale_image", "open_sidebar_reference_manager",
	"open_skill_manager", "open_asset_library", "open_model_settings", "reload_model_settings",
	"open_generation_settings", "open_agent_settings", "search_user_assets", "tool_search",
]);

const MIN = 80;
const MAX = 400;
const NEGATION = /\b(not|never|does not|does NOT|instead of)\b|不|禁止|不得/;
const VERB_START = /^(Render|Get|Set|Create|Update|Delete|List|Show|Read|Write|Focus|Pan|Undo|Redo|Open|Search|Recall|Save|Connect|Attach|Propose|Apply|Cancel|Add|Remove|Zoom|Fit|Copy|Move|Reload|Introduce|Export|Import|Use|Ask|Load|Skip|Keep|Return|Describe|Explain|Answer|Convert|Compute|Filter|Sort|Merge|Split|Duplicate|Move)\b/;

/** 返回问题清单；空数组 = 通过。 */
export function checkDescription(name: string, desc: string): string[] {
	const errs: string[] = [];
	if (desc.length < MIN) errs.push(`${name}: 描述 ${desc.length} 字符 < ${MIN}，大概率缺 R1/R2/R3`);
	if (desc.length > MAX) errs.push(`${name}: 描述 ${desc.length} 字符 > ${MAX}，参数文档应写进 schema`);
	if (!VERB_START.test(desc.trim())) errs.push(`${name}: R1 未以动词开头`);
	if (!NEGATION.test(desc)) errs.push(`${name}: R3 缺明确否定边界（写清不做什么）`);
	return errs;
}

function main(): void {
	const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
	const errs: string[] = [];
	let checked = 0;
	for (const f of files) {
		const src = readFileSync(join(TOOLS_DIR, f), "utf8");
		const name = f.replace(/\.ts$/, "");
		if (LEGACY_TOOL_NAMES.has(name)) continue;
		for (const m of src.matchAll(/name:\s*"([a-z_]+)"[\s\S]{0,400}?description:\s*\n?\s*"([^"]*)"/g)) {
			checked += 1;
			errs.push(...checkDescription(m[1], m[2]));
		}
	}
	if (errs.length > 0) {
		for (const e of errs) console.error(`[tool-desc] ${e}`);
		console.error(`\n${errs.length} 条不合规（已校验 ${checked} 条新工具描述）`);
		process.exit(1);
	}
	console.log(`tool descriptions OK（${checked} 条新工具描述，${LEGACY_TOOL_NAMES.size} 个存量豁免）`);
}

if (process.argv[1] && process.argv[1].endsWith("lint-tool-descriptions.ts")) main();
```

⚠️ **`LEGACY_TOOL_NAMES` 必须按实际清单填**：跑一次脚本，把「因缺 name 提取而漏检」的工具名补进去。核实方式：

```bash
cd services/pi-runtime/src/tools && /usr/bin/grep -ho 'name: "[a-z_]*"' *.ts | /usr/bin/grep -v test | sort -u
```

把这条命令的输出与 `LEGACY_TOOL_NAMES` 对账，**多退少补**。少一个名字 = 该工具漏检（静默放过），多一个 = 无害。

- [ ] **Step 4: 挂脚本 + 接 CI**

`package.json` 的 `scripts` 加：

```json
"lint:tools": "npx tsx scripts/lint-tool-descriptions.ts"
```

`.github/workflows/ci.yml` 的 `Verify spec figures` job 里，`- name: Verify spec figures (R1–R8)` 之后加：

```yaml
      - name: Tool description lint
        run: pnpm lint:tools
      - name: Prompt registry lint
        run: pnpm prompt:lint
```

（第二步顺带把 `prompt:lint` 接进 CI——实测现在 CI 完全没跑它。）

- [ ] **Step 5: 跑测试 + 脚本**

```bash
node --import tsx --test scripts/lint-tool-descriptions.test.ts
pnpm lint:tools
```

预期：7 个 test 全 PASS；脚本输出 `tool descriptions OK` 且退出码 0。

若脚本报 `render_canvas_view` 不合规——检查它的 description 是否含否定词（Task 2 的草稿里有 `does NOT`，应通过）。

- [ ] **Step 6: 提交**

```bash
git commit -o scripts/lint-tool-descriptions.ts -o scripts/lint-tool-descriptions.test.ts -o package.json -o .github/workflows/ci.yml -m "build(ci): 新增工具 description lint 并把 prompt:lint 接进 CI"
```

---

## Task 9: `verify-tool-contract.ts`（vendor 契约面漂移机检）

**Files:**
- Create: `scripts/verify-tool-contract.ts`
- Create: `scripts/verify-tool-contract.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `vendor/earendil-works/pi/packages/agent/src/{types,harness/types}.ts` 源码文本
- Produces: 导出 `VENDOR_TOOL_FACES`、`KNOWN_UNCONSUMED_FACES`、`KNOWN_CAST_EXCEPTIONS`、`collectFindings(): string[]`

- [ ] **Step 1: 写失败测试**

`scripts/verify-tool-contract.test.ts`：

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VENDOR_TOOL_FACES, KNOWN_UNCONSUMED_FACES, collectFindings } from "./verify-tool-contract.js";

const ROOT = resolve(process.cwd());
const AGENT_TYPES = readFileSync(
  resolve(ROOT, "vendor/earendil-works/pi/packages/agent/src/types.ts"), "utf8",
);
const HARNESS_TYPES = readFileSync(
  resolve(ROOT, "vendor/earendil-works/pi/packages/agent/src/harness/types.ts"), "utf8",
);
const OUR_TYPES = readFileSync(
  resolve(ROOT, "services/pi-runtime/src/tools/types.ts"), "utf8",
);

describe("A1 vendor 契约面提取", () => {
  it("AgentToolResult 四个字段被提取", () => {
    for (const f of ["content", "details", "addedToolNames", "terminate"]) {
      assert.ok(VENDOR_TOOL_FACES.includes(f), `缺 ${f}`);
    }
  });
  it("AgentTool 的 label 与 prepareArguments 被提取", () => {
    assert.ok(VENDOR_TOOL_FACES.includes("label"));
    assert.ok(VENDOR_TOOL_FACES.includes("prepareArguments"));
  });
  it("AgentHarnessTool 的 invocation 能力面被提取", () => {
    assert.ok(VENDOR_TOOL_FACES.includes("invocation"));
  });
});

describe("A2 我们声明的面覆盖 vendor", () => {
  it("vendor 侧有字段被我们完全漏掉时必须报出来（当前应全部在已知清单或已覆盖）", () => {
    const findings = collectFindings();
    const a2 = findings.filter((f) => f.startsWith("A2"));
    // 当前仓库状态允许零条；一旦 vendor 升级新增字段，这条会红
    assert.deepEqual(a2, [], `A2 未覆盖:\n${a2.join("\n")}`);
  });
  it("KNOWN_UNCONSUMED_FACES 里每一项都能在 vendor 源码找到证据", () => {
    for (const f of KNOWN_UNCONSUMED_FACES) {
      assert.ok(
        AGENT_TYPES.includes(f) || HARNESS_TYPES.includes(f) || OUR_TYPES.includes(f),
        `${f} 在三份源码里都找不到`,
      );
    }
  });
});

describe("A3 类型逃逸口数量", () => {
  it("逃逸口数量不超过登记上限", () => {
    const findings = collectFindings().filter((f) => f.startsWith("A3"));
    assert.deepEqual(findings, [], findings.join("\n"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --import tsx --test scripts/verify-tool-contract.test.ts
```

预期：FAIL，找不到模块。

- [ ] **Step 3: 实现**

`scripts/verify-tool-contract.ts`：

```ts
#!/usr/bin/env tsx
/**
 * vendor 工具契约面漂移机检（spec §4.8）。
 *
 * 目的：让「升级 pi-agent 后工具契约不会静默失效」有可执行保障。
 *   A1 从 vendor 源码提取 AgentTool / AgentToolResult / AgentHarnessTool 的字段名集合
 *   A2 每个 vendor 字段必须在我们侧有对应，或在 KNOWN_UNCONSUMED_FACES 里显式登记
 *   A3 `as LnkpiTool` / `as unknown as` 的数量不得超过 KNOWN_CAST_EXCEPTIONS
 *   A4 LEGACY_TOOL_NAMES 里的工具名必须真实存在
 *
 * 诚实边界：本机检只保证「契约面不漏」，**不保证「新能力我们用上」**——
 * 后者靠 spec §7 的翻转条件（人工判据）。
 *
 * 用法：pnpm verify:tools
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const VENDOR_AGENT = resolve(ROOT, "vendor/earendil-works/pi/packages/agent/src/types.ts");
const VENDOR_HARNESS = resolve(ROOT, "vendor/earendil-works/pi/packages/agent/src/harness/types.ts");
const OUR_TYPES = resolve(ROOT, "services/pi-runtime/src/tools/types.ts");
const TOOLS_DIR = resolve(ROOT, "services/pi-runtime/src/tools");

/** 已知零消费的 vendor 契约面（spec §4.8 表）。每项须能在 vendor 源码找到证据。 */
export const KNOWN_UNCONSUMED_FACES: ReadonlySet<string> = new Set([
	"prepareArguments", "replay", "executionMode", "usage",
	"truncateHead", "truncateTail", "AgentHarnessToolUpdateOptions", "checkpoint",
]);

/** 已知类型逃逸口（spec §4.8 A3）。tiering.ts 的 createLoadToolsTool 返回值 —— 唯一一处。 */
export const KNOWN_CAST_EXCEPTIONS: ReadonlySet<string> = new Set([
	"services/pi-runtime/src/tools/tiering.ts",
]);

/** 存量工具豁免白名单（与 lint-tool-descriptions 共用同一份事实）。 */
export const LEGACY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"get_canvas_summary", "get_canvas_layout", "get_node", "get_generation_status",
	"get_generation_diagnostic", "list_generation_tasks", "list_user_assets",
	"list_model_options", "web_search", "web_fetch", "read_document", "recall_memory",
	"save_memory", "upsert_media_node", "upsert_prompt_node", "set_node_text",
	"update_node", "connect_nodes", "attach_refs", "apply_sidebar_attachments",
	"propose_generation", "arrange_nodes", "run_image_generation", "run_video_generation",
	"run_text_generation", "run_prompt_generation", "run_audio_generation",
	"cancel_generation", "ask_user", "load_skill", "load_tools",
	"focus_node", "focus_nodes", "undo", "redo", "open_image_editor",
	"delete_nodes", "remove_edges", "introduce_nodes_to_agent", "export_media_package",
	"set_node_generation_params", "upscale_image", "open_sidebar_reference_manager",
	"open_skill_manager", "open_asset_library", "open_model_settings", "reload_model_settings",
	"open_generation_settings", "open_agent_settings", "search_user_assets", "tool_search",
]);

/** 从 interface 体里提取字段名（`name:` 或 `name?:` 开头的一行）。 */
function fieldsOf(src: string, iface: string): string[] {
	const start = src.indexOf(`export interface ${iface}`);
	if (start < 0) return [];
	const open = src.indexOf("{", start);
	let depth = 0;
	let end = open;
	for (let i = open; i < src.length; i += 1) {
		if (src[i] === "{") depth += 1;
		else if (src[i] === "}") {
			depth -= 1;
			if (depth === 0) { end = i; break; }
		}
	}
	const body = src.slice(open, end);
	return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*[:(]/gm)].map((m) => m[1]);
}

export const VENDOR_TOOL_FACES: readonly string[] = (() => {
	const agent = readFileSync(VENDOR_AGENT, "utf8");
	const harness = readFileSync(VENDOR_HARNESS, "utf8");
	return [
		...new Set([
			...fieldsOf(agent, "AgentToolResult"),
			...fieldsOf(agent, "AgentTool"),
			...fieldsOf(harness, "AgentHarnessToolInvocation"),
		]),
	].sort();
})();

export function collectFindings(): string[] {
	const findings: string[] = [];
	const our = readFileSync(OUR_TYPES, "utf8");

	// A2：vendor 字段必须在我们的源码里有字面证据，或已登记为已知零消费
	for (const face of VENDOR_TOOL_FACES) {
		if (KNOWN_UNCONSUMED_FACES.has(face)) continue;
		if (!our.includes(face)) {
			findings.push(
				`A2 vendor 契约面「${face}」在我们侧找不到对应，也未登记进 KNOWN_UNCONSUMED_FACES` +
					`（vendor 升级新增或改名？）`,
			);
		}
	}

	// A3：类型逃逸口数量不得超过登记上限
	for (const f of readdirSync(TOOLS_DIR)) {
		if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
		const rel = `services/pi-runtime/src/tools/${f}`;
		const src = readFileSync(join(TOOLS_DIR, f), "utf8");
		const casts = src.match(/\bas (LnkpiTool|unknown as)\b/g);
		if (!casts || casts.length === 0) continue;
		if (!KNOWN_CAST_EXCEPTIONS.has(rel)) {
			findings.push(`A3 ${rel} 有 ${casts.length} 处类型逃逸但未登记进 KNOWN_CAST_EXCEPTIONS`);
		}
	}

	// A4：豁免白名单里的工具名必须真实存在
	const files = new Set(
		readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")),
	);
	for (const name of LEGACY_TOOL_NAMES) {
		const has = [...files].some((f) => {
			const src = readFileSync(join(TOOLS_DIR, `${f}.ts`), "utf8");
			return new RegExp(`name:\\s*"${name}"`).test(src);
		});
		if (!has) findings.push(`A4 LEGACY_TOOL_NAMES 里的「${name}」在 tools/ 下找不到对应工具定义`);
	}

	return findings;
}

function main(): void {
	const findings = collectFindings();
	if (findings.length > 0) {
		for (const f of findings) console.error(`[tool-contract] ${f}`);
		console.error(`\n${findings.length} 条契约漂移`);
		process.exit(1);
	}
	console.log(
		`tool contract OK（vendor 面 ${VENDOR_TOOL_FACES.length} 个，已知零消费 ${KNOWN_UNCONSUMED_FACES.size} 个，逃逸口登记 ${KNOWN_CAST_EXCEPTIONS.size} 处）`,
	);
}

if (process.argv[1] && process.argv[1].endsWith("verify-tool-contract.ts")) main();
```

- [ ] **Step 4: 变异测试（spec §4.8 硬要求：机检自身必须能红）**

```bash
pnpm verify:tools                      # 期望：OK，退出码 0

# 变异 1：伪造一个 vendor 新增字段
cp services/pi-runtime/src/tools/types.ts /tmp/types.bak
printf '\n// 变异测试用\ntype __Mutant = { brandNewVendorField: string };\n' >> services/pi-runtime/src/tools/types.ts
# A2 只查 vendor→我们方向，故改 vendor 侧：
git checkout -- vendor/earendil-works/pi/packages/agent/src/types.ts 2>/dev/null || true
cp vendor/earendil-works/pi/packages/agent/src/types.ts /tmp/vendor-types.bak
/usr/bin/python3 - <<'PY'
p='vendor/earendil-works/pi/packages/agent/src/types.ts'
s=open(p,encoding='utf8').read()
s=s.replace("export interface AgentToolResult<T> {", "export interface AgentToolResult<T> {\n\tbrandNewVendorField?: string;",1)
open(p,'w',encoding='utf8').write(s)
PY
pnpm verify:tools; echo "退出码=$?"     # 期望：报 A2 且退出码非 0

# 还原
cp /tmp/vendor-types.bak vendor/earendil-works/pi/packages/agent/src/types.ts
cp /tmp/types.bak services/pi-runtime/src/tools/types.ts
pnpm verify:tools; echo "退出码=$?"     # 期望：OK，退出码 0
```

⚠️ **vendor 目录是只读镜像**（`vendor/earendil-works/pi/VENDORED.md` 有 patch 纪律）。变异测试**必须在同一个 shell 里完成还原并复跑绿**，且**绝不 commit** vendor 的改动。还原后用 `git status --short vendor/` 确认为空。

- [ ] **Step 5: 变异测试 2：新增逃逸口**

```bash
cp services/pi-runtime/src/tools/present-result.ts /tmp/pr.bak
/usr/bin/python3 -c "
p='services/pi-runtime/src/tools/present-result.ts'
s=open(p,encoding='utf8').read()
open(p,'w',encoding='utf8').write(s+'\nexport const _mutant = {} as LnkpiTool;\n')"
pnpm verify:tools; echo "退出码=$?"     # 期望：报 A3（present-result.ts 未登记）
cp /tmp/pr.bak services/pi-runtime/src/tools/present-result.ts
pnpm verify:tools; echo "退出码=$?"     # 期望：OK
```

- [ ] **Step 6: 挂脚本 + 接 CI**

`package.json` 加 `"verify:tools": "npx tsx scripts/verify-tool-contract.ts"`。
`ci.yml` 的 `Tool description lint` 之后加：

```yaml
      - name: Tool contract drift check
        run: pnpm verify:tools
```

- [ ] **Step 7: 跑测试 + 提交**

```bash
node --import tsx --test scripts/verify-tool-contract.test.ts
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
git status --short vendor/   # 必须为空
git commit -o scripts/verify-tool-contract.ts -o scripts/verify-tool-contract.test.ts -o package.json -o .github/workflows/ci.yml -m "build(ci): 新增 vendor 工具契约面漂移机检"
```

---

## Task 10: 终验与 PR

- [ ] **Step 1: 全量验证**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/canvas-view-card
pnpm -r build                 # tsc + vue-tsc，**不是仅 vitest**
pnpm test:runtime
pnpm --filter @lnkpi/web exec vitest run
pnpm --filter @lnkpi/server exec vitest run src/agent/agent.service.pi-runtime.test.ts src/agent/pi-runtime/prompt-registry.loader.test.ts
pnpm lint:tools
pnpm verify:tools
pnpm prompt:lint
npx tsx scripts/verify-spec-figures.ts --all
git status --short vendor/    # 必须为空（vendor 是只读镜像）
```

全部必须绿。任一红则**修完再进 Step 2**，不带着红提交。

- [ ] **Step 2: 逐文件核对归属（项目硬纪律）**

```bash
git diff --cached | grep '^-' | grep -v '^---' | head -40   # 所有删除行必须属本plan
git diff --stat origin/master...HEAD
```

确认删除行**只有** `registry.ts` 里的 import 增补、`types.ts` 的 `ToolTier` 改写这类预期改动，**没有**误删存量代码。

- [ ] **Step 3: 提交残留**

```bash
git status --short
```

有未提交文件则按 `git commit -o <path>` 逐个提交。

- [ ] **Step 4: 推分支 + 开 PR**

```bash
git push -u origin feat/canvas-view-card
gh pr create --base master --head feat/canvas-view-card \
  --title "feat(agent): 工具契约标准化 5 项 + render_canvas_view 只读投影卡片" \
  --body "$(cat <<'EOF'
## 做什么

- 新增 `render_canvas_view` 工具（tier=`present`）：把画布已有的节点/边/表格渲成只读 SVG 卡片
- 5 项工具契约标准化：`present` tier / `presentResult` 构造器 / description lint / spec 文档 / **vendor 契约面漂移机检**
- `canvas_view_policy` 规则承载三层 when（L1 解释澄清 / L2 校验 / L3 生成预览）+ 负向黑名单
- 前端 `AgentSvgCard` 用原生 `DOMParser` 白名单净化（不用 iframe，仓库无 CSP 兜底）

## 关键判据

- **只读投影**：用户编辑的是数据源节点，图是投影 ⇒ 不开画布 `targetType` 白名单（要动 4 处）
- **非静默降级**：`overlay` + `view='topology'` 返回错误而非忽略
- **三跳通道**（spec §4.6，已更正早期的「零 Nest 改动」笼统表述）：SSE 派生零 Nest 改动；落库需最小 Nest 改动（`ask_user` 同款条件扩展）
- **机检自身有变异测试**：`pnpm verify:tools` 必须能因伪造 vendor 字段 / 新增逃逸口而红

## 显式不做

- 不改存量 40 个工具的 return 形状（存量整改另立 PR）
- 不给存量工具补 `onUpdate` / `invocation` / `terminate`
- 不复活 `topo_preview` 老通道
- 不新增画布节点类型
- 不新增运行时依赖（不引 DOMPurify）

## 验证

`pnpm -r build` / `pnpm test:runtime` / web vitest / `pnpm lint:tools` / `pnpm verify:tools` / `pnpm prompt:lint` 全绿。
EOF
)"
```

- [ ] **Step 5: 盯 CI**

```bash
export PATH="/usr/local/bin:$PATH"
for i in $(seq 1 40); do
  ST=$(gh run list --branch feat/canvas-view-card --limit 1 --json status --jq '.[0].status')
  [ "$ST" = completed ] && break
  sleep 20
done
gh run view --branch feat/canvas-view-card --limit 1 --json jobs --jq '.jobs[].steps[] | "\(.name) :: \(.conclusion)"'
```

预期：所有 step `success`。⚠️ CI 的 `pnpm test` 在 `Build monorepo` job 内（不是独立 job），`gh pr checks` 只列 3 个 job 看不到它——必须下钻 step 级。

- [ ] **Step 6: 合并（squash）**

CI 全绿后：

```bash
gh pr merge feat/canvas-view-card --squash --delete-branch
```

⚠️ 合并会触发 `deploy.yml` 自动推 api + web（`pi-runtime` 部署**永远手搓**，见 spec 记忆纪律）。本 PR 改 pi-runtime ⇒ 需在合并后手动跑：

```bash
SHA=$(git rev-parse --short origin/master)
gh workflow run "Runtime Deploy (pi-runtime)" -f tag="$SHA" -f feature_grep=''
```

- [ ] **Step 7: 清理 worktree**

```bash
cd /Users/4seven/workspace/pi-lnk
git worktree list --porcelain | grep canvas-view-card   # 确认无未提交改动
git update-ref refs/backup/feat-canvas-view-card feat/canvas-view-card
git worktree remove .worktrees/canvas-view-card
git branch -D feat/canvas-view-card
```

⚠️ `--force` 删 worktree 前**必须 tar 备份**；绝不做破坏性清理。
