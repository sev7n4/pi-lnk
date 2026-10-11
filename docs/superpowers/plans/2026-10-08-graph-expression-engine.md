# 图形化表达引擎 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `render_canvas_view` 从「只能读画布的卡片工具」重构为「来源 × 视图正交的图形化表达引擎」，并先建立能验证模型调用正确性的观测能力。

**Architecture:** 三层架构 —— 数据来源（knowledge / canvas / mixed）归一化为**统一中间表示 `GraphIR`** → 视图算法（relation / timeline / hierarchy / stages / matrix）从 IR 算出坐标 → 渲染层（静态 SVG / 可交互节点图）消费坐标。IR 不含坐标，坐标是渲染产物，因此换视图不动数据结构。交付顺序**观测先于能力**：D1 可观测性 → D2 触发判据 → D3 IR 抽取（纯重构）→ D4 能力补齐 → D5 渲染分工与嵌入。

**Tech Stack:** TypeScript 5.x、Node 22、Fastify（`/metrics`）、Vue 3 + Vue Flow（前端）、SQLite（生产库）、vitest。

**Spec:** `docs/superpowers/specs/2026-10-08-graph-expression-engine-design.md`（525 行，已过架构评审修订）

---

## Global Constraints

- **不新增工具、不新增参数。** 现有 15 个参数（`view, relation, groupBy, show_type, scope, focus, hops, focus_anchor, rowBy, colBy, nodes, overlay, node_ids, title, annotations`）保持不变。新增任何参数前必须先回答「能否用现有参数组合表达」；不能则**优先复用或合并现有参数**。
- **不删任何现有参数**，只在 L6 数据确认使用率 ≈ 0 后，另开 PR 删。
- **D3 必须是纯重构**：IR 抽取阶段对外输出**逐字节不变**（验收判据见 Task 6）。
- **XSS 防护不可省**：`render_canvas-view` 的一切文本输出路径，凡拼接进 SVG/HTML 的用户可控文本（节点标题、定义）必须经 `escapeHtml`，覆盖 `& < > " '` 五个字符，**`&` 必须第一个处理**（否则 `&lt;` 会被二次转义成 `&amp;lt;`）。
- **视图别名必须在 IR 构建前解析掉**：`topology` → `layout + relation=dependency`；`table` → 逐行列表 + 行级 overlay。IR 的 `view` 字段**不得**出现 legacy 值。
- **分支纪律**：master 永远等于 origin/master；一切开发在 `feat/` 分支 + worktree 上完成，PR 走 squash 合并。
- **门禁三件套**（每次提交前必跑）：`verify-claims`（7/7）、`verify-tool-contract`（4 hooks guarded）、`verify-links`（无断链）。
- **行级指标口径**（已锁定，见 Task 1）：判「有没有流量」一律看 **counter**，`sessions_active` 是瞬时 Gauge，`=0` 不等于没流量。

---

## Review Focus

以下五类是规格暗示、但没有任何任务的测试会覆盖、且最可能咬人的输入。列在这里，随后每个都有测试钉在它所属的任务里。

| # | 输入/条件 | 合理的人会期待什么 |
|---|---|---|
| 1 | **画布为空 + `source=knowledge`** | 仍能出图（意图① 的硬判据）。此时若报「画布上还没有节点」就是回归 |
| 2 | **零调用轮次**（「该画没画」） | 观测指标仍要落一条「未触发」记录，否则触发率的分母永远是 0，指标形同虚设 |
| 3 | **节点标题含 `<script>` / `img onerror`** | 快照里是转义文本，不是可执行标签 |
| 4 | **legacy `topology` 与 `layout+dependency` 混用** | 两者产出**同一** IR（`view` 都是 `layout`），否则统计与去重会双计 |
| 5 | **`source=mixed` 但画布无相关节点** | 退化为 `knowledge` 行为并**显式记录**降级，不静默失败 |

---

## 现有基座（实施者必读，避免重复造）

| 事实 | 出处 | 对计划的影响 |
|---|---|---|
| `tool-metrics.ts` 的 `ToolMetrics` 已结算**全部 39 个工具**的调用数/错误率/耗时，`/metrics` 已暴露 Prometheus 文本 | `services/pi-runtime/src/tool-metrics.ts`、`app.ts:100` | Task 2 **挂现有基座**，不新建指标系统 |
| harness 的 `tool_start`/`tool_end` 是**全工具统一事件**，工具零改动即全覆盖 | `tool-metrics.ts` 文件头 | Task 2 只加维度标签，不改工具 |
| ⚠️ `ToolLifecycleEvent` **不含 `args`**（字段：`toolName/toolCallId/isError/terminate/resultText/channel/model`） | `tool-metrics.ts:66-74` | **参数使用率无法挂现有 metrics**，需新增捕获（Task 3） |
| `ToolMetrics` 的 `settled` 集合是**有界**（`SETTLED_MAX = 4096`），超出窗口的重放会二次计数 | `tool-metrics.ts` | 已知取舍，不在本次修 |
| 生产库表名是 `AgentMessage`，`metadata` 是 JSON，工具参数在 `executionEvents` 里 | 2026-10-08 取证 | Task 4 的查询脚本按此写 |
| ⚠️ `AgentMessage.metadata` **只在调用发生时才写** | 同上 | **「该画没画」只能从 runtime SSE 流的思考文本判断**（Task 2） |

---

# Phase 0 · 可观测性（D1）

> ⚠️ 本阶段的唯一目的：**让后续每一项改动都能被验证**。
> ⚠️ 若本阶段数据显示触发率极低（模型基本不画图），Phase 1–3 的优先级需重排 —— 这是规格 §7 的预案。

### Task 1: 固化指标口径与基线快照

**Files:**
- Create: `services/pi-runtime/src/graph-observation/graph-metrics.ts`
- Test: `services/pi-runtime/src/graph-observation/graph-metrics.test.ts`

**Interfaces:**
- Consumes: 现有 `Metrics`（`services/pi-runtime/src/metrics.ts`）的 `lines: string[]` 追加式接口
- Produces:
  - `GRAPH_SIGNAL_WORDS: readonly string[]` — 判定「这轮该画图」的信号词表
  - `class GraphMetrics { observeTrigger(opts: {signaled: boolean; drew: boolean}): void; observeView(view: string, legacy: boolean): void; observeParam(name: string): void; observeDetour(toolName: string): void; renderInto(lines: string[]): void }`

- [ ] **Step 1: 写失败测试**

`services/pi-runtime/src/graph-observation/graph-metrics.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { GRAPH_SIGNAL_WORDS, GraphMetrics } from "./graph-metrics.js";

describe("GraphMetrics", () => {
  it("零调用轮次也要落一条（否则触发率分母为 0）", () => {
    const m = new GraphMetrics();
    m.observeTrigger({ signaled: true, drew: false });
    const lines: string[] = [];
    m.renderInto(lines);
    expect(lines.join("\n")).toContain('signaled_total 1');
    expect(lines.join("\n")).toContain('drew_total 0');
  });

  it("view 分布按规范化后的名字统计，legacy 单独计数", () => {
    const m = new GraphMetrics();
    m.observeView("layout", false);
    m.observeView("topology", true);
    const lines: string[] = [];
    m.renderInto(lines);
    const out = lines.join("\n");
    expect(out).toContain('view_total{view="layout"} 2');
    expect(out).toContain('view_legacy_total 1');
  });

  it("未传 view 时不进 view 分布（不编造）", () => {
    const m = new GraphMetrics();
    m.observeView("", false);
    const lines: string[] = [];
    m.renderInto(lines);
    expect(lines.join("\n")).not.toContain("view_total");
  });

  it("信号词表非空且全部为中文/英文短词", () => {
    expect(GRAPH_SIGNAL_WORDS.length).toBeGreaterThan(0);
    for (const w of GRAPH_SIGNAL_WORDS) expect(w.length).toBeLessThanOrEqual(6);
  });

  it("前置绕路按工具名分桶", () => {
    const m = new GraphMetrics();
    m.observeDetour("web_search");
    m.observeDetour("load_skill");
    m.observeDetour("web_search");
    const lines: string[] = [];
    m.renderInto(lines);
    expect(lines.join("\n")).toContain('detour_total{tool="web_search"} 2');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd services/pi-runtime && ../../node_modules/.bin/vitest run src/graph-observation/graph-metrics.test.ts
```
Expected: FAIL —— `Cannot find module './graph-metrics.js'`

- [ ] **Step 3: 最小实现**

`services/pi-runtime/src/graph-observation/graph-metrics.ts`：

```ts
/**
 * 图形化表达引擎的观测指标（spec §6 D1）。
 *
 * ⚠️ 为什么挂在现有 Metrics 的 lines 上（不新建指标系统）：
 *   `tool-metrics.ts` 已把 39 个工具的调用/错误/耗时结算进同一个 `/metrics`
 *   文本，**逐字输出不变**是它的既有回归锁 ⇒ 追加新族不破坏它。
 *
 * ⚠️ 三个维度各自独立、互不推导：
 *   - triggered：这一轮「信号命中但没画」也要记，否则触发率分母恒为 0；
 *   - view：分布（含 legacy 计数），用于评估 G6；
 *   - detour：画图前调了什么，是 token 浪费的定位依据。
 */

/** 判定「这一轮该画图」的信号词（短词，避免把整句塞进 label）。 */
export const GRAPH_SIGNAL_WORDS = [
  "图", "示意图", "可视化", "画一个", "画张", "关系图", "流程图",
  "时间线", "泳道", "拓扑", "树状", "矩阵", "分布", "梳理成图",
] as const;

function inc(m: Map<string, number>, k: string, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

export class GraphMetrics {
  private signaled = 0;
  private drew = 0;
  private views = new Map<string, number>();
  private legacy = 0;
  private params = new Map<string, number>();
  private detours = new Map<string, number>();

  observeTrigger(o: { signaled: boolean; drew: boolean }): void {
    if (o.signaled) this.signaled += 1;
    if (o.drew) this.drew += 1;
  }

  observeView(view: string, isLegacy: boolean): void {
    // ⛔ 空view 不进分布：宁可少一条，也不能编造一个 "unknown" 桶
    if (!view) return;
    inc(this.views, view);
    if (isLegacy) this.legacy += 1;
  }

  observeParam(name: string): void {
    if (name) inc(this.params, name);
  }

  observeDetour(toolName: string): void {
    if (toolName) inc(this.detours, toolName);
  }

  renderInto(lines: string[]): void {
    lines.push("# HELP graph_signal_total 图形化表达：信号命中轮数");
    lines.push("# TYPE graph_signal_total counter");
    lines.push(`graph_signal_total ${this.signaled}`);
    lines.push("# HELP graph_drew_total 图形化表达：实际调用画图工具的轮数");
    lines.push("# TYPE graph_drew_total counter");
    lines.push(`graph_drew_total ${this.drew}`);
    if (this.views.size > 0) {
      lines.push("# HELP graph_view_total 视图分布（已规范化，不含 legacy）");
      lines.push("# TYPE graph_view_total counter");
      for (const [k, v] of this.views) lines.push(`graph_view_total{view="${k}"} ${v}`);
    }
    if (this.legacy > 0) {
      lines.push("# HELP graph_view_legacy_total 用了 legacy 别名（topology/table）的次数");
      lines.push("# TYPE graph_view_legacy_total counter");
      lines.push(`graph_view_legacy_total ${this.legacy}`);
    }
    if (this.params.size > 0) {
      lines.push("# HELP graph_param_total 各参数被显式传入的次数");
      lines.push("# TYPE graph_param_total counter");
      for (const [k, v] of this.params) lines.push(`graph_param_total{param="${k}"} ${v}`);
    }
    for (const [k, v] of this.detours) {
      lines.push(`graph_detour_total{tool="${k}"} ${v}`);
    }
  }
}
```

⚠️ `renderInto` 里的 label 值全部来自**代码内的枚举或工具名**，不来自用户输入 ——
这正是 `tool-metrics.ts:221` 注释强调的约束（`channel`/`toolName` 是安全来源）。⛔ 不得把 `title` 之类用户可控文本塞进 label。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd services/pi-runtime && ../../node_modules/.bin/vitest run src/graph-observation/graph-metrics.test.ts
```
Expected: 5 passed

- [ ] **Step 5: 变异验证测试真能抓错**（`mutation-test-verification` 纪律）

把 `if (o.signaled) this.signaled += 1;` 改成 `this.signaled += 1;`（无条件记），重跑 —— Expected: 「零调用轮次也要落一条」**变红**。验完改回。

- [ ] **Step 6: 提交**

```bash
git add services/pi-runtime/src/graph-observation/
git commit -m "feat(pi-runtime): GraphMetrics 观测指标（D1 基座）"
```

---

### Task 2: 接线「信号命中」判定到 runtime 事件流

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（或产出 `tool_start`/`text_delta` 的事件源文件 —— 实施时用 `git grep -l tool_start` 定位）
- Create: `services/pi-runtime/src/graph-observation/trigger-detection.ts`
- Test: `services/pi-runtime/src/graph-observation/trigger-detection.test.ts`

**Interfaces:**
- Consumes: `GraphMetrics.observeTrigger` / `observeDetour`（Task 1）；harness 的 `text_delta` 与 `tool_start` 事件
- Produces:
  - `class TurnObserver { constructor(m: GraphMetrics) }` —— 构造时不需要参数注入，事件由 `feed(event)` 灌入
  - `type TurnObserverEvent = { kind: "text"; text: string } | { kind: "tool"; toolName: string } | { kind: "turn_end" }`
  - `containsSignal(text: string, words: readonly string[]): boolean`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { containsSignal, TurnObserver } from "./trigger-detection.js";
import { GraphMetrics } from "./graph-metrics.js";

describe("containsSignal", () => {
  it("命中「示意图」", () => {
    expect(containsSignal("帮我画个示意图", ["图", "示意图"])).toBe(true);
  });
  it("「剧」不含「图」，不误命中", () => {
    expect(containsSignal("这个剧情不合理", ["图"])).toBe(false);
  });
});

describe("TurnObserver", () => {
  it("signal 命中但没调工具 ⇒ 落一条未触发（Review Focus #2）", () => {
    const m = new GraphMetrics();
    const o = new TurnObserver(m);
    o.feed({ kind: "text", text: "给我个示意图" });
    o.feed({ kind: "turn_end" });
    const lines: string[] = [];
    m.renderInto(lines);
    expect(lines.join("\n")).toContain("graph_signal_total 1");
    expect(lines.join("\n")).toContain("graph_drew_total 0");
  });

  it("调了工具 ⇒ 记 drawn 且不记 detour（Review Focus #2）", () => {
    const m = new GraphMetrics();
    const o = new TurnObserver(m);
    o.feed({ kind: "text", text: "给我个示意图" });
    o.feed({ kind: "tool", toolName: "render_canvas_view" });
    o.feed({ kind: "turn_end" });
    const lines: string[] = [];
    m.renderInto(lines);
    expect(lines.join("\n")).toContain("graph_drew_total 1");
  });

  it("画图前调了别的工具 ⇒ 记 detour（Review Focus：token 浪费定位）", () => {
    const m = new GraphMetrics();
    const o = new TurnObserver(m);
    o.feed({ kind: "tool", toolName: "web_search" });
    o.feed({ kind: "tool", toolName: "render_canvas_view" });
    o.feed({ kind: "turn_end" });
    const lines: string[] = [];
    m.renderInto(lines);
    expect(lines.join("\n")).toContain('graph_detour_total{tool="web_search"} 1');
  });

  it("turn_end 后状态清空，下一轮不串味", () => {
    const m = new GraphMetrics();
    const o = new TurnObserver(m);
    o.feed({ kind: "text", text: "示意图" });
    o.feed({ kind: "turn_end" });
    o.feed({ kind: "turn_end" });
    const lines: string[] = [];
    m.renderInto(lines);
    expect(lines.join("\n")).toContain("graph_signal_total 1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— `Cannot find module './trigger-detection.js'`

- [ ] **Step 3: 最小实现**

```ts
import { GraphMetrics, GRAPH_SIGNAL_WORDS } from "./graph-metrics.js";

export type TurnObserverEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string }
  | { kind: "turn_end" };

/** 逐块扫描（文本可能分片到达，跨块拼接后再判定）。 */
export function containsSignal(text: string, words: readonly string[]): boolean {
  return words.some((w) => text.includes(w));
}

const DRAW_TOOL = "render_canvas_view";

export class TurnObserver {
  private buffer = "";
  private signaled = false;
  private drew = false;
  /** 见到的第一个非画图工具 —— 即「绕路嫌疑」，只记第一个，避免把后续正常工具全算成绕路。 */
  private detour: string | null = null;

  constructor(private readonly metrics: GraphMetrics) {}

  feed(e: TurnObserverEvent): void {
    if (e.kind === "text") {
      this.buffer += e.text;
      if (!this.signaled && containsSignal(this.buffer, GRAPH_SIGNAL_WORDS)) {
        this.signaled = true;
      }
      return;
    }
    if (e.kind === "tool") {
      if (e.toolName === DRAW_TOOL) {
        this.drew = true;
        this.metrics.observeView("", false); // 真实 view 由 Task 3 的参数捕获提供
      } else if (!this.drew && this.detour === null) {
        this.detour = e.toolName;
      }
      return;
    }
    // turn_end：结算本轮
    if (this.detour !== null) this.metrics.observeDetour(this.detour);
    this.metrics.observeTrigger({ signaled: this.signaled, drew: this.drew });
    this.buffer = "";
    this.signaled = false;
    this.drew = false;
    this.detour = null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Expected: 6 passed

- [ ] **Step 5: 接线到事件流**

定位事件源（`git grep -l 'tool_start' origin/master -- services/pi-runtime/src`），在其中：
1. 构造一个模块级 `TurnObserver`（与 `ToolMetrics` 同样的生命周期）；
2. 在 `text_delta` 发出后 `feed({kind:"text"})`；
3. 在 `tool_start` 时 `feed({kind:"tool"})`；
4. 在一轮结束时 `feed({kind:"turn_end"})`。

⚠️ **不要改 `tool_start`/`tool_end` 的载荷结构** —— `ToolMetrics` 与其回归锁依赖它。

- [ ] **Step 6: 把 `GraphMetrics.renderInto` 接进 `/metrics`**

在 `app.ts` 渲染 metrics 的地方（与既有指标族同一处）追加 `graph.renderInto(lines)`。
⚠️ **既有 25 个指标族的输出必须逐字不变** —— 接完跑一次 `metrics.test.ts` 确认。

- [ ] **Step 7: 跑全量 runtime 测试 + 提交**

```bash
cd services/pi-runtime && ../../node_modules/.bin/vitest run src/metrics.test.ts src/tool-metrics.test.ts src/graph-observation/
git add services/pi-runtime/src/graph-observation/ services/pi-runtime/src/app.ts
git commit -m "feat(pi-runtime): 接线触发判定到事件流（补齐观测盲区）"
```

---

### Task 3: 捕获工具参数（参数使用率，遗留 L6/L7）

**Files:**
- Modify: `services/pi-runtime/src/tool-metrics.ts`（扩 `ToolLifecycleEvent` 加 `argsPresent?: string[]`）
- Test: `services/pi-runtime/src/tool-metrics.test.ts`（既有文件加用例）

**Interfaces:**
- Consumes: harness 的 `tool_start` 事件里的参数
- Produces: `ToolLifecycleEvent.argsPresent?: string[]` —— **只传参数名列表，不传值**（值可能是用户可控文本，进 label 是注入面）

- [ ] **Step 1: 写失败测试**（追加到既有 `tool-metrics.test.ts`）

```ts
it("只把参数名列表带进事件，不带值", () => {
  const ev: ToolLifecycleEvent = {
    toolName: "render_canvas_view",
    toolCallId: "c1",
    isError: false,
    terminate: false,
    resultText: "ok",
    channel: "0123456789ab",
    model: "m",
    argsPresent: ["view", "relation"],
  };
  expect(ev.argsPresent).toEqual(["view", "relation"]);
  expect(JSON.stringify(ev.argsPresent)).not.toContain("沙丘");
});
```

- [ ] **Step 2: 跑测试确认失败**（TS 报 `argsPresent` 不存在）

- [ ] **Step 3: 实现**

在 `ToolLifecycleEvent` 加 `argsPresent?: string[]`（**可选**，保证既有构造点零改动），
在 `ToolMetrics.observe` 里若有 `argsPresent` 则逐个 `graphMetrics.observeParam(name)`。

⚠️ **安全判据**：只允许参数**名**进 label。参数值可能是 `title="沙丘"` 这类用户文本，
塞进 Prometheus label 等于把用户内容写进监控面，且 label 值有格式约束。

- [ ] **Step 4: 补 legacy 与 view 计数**

`argsPresent` 里有 `view` 时，取其值判断是否为 `topology`/`table`，
调 `graphMetrics.observeView(规范化名, isLegacy)`。
⚠️ **规范化必须在这里做**（`topology` → `layout`），保证 `graph_view_total{view="layout"}` 是两种写法的和（Review Focus #4）。

- [ ] **Step 5: 跑测试 + 提交**

```bash
cd services/pi-runtime && ../../node_modules/.bin/vitest run src/tool-metrics.test.ts src/graph-observation/
git add services/pi-runtime/src/tool-metrics.ts
git commit -m "feat(pi-runtime): 捕获参数名用于使用率统计（L6/L7 数据源）"
```

---

### Task 4: 只读查询脚本（D1 的对外交付面）

**Files:**
- Create: `scripts/query-graph-observation.ts`
- Test: `scripts/query-graph-observation.test.ts`

**Interfaces:**
- Consumes: 生产库 `AgentMessage`（`metadata` JSON 里的 `executionEvents`）
- Produces: `buildReport(events: ExecEvent[]): Report` —— **纯函数，可单测**；
  脚本薄壳只负责读库 + 打印

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { buildReport } from "./query-graph-observation.js";

describe("buildReport", () => {
  it("触发率 = 画了 / 信号命中（零命中也返回 0，不是 NaN）", () => {
    const r = buildReport([
      { type: "text_delta", data: { text: "给我个示意图" } },
      { type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "timeline" } } },
    ]);
    expect(r.signaled).toBe(1);
    expect(r.drew).toBe(1);
    expect(r.triggerRate).toBe(1);
  });

  it("⚛️ 空输入不崩、不返回 NaN（Review Focus #2）", () => {
    const r = buildReport([]);
    expect(r.triggerRate).toBe(0);
    expect(Number.isNaN(r.triggerRate)).toBe(false);
  });

  it("legacy topology 归一到 layout，不双计（Review Focus #4）", () => {
    const r = buildReport([
      { type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "topology" } } },
      { type: "tool_call", data: { toolName: "render_canvas_view", args: { view: "layout", relation: "dependency" } } },
    ]);
    expect(r.views.layout).toBe(2);
    expect(r.views.topology).toBeUndefined();
  });

  it("参数使用率：无参数的调用不计入任何桶（不编造）", () => {
    const r = buildReport([
      { type: "tool_call", data: { toolName: "render_canvas_view", args: {} } },
    ]);
    expect(r.paramUsage).toEqual({});
  });

  it("前置绕路：只记画图前的工具，画图后的不算", () => {
    const r = buildReport([
      { type: "tool_call", data: { toolName: "web_search", args: {} } },
      { type: "tool_call", data: { toolName: "render_canvas_view", args: {} } },
      { type: "tool_call", data: { toolName: "get_canvas_summary", args: {} } },
    ]);
    expect(r.detours.web_search).toBe(1);
    expect(r.detours.get_canvas_summary).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`buildReport` 纯函数：扫 `executionEvents`，按 `type` 分流
（`text_delta` 取 `data.text` 判信号、`tool_call` 取 `data.toolName`/`data.args`），
输出 `{signaled, drew, triggerRate, views, legacy, paramUsage, detours}`。

⚠️ `triggerRate` 分母为 0 时**返回 0**，不是 `NaN`、不是 `Infinity`。

- [ ] **Step 4: 薄壳读库**

```bash
# 用法：pnpm tsx scripts/query-graph-observation.ts --db /path/lnkpi.db --days 7
```
⚠️ SQL **必须用单引号**（SQLite 把 `"` 当标识符）；⚠️ 远端执行须 `scp` SQL 文件后
`sqlite3 db < file`（**ssh heredoc 会吃引号**，2026-10-08 踩过）。

- [ ] **Step 5: 跑测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk && node_modules/.bin/vitest run scripts/query-graph-observation.test.ts
git add scripts/query-graph-observation.ts scripts/query-graph-observation.test.ts
git commit -m "feat(ops): 图形化表达观测查询脚本（D1 对外交付面）"
```

---

### Task 5: 生产基线快照（D1 的收尾）

**Files:** 无代码变更；产出 `docs/ops/graph-observation-baseline-2026-10-08.md`

**Interfaces:**
- Consumes: Task 4 的脚本
- Produces: 一份基线文档 —— **后续每项改动都与它对比**

- [ ] **Step 1: 取生产基线**

```bash
# 本地 → 服务器拷贝生产库 → 用 Task 4 脚本出报告
```
⚠️ 表名 `AgentMessage`（不是 `messages`）；⚠️ 按 `date(createdAt/1000,'unixepoch')` 分组。

- [ ] **Step 2: 写基线文档**

内容：触发率、视图分布、参数使用率（含 L6/L7 的答案）、绕路 top3。
⚠️ **如实写，不修饰**。若触发率极低（如 < 5%），按规格 §7 预案**暂停 Phase 1–3 的能力扩展**，先修触发。

- [ ] **Step 3: 提交**

```bash
git add docs/ops/graph-observation-baseline-2026-10-08.md
git commit -m "docs(ops): 图形化表达调用基线快照（D1 收尾）"
```

---

# Phase 1 · 触发判据（D2）

### Task 6: 把描述性触发规则改为可判定信号

**Files:**
- Modify: `prompt-registry/rules/canvas_view_policy.md`
- Test: `scripts/verify-claims.ts`（新增一条判据断言）

**Interfaces:**
- Consumes: Task 2 的 `GRAPH_SIGNAL_WORDS`
- Produces: 无代码接口；产出「规则文本 → 可匹配信号」

- [ ] **Step 1: 在 `verify-claims.ts` 加断言（先失败）**

新增判据：`canvas_view_policy` 规则文本**不得**出现描述性措辞
（正则 `/\d+\s*个(以上)?节点|2\s*层以上/`），且**必须**包含信号词表里的至少 3 个。

- [ ] **Step 2: 跑 verify-claims 确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk && node_modules/.bin/tsx scripts/verify-claims.ts
```
Expected: FAIL（当前规则含「3 个以上节点」）

- [ ] **Step 3: 改规则**

把规则 16 的触发条件改为可匹配信号，并**补一条反直觉约束**（针对取证发现的绕路）：

```markdown
16. 用户要求图形化表达（说「图/示意图/可视化/关系图/时间线/泳道/拓扑」），
或明确问关系 / 顺序 / 分层 / 阶段 / 分布时：用 render_canvas_view 把已有数据渲成只读卡片。
⚠️ 画布图**不需要**先 web_search 外部资料——画布内容已在手上；
   除非用户明确要查画布之外的事实（那属于知识图谱，用 source=knowledge）。
```

⚠️ **同步数**：规则条数变更需同步 `scripts/verify-claims.ts` 的计数断言与
`prompt-registry` 的索引（2026-07-20 记录过「规则 10 条同步 6+1 处」的纪律）。

- [ ] **Step 4: 跑 verify-claims + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk && node_modules/.bin/tsx scripts/verify-claims.ts
git add prompt-registry/rules/canvas_view_policy.md scripts/verify-claims.ts
git commit -m "fix(prompt): 触发判据改为可判定信号（D2）"
```

---

# Phase 2 · IR 抽取（D3 · 纯重构）

> ⚠️ 本阶段**不改变任何用户可见行为**。验收判据：既有 `render-canvas-view*.test.ts` 全绿且输出逐字节不变。
> ⚠️ 本阶段全部完成后才允许进入 Phase 3（规格 §6 的硬约束）。

### Task 7: 定义 `GraphIR` 与 legacy 解析

**Files:**
- Create: `services/pi-runtime/src/tools/graph/ir.ts`
- Create: `services/pi-runtime/src/tools/graph/ir.test.ts`

**Interfaces:**
- Produces:
  - `type GraphIRNode`、`type GraphIREdge`、`interface GraphIR`（字段照抄规格 §3.2，**含 `sourceKind` 与 `concept`**）
  - `resolveViewAlias(view: string, relation?: string): { view: string; relation: string }`
  - `normalizeView(v: string): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { resolveViewAlias, normalizeView, type GraphIR } from "./ir.js";

describe("legacy 别名", () => {
  it("topology → layout + dependency（Review Focus #4）", () => {
    expect(resolveViewAlias("topology")).toEqual({ view: "layout", relation: "dependency" });
  });
  it("显式 relation 不被别名覆盖", () => {
    expect(resolveViewAlias("topology", "category")).toEqual({ view: "layout", relation: "category" });
  });
  it("table 保留为 table（逐行列表 + 行级 overlay）", () => {
    expect(normalizeView("table")).toBe("table");
  });
  it("⛔ IR 的 view 字段不含 legacy 值", () => {
    const ir: GraphIR = { view: normalizeView("topology"), nodes: [], edges: [] };
    expect(ir.view).not.toBe("topology");
  });
});

describe("GraphIR 不含坐标", () => {
  it("节点没有 position 字段", () => {
    const ir: GraphIR = {
      view: "layout",
      nodes: [{ id: "n1", type: "entity", label: "x", sourceKind: "knowledge" }],
      edges: [],
    };
    expect("position" in (ir.nodes[0] as object)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**（字段严格照抄规格 §3.2）

- [ ] **Step 4: 跑测试 + 提交**

```bash
cd services/pi-runtime && ../../node_modules/.bin/vitest run src/tools/graph/ir.test.ts
git add services/pi-runtime/src/tools/graph/
git commit -m "feat(pi-runtime): GraphIR 与 legacy 别名解析（D3-1）"
```

---

### Task 8: 五个视图算法改为「IR → 坐标」

**Files:**
- Create: `services/pi-runtime/src/tools/graph/layout/{relation,timeline,hierarchy,stages,matrix}.ts`
- Test: 对应 5 个 `*.test.ts`
- Modify: `services/pi-runtime/src/tools/render-canvas-view.views.ts`（渲染器改为消费坐标）

**Interfaces:**
- Consumes: `GraphIR`（Task 7）
- Produces: 每个模块导出 `computeLayout(ir: GraphIR): PositionedNode[]` 与 `computeEdges(ir): PositionedEdge[]`
  - `type PositionedNode = GraphIRNode & { x: number; y: number }`

- [ ] **Step 1: 每个布局写失败测试**

以 `timeline` 为例（**判据：输入是 IR，输出是坐标，不是 SVG 字符串**）：

```ts
import { describe, it, expect } from "vitest";
import { computeLayout } from "./timeline.js";

describe("timeline 布局", () => {
  it("按 dim.time 升序排布 x", () => {
    const pos = computeLayout({
      view: "timeline",
      nodes: [
        { id: "b", type: "milestone", label: "第二幕", dim: { time: "2026-02" } },
        { id: "a", type: "milestone", label: "第一幕", dim: { time: "2026-01" } },
      ],
      edges: [],
    });
    expect(pos[0].x).toBeLessThan(pos[1].x);
  });

  it("⚠️ 节点紧排不留 vast 空（Review Focus：布局密度）", () => {
    const pos = computeLayout({
      view: "timeline",
      nodes: Array.from({ length: 26 }, (_, i) => ({
        id: `n${i}`, type: "entity" as const, label: `n${i}`, dim: { time: `2026-01-${String(i + 1).padStart(2, "0")}` },
      })),
      edges: [],
    });
    const gap = Math.max(...pos.map(p => p.x)) - Math.min(...pos.map(p => p.x));
    // 26 个节点在时间轴上应有界，而不是随节点数线性爆炸
    expect(gap).toBeLessThanOrEqual(pos.length * 220);
  });

  it("空 IR 不崩", () => {
    expect(computeLayout({ view: "timeline", nodes: [], edges: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现五个布局**（每个都是纯函数：IR 进、坐标出）

⚠️ **布局紧凑化是本阶段的关键收益**：26 个节点散在 200–400px 间距里，
无论怎么缩放都是「vast 空里几个小点」。布局算法**不重排外部语义**，只保证相邻节点间距有上界。

- [ ] **Step 4: 渲染器改为消费坐标**

`render-canvas-view.views.ts` 的 `build*Svg` 改为：`computeLayout(ir)` → 渲染器纯消费坐标。

- [ ] **Step 5: 验证「纯重构」判据**

```bash
cd services/pi-runtime && ../../node_modules/.bin/vitest run src/tools/render-canvas-view
```
Expected: **既有全部测试全绿且输出逐字节不变**。⚠️ 若任何输出变了，停下重做——这说明动了行为。

- [ ] **Step 6: 提交**

```bash
git add services/pi-runtime/src/tools/
git commit -m "refactor(pi-runtime): 五个视图改为 IR→坐标计算（D3-2，纯重构）"
```

---

# Phase 3 · 能力补齐与渲染分工（D4/D5）

### Task 9: `source=knowledge`（用户意图①）

> ⚠️ 本任务依赖 Phase 2 全部完成。

**Files:**
- Modify: `services/pi-runtime/src/tools/render-canvas-view.ts`（source 分支）
- Test: `services/pi-runtime/src/tools/render-canvas-view.knowledge.test.ts`

**Interfaces:**
- Consumes: `GraphIR`（Task 7）、`computeLayout`（Task 8）
- Produces: `buildFromKnowledge(args: { entities: Array<{id,label,category?,definition?}>; relations: Array<{from,to,kind}> }, view): GraphIR`

- [ ] **Step 1: 写失败测试**

```ts
it("🔴 空画布 + knowledge 来源仍能出图（Review Focus #1 · 用户意图①硬判据）", () => {
  const ir = buildFromKnowledge(
    { entities: [{ id: "c1", label: "概念一" }, { id: "c2", label: "概念二" }],
      relations: [{ from: "c1", to: "c2", kind: "dependency" }] },
    "relation",
  );
  expect(ir.nodes).toHaveLength(2);
  expect(ir.source).toBe("knowledge");
});

it("knowledge 节点带 sourceKind=knowledge 与 concept（渲染层据此选视觉语言）", () => {
  const ir = buildFromKnowledge(
    { entities: [{ id: "c1", label: "x", category: "人物", definition: "主角" }], relations: [] },
    "relation",
  );
  expect(ir.nodes[0].sourceKind).toBe("knowledge");
  expect(ir.nodes[0].concept?.definition).toBe("主角");
});

it("⛔ knowledge 节点不得有 canvasNodeId", () => {
  const ir = buildFromKnowledge({ entities: [{ id: "c1", label: "x" }], relations: [] }, "relation");
  expect(ir.nodes[0].canvasNodeId).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

⚠️ **不新增工具参数**：`source` 复用现有参数的组合表达
（`source=canvas` 是默认；`source=knowledge` 由「传了 `nodes` 且不带 `canvasNodeId`」判定）。
⚠️ 若实现确实需要一个新参数名，先回到规格 §4.3 重新论证。

- [ ] **Step 4: 跑测试 + 提交**

---

### Task 10: `source=mixed` 与降级显式化

**Files:**
- Modify: `services/pi-runtime/src/tools/render-canvas-view.ts`
- Test: `services/pi-runtime/src/tools/render-canvas-view.mixed.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("mixed：画布素材 + 模型补关系", () => { /* ... */ });

it("🔴 mixed 但画布无相关节点 ⇒ 退化为 knowledge 并显式记录降级（Review Focus #5）", () => {
  const r = renderMixed({ canvasNodes: [], modelRelations: [{ from: "a", to: "b" }] });
  expect(r.degradedFrom).toBe("mixed");
  expect(r.ir.source).toBe("knowledge");
  expect(r.warnings.length).toBeGreaterThan(0); // ⛔ 不静默
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**（降级必须带 `warnings`，沿用现有 `missing` 清单的呈现方式）

- [ ] **Step 4: 跑测试 + 提交**

---

### Task 11: 渲染形态自动选择

**Files:**
- Modify: `services/pi-runtime/src/tools/render-canvas-view.ts`（决定发哪种 command）
- Test: `services/pi-runtime/src/tools/render-canvas-view.render-choice.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("需要 overlay ⇒ 静态图（节点图承载不了曲线）", () => {
  expect(chooseRender({ hasOverlay: true, nodeCount: 5, userWantsOpen: false })).toBe("svg");
});
it("节点数 > 15 ⇒ 静态图", () => {
  expect(chooseRender({ hasOverlay: false, nodeCount: 26, userWantsOpen: false })).toBe("svg");
});
it("用户说打开看看 + 节点少 ⇒ 节点图", () => {
  expect(chooseRender({ hasOverlay: false, nodeCount: 8, userWantsOpen: true })).toBe("node_graph");
});
it("默认 ⇒ 静态图", () => {
  expect(chooseRender({ hasOverlay: false, nodeCount: 8, userWantsOpen: false })).toBe("svg");
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `chooseRender`**（照抄规格 §4.1 的判据表，**不加 `interactive` 参数**）

- [ ] **Step 4: 跑测试 + 提交**

---

### Task 12: 嵌入画布落地为结构化节点组

**Files:**
- Modify: `apps/web/src/pages/CanvasPage.vue`（现有 `handleImportNodeGraph`）
- Test: `apps/web/src/pages/canvasImportGraph.nodegroup.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("导入产出结构化节点（可编辑），不是一张位图", () => {
  const r = importGraphToCanvas({ nodes: [{ id: "a", label: "概念", type: "entity" }], edges: [] });
  expect(r.nodes[0].type).not.toBe("image"); // ⛔ 不是位图
  expect(r.nodes[0].data.text).toBe("概念");
});

it("IR 的 concept.definition 落进节点内容（agent 可读懂）", () => {
  const r = importGraphToCanvas({ nodes: [{ id: "a", label: "x", concept: { definition: "主角" } }], edges: [] });
  expect(r.nodes[0].data.text).toContain("主角");
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**（复用现有 `handleImportNodeGraph`；⚠️ 保持「不自动持久化」的既有决策并留注释说明理由）

- [ ] **Step 4: 跑测试 + 提交**

---

# 收尾

### Task 13: 全量验证与门禁

- [ ] **Step 1: 跑全部门禁**

```bash
cd /Users/4seven/workspace/pi-lnk
node_modules/.bin/tsx scripts/verify-claims.ts       # 7/7
node_modules/.bin/tsx scripts/verify-tool-contract.ts # 4 hooks guarded
node_modules/.bin/tsx scripts/verify-links.ts        # 无断链
node_modules/.bin/tsx scripts/verify-spec-figures.ts # 0 错误
cd services/pi-runtime && ../../node_modules/.bin/vitest run
cd apps/web && node_modules/.bin/vitest run
```

⚠️ `apps/web` 若报 `Cannot find module "mermaid"` —— 那是本机 node_modules 缺包（既有环境问题，
`pnpm install` 会被沙箱拦 `ERR_PNPM_CODEBUDDY_BROKER_DENY`）；用桩模块绕过，
⚛️ **不要**因此改 `package.json`。

- [ ] **Step 2: 变异验证关键测试**

对 Task 1、Task 7、Task 8 各做一次「反向修改 ⇒ 测试应变红」。

- [ ] **Step 3: 开 PR + 盯 CI + 按 prod-deploy-verify 验证**

⚠️ 合并前查 `mergeStateStatus` 为 `CLEAN` 且 `MERGEABLE` 才合；
⚠️ 判「已合入」用 `gh pr view <n> --json mergeCommit.oid`（**禁用** `git cherry` / `rev-list --count`）。

---

## 自查记录

**规格覆盖**：D1 → Task 1–5；D2 → Task 6；D3 → Task 7–8；D4 → Task 9–10；
D5 → Task 11–12；遗留 L6/L7 → Task 3；§8 验收 → 各任务的 Step「跑测试」+ Task 13。

**已知未覆盖**：规格 §9 的 N1–N7 是**非目标**，不产生任务（已在计划中显式排除）。
缩略图取图链路（L5）不在本计划范围，Task 12 只保证不依赖它。

**类型一致性**：`GraphIRNode.canvasNodeId` / `concept` / `sourceKind`
在 Task 7 定义，Task 9/10/12 使用时字段名一致；
`GraphMetrics.observeView(view, isLegacy)` 的两参签名在 Task 1/2/3 一致。
