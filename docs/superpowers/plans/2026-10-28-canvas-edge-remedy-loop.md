# 连线根治闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移动端连线可见（Q1）+ `connect_nodes` 悬空端点 fail-closed 与回执（P1c）+ 画布动作派发/暂存丢弃可观测（O1/O2 服务端日志）。

**Architecture:** 三个互不依赖的纵切任务：①服务端 `connectNodes` 在既有去重逻辑前加端点/自环校验，回执增量字段随 `resultWithActions.content.text` 自动达模型（runtime 零改动）；②`pi-events.ts` 三类静默 continue 与 stage TTL 清空补 Nest Logger 结构化 warn；③新 L2 令牌 `--lnk-canvas-edge-strong` + 移动端自有 CSS（壳层导入，media query 门控）。

**Tech Stack:** NestJS（apps/server，vitest）、Vue 3 + vue-flow（apps/web，vitest + vue-tsc）、design-tokens.css L2 令牌。

**Spec:** `docs/superpowers/specs/2026-10-28-canvas-edge-remedy-loop-design.md`

## Global Constraints

- vitest 必跑 nvm node24；单文件跑，不并发整批（4 核/8GB ⇒ `--maxWorkers=1 --no-file-parallelism`）。
- 改 `apps/web` 组件后必跑 `pnpm --filter web exec vue-tsc -b`。
- 新增样式值只进 `design-tokens.css` L2（`--lnk-*` 前缀、深浅成对）；禁 `--neo-*` 再生长；禁组件内新增 hex/rgba。
- 禁 `git add -A`；逐文件显式 add；commit 只含本计划文件。
- 工具出入参只做**增量**变更（回执新字段），不改 `details.actions` 形状 ⇒ 不触发提示词 6 处同步。
- Bash cwd 每条重置 ⇒ 命令一律内联 `cd <绝对路径> &&`。

## Review Focus

1. **混合批次**：一条有效边 + 一条悬空边同批 ⇒ 有效边必须照常落库、悬空边进 rejected（不是整批失败也不是整批拒绝）→ Task 1 Step 1 的 `connectNodes applies valid edges and rejects dangling endpoints in a mixed batch` 钉住。
2. **用户显式设置优先级**：用户设置过 `edgeColor`/`edgeWidth` 时移动端不得覆盖用户值 → 由 CSS 变量优先级保证（`--canvas-edge-color` 存在则两规则同让位）；Task 3 契约测试钉 `var(--canvas-edge-color, …)` 回退形态。
3. **SSE 派发零感知**：connectNodes 返回值新增字段后 `details.actions` 必须仍只含 add_edge 动作 → Task 1 Step 1 断言 `result.actions` 数组内容不变形。
4. **日志噪音**：纯 isError（无 actions）不记日志；健康链路零新增 warn → Task 2 Step 1 断言。
5. **桌面零回归**：`--lnk-canvas-edge-strong` 只被 ≤767px media query 内的规则引用，桌面规则块不引用它 → Task 3 Step 1 契约测试断言 media query 包裹。

---

### Task 1: connectNodes 端点 fail-closed 校验与回执（P1c）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts:1260-1285`（`connectNodes`）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`（既有 `connectNodes adds edges` 用例旁追加）

**Interfaces:**
- Consumes: 既有 `loadSession` / `applyOrStage` / `edgeId`（均在本 service 内）。
- Produces: `connectNodes(input) => Promise<{ actions: CanvasAction[]; applied: number; duplicates: number; rejected: Array<{ source: string; target: string; reason: 'source_not_found' | 'target_not_found' | 'self_loop' }> }>`。controller 与 `resultWithActions` 零改动（透传）。

- [ ] **Step 1: 写失败测试**

在 `agent-canvas-tools.service.test.ts` 的 `connectNodes adds edges` 用例后追加：

```ts
  it('connectNodes applies valid edges and rejects dangling endpoints in a mixed batch', async () => {
    canvas = {
      nodes: [
        { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
        { id: 'b', type: 'image', position: { x: 280, y: 0 }, data: {} },
      ],
      edges: [],
    }
    const result = await svc.connectNodes({
      sessionId: 's1',
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'ghost-1' },
        { source: 'ghost-2', target: 'b' },
        { source: 'a', target: 'a' },
      ],
    })
    // 有效边照常落库
    expect(canvas.edges).toHaveLength(1)
    expect(result.applied).toBe(1)
    // 无效边进回执，带可行动 reason，不抛错
    expect(result.rejected).toEqual([
      { source: 'a', target: 'ghost-1', reason: 'target_not_found' },
      { source: 'ghost-2', target: 'b', reason: 'source_not_found' },
      { source: 'a', target: 'a', reason: 'self_loop' },
    ])
    // SSE 派发零感知：details.actions 源头（result.actions）仍只含 add_edge
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].type).toBe('add_edge')
  })

  it('connectNodes counts duplicates without duplicating edges', async () => {
    canvas = {
      nodes: [
        { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
        { id: 'b', type: 'image', position: { x: 280, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e-a-b', source: 'a', target: 'b' }],
    }
    const result = await svc.connectNodes({
      sessionId: 's1',
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
      ],
    })
    expect(result.applied).toBe(0)
    expect(result.duplicates).toBe(2)
    expect(result.rejected).toEqual([])
    expect(canvas.edges).toHaveLength(1)
  })
```

并把既有用例 `connectNodes adds edges` 的末尾补一行回执断言：

```ts
    expect(result.applied).toBe(1)
    expect(result.rejected).toEqual([])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/apps/server && npx vitest run src/agent/agent-canvas-tools.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: 新增两用例 FAIL（`rejected`/`applied`/`duplicates` undefined 或断言不等），既有用例 PASS。

- [ ] **Step 3: 最小实现**

改 `connectNodes`（保持 `loadSession`/`applyOrStage` 调用不变）：

```ts
  async connectNodes(input: {
    sessionId: string
    edges: Array<{ source: string; target: string }>
    stage?: boolean
  }): Promise<{
    actions: CanvasAction[]
    applied: number
    duplicates: number
    rejected: Array<{
      source: string
      target: string
      reason: 'source_not_found' | 'target_not_found' | 'self_loop'
    }>
  }> {
    const { canvas } = await this.loadSession(input.sessionId)
    const actions: CanvasAction[] = []
    const existing = new Set(canvas.edges.map((e) => `${e.source}->${e.target}`))
    // P1c（spec 2026-10-28-canvas-edge-remedy-loop-design.md §3.2）：
    // 端点 fail-closed —— 悬空边此前会静默落库，前端渲染层静默丢弃，
    // 用户永远看不到（2026-10-28 连线不可见个案的病根预防）。
    const nodeIds = new Set(canvas.nodes.map((n) => n.id))
    const rejected: Array<{
      source: string
      target: string
      reason: 'source_not_found' | 'target_not_found' | 'self_loop'
    }> = []
    let duplicates = 0

    for (const edge of input.edges) {
      if (edge.source === edge.target) {
        rejected.push({ source: edge.source, target: edge.target, reason: 'self_loop' })
        continue
      }
      const key = `${edge.source}->${edge.target}`
      if (existing.has(key)) {
        duplicates += 1
        continue
      }
      if (!nodeIds.has(edge.source)) {
        rejected.push({ source: edge.source, target: edge.target, reason: 'source_not_found' })
        continue
      }
      if (!nodeIds.has(edge.target)) {
        rejected.push({ source: edge.source, target: edge.target, reason: 'target_not_found' })
        continue
      }
      existing.add(key)
      actions.push({
        type: 'add_edge',
        payload: {
          id: edgeId(edge.source, edge.target),
          source: edge.source,
          target: edge.target,
        },
      })
    }

    if (rejected.length > 0) {
      // 回执同时经 resultWithActions.content.text 到模型（自纠错），此处只留服务端痕
      this.logger?.warn?.(
        `connectNodes rejected ${rejected.length}/${input.edges.length} edges (session=${input.sessionId}) ` +
          JSON.stringify(rejected).slice(0, 500),
      )
    }

    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { actions, applied: actions.length, duplicates, rejected }
  }
```

并在 service 类内补 logger（沿用 `agent.service.ts:1108` 的形态 `private readonly logger = new Logger(AgentCanvasToolsService.name)`，import 缺则补 `import { Logger } from '@nestjs/common'`）。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。
Expected: 全部 PASS（含既有用例）。

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk && git add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.service.test.ts && git commit -m "feat(canvas-tools): connect_nodes endpoint fail-closed validation with applied/duplicates/rejected receipt (SP-F P1c)"
```

---

### Task 2: 画布动作派发/暂存丢弃可观测（O1/O2 服务端日志）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts:486-504`（`extractCanvasActions`）
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（`expireStaleStage`，约 `:3652-3663`）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`；service 侧断言并入 Task 1 的测试文件（若 stage 测试 harness 存在则跟随，否则以 `expireStaleStage` 为可导出纯逻辑补最小用例）

**Interfaces:**
- Produces: `pi-events.ts` 导出 `piEventsLogger`（`new Logger('PiEvents.canvas_action')`）供测试 spy；`extractCanvasActions` 签名与返回不变。

- [ ] **Step 1: 写失败测试**

在 `pi-events.test.ts` 追加（沿用文件既有构造 event 的辅助/字面量风格）：

```ts
describe('extractCanvasActions 可观测（SP-F O1）', () => {
	it('zod 丢弃记 warn，含首个 issue path', () => {
		const warn = vi.spyOn(piEventsLogger, 'warn').mockImplementation(() => {})
		const actions = extractCanvasActions(
			toolEndEvent({ actions: [{ type: 'add_node', payload: { id: 'n1' } }] }), // 缺 source 字段 ⇒ zod 失败
		)
		expect(actions).toHaveLength(0)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(String(warn.mock.calls[0][0])).toContain('zod_drop')
		warn.mockRestore()
	})

	it('nodeType 白名单丢弃记 warn；isError 且有 actions 记 partial_skip；纯 isError 不记', () => {
		const warn = vi.spyOn(piEventsLogger, 'warn').mockImplementation(() => {})
		extractCanvasActions(toolEndEvent({ actions: [{ type: 'add_node', payload: { id: 'n1', nodeType: 'hologram', source: 's' } }] }))
		expect(String(warn.mock.calls[0][0])).toContain('whitelist_drop')
		extractCanvasActions(toolEndEvent({ actions: [{ type: 'add_edge', payload: { id: 'e', source: 'a', target: 'b' } }] }, { isError: true }))
		expect(String(warn.mock.calls[1][0])).toContain('partial_skip')
		const before = warn.mock.calls.length
		extractCanvasActions(toolEndEvent({}, { isError: true })) // 无 actions ⇒ 纯失败，不记
		expect(warn.mock.calls.length).toBe(before)
		warn.mockRestore()
	})
})
```

（`toolEndEvent` 形状以文件既有 helper 为准；没有 helper 就按既有用例的字面量内联。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/apps/server && npx vitest run src/agent/pi-runtime/pi-events.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（`piEventsLogger` 未导出 / warn 未被调用）。

- [ ] **Step 3: 最小实现**

`pi-events.ts`：

```ts
import { Logger } from "@nestjs/common";

/** SP-F O1（spec 2026-10-28-canvas-edge-remedy-loop-design.md §3.3）：
 *  三类静默丢弃的可观测出口。健康链路零频；指标化随 SP-E §8.1。 */
export const piEventsLogger = new Logger("PiEvents.canvas_action");
```

`extractCanvasActions` 循环体改为：

```ts
	const d = event.data as {
		isError?: boolean;
		toolCallId?: string;
		toolName?: string;
		result?: { details?: { actions?: unknown } };
	};
	if (d.isError) {
		const pending = d.result?.details?.actions;
		// F2（架构审视 2026-10-28 §4.1）：部分成功的工具连已发生的动作都不下发——只在这种情况留痕，纯失败不记
		if (Array.isArray(pending) && pending.length > 0) {
			piEventsLogger.warn(
				`canvas_action partial_skip isError=true tool=${d.toolName ?? "?"} dropped=${pending.length}`,
			);
		}
		return [];
	}
	const actions = d.result?.details?.actions;
	if (!Array.isArray(actions)) return [];
	const out: CanvasAction[] = [];
	for (const a of actions) {
		const parsed = CanvasActionSchema.safeParse(a);
		if (!parsed.success) {
			piEventsLogger.warn(
				`canvas_action zod_drop tool=${d.toolName ?? "?"} issues=${parsed.error.issues.length} first=${parsed.error.issues[0]?.path.join(".")}`,
			);
			continue;
		}
		const nodeType = parsed.data.payload.nodeType;
		if (nodeType !== undefined && !NODE_TYPE_SET.has(nodeType)) {
			piEventsLogger.warn(`canvas_action whitelist_drop tool=${d.toolName ?? "?"} nodeType=${nodeType}`);
			continue;
		}
		out.push(parsed.data);
	}
	return out;
```

`expireStaleStage` 清空分支（`agent-canvas-tools.service.ts:3652-3663`）在 delete 前补：

```ts
		this.logger?.warn?.(
			`stageCanvasActions expired: dropped ${staged.actions.length} staged actions (session=${sessionId}, ageMs=${Date.now() - staged.stagedAt})`,
		)
```

（`staged` 的字段名以实际实现为准；若暂存记录无时间戳则去掉 ageMs，以实际读取为准，不假造字段。）

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2 + Task 1 Step 2 的 service 测试。
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk && git add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts apps/server/src/agent/agent-canvas-tools.service.ts && git commit -m "feat(agent): structured warn logs for canvas_action drops and stage TTL expiry (SP-F O1/O2)"
```

---

### Task 3: 移动端连线可见性（Q1）

**Files:**
- Modify: `apps/web/src/styles/design-tokens.css`（dark 块 `:245` 附近、light 块 `:390` 附近各加一行）
- Create: `apps/web/src/components/mobile/MobileCanvasEdge.css`
- Modify: `apps/web/src/components/mobile/MobileCanvasShell.vue`（script 头部加一行 CSS import）
- Test: `apps/web/src/components/mobile/MobileCanvasEdge.test.ts`（新建）

**Interfaces:**
- Produces: L2 令牌 `--lnk-canvas-edge-strong`（dark: `rgba(148, 151, 180, 0.62)` / light: `rgba(23, 25, 35, 0.5)`）；全局 CSS 规则（≤767px 生效）。无 TS 接口。

- [ ] **Step 1: 写失败测试（契约测试；CSS 用 fs 读——`?raw` 对 .css 返回空串，见 AgentNodeGraph.test.ts:85 注释）**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = new URL('../../../', import.meta.url).pathname

describe('MobileCanvasEdge（SP-F Q1 契约）', () => {
  const css = readFileSync(`${WEB_ROOT}src/components/mobile/MobileCanvasEdge.css`, 'utf8')
  const tokens = readFileSync(`${WEB_ROOT}src/styles/design-tokens.css`, 'utf8')
  const shell = readFileSync(`${WEB_ROOT}src/components/mobile/MobileCanvasShell.vue`, 'utf8')

  it('规则被 ≤767px media query 包裹（桌面零回归，Review Focus #5）', () => {
    const block = css.match(/@media \(max-width: 767px\)\s*\{[\s\S]*\}/)?.[0] ?? ''
    expect(block).toContain('.vue-flow__edge-path')
    expect(block).toContain('stroke-width: 2px')
  })

  it('消费 L2 令牌且保留用户显式 edgeColor 优先（Review Focus #2）', () => {
    expect(css).toContain('var(--canvas-edge-color, var(--lnk-canvas-edge-strong))')
    expect(css).not.toMatch(/rgba\(/) // 禁新增 rgba 字面量进组件样式（设计体系硬约束 1）
  })

  it('令牌深浅成对（V-2）', () => {
    const dark = tokens.match(/:root\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    const light = tokens.match(/:root\[data-theme='light'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(dark).toContain('--lnk-canvas-edge-strong:')
    expect(light).toContain('--lnk-canvas-edge-strong:')
  })

  it('壳层导入本样式（规则 1：移动端编排唯一所有者是壳层）', () => {
    expect(shell).toContain("import './MobileCanvasEdge.css'")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/apps/web && npx vitest run src/components/mobile/MobileCanvasEdge.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（文件不存在）。

- [ ] **Step 3: 最小实现**

`design-tokens.css` dark 块 `--lnk-border-*` 邻近加：

```css
  --lnk-canvas-edge-strong: rgba(148, 151, 180, 0.62);
```

light 块对应位置加：

```css
  --lnk-canvas-edge-strong: rgba(23, 25, 35, 0.5);
```

新建 `MobileCanvasEdge.css`：

```css
/**
 * 移动端连线可见性兜底（SP-F Q1，spec 2026-10-28-canvas-edge-remedy-loop-design.md §3.1）。
 *
 * 背景：2026-10-28 个案取证——移动端 agent 连线在画布上不可见（默认 --neo-edge
 * alpha 0.3 × 磁贴缝隙 × fitView 缩放 ≈ 亚像素淡线）。本文件只抬移动端可见性下限：
 * - 桌面规则块（neo-node.css:1553）不动；
 * - 用户显式 edgeColor/edgeWidth 设置优先（--canvas-edge-color / --canvas-edge-width 存在时本规则让位）；
 * - 特异性 (0,3,0) 压过基线 (0,2,0)，双方均 !important，不依赖 import 顺序。
 * 锚点退化（MobileNodeTile 无 Handle）与布局网格属 P3，不在本文件。
 */
@media (max-width: 767px) {
  .vue-flow .vue-flow__edge .vue-flow__edge-path {
    stroke: var(--canvas-edge-color, var(--lnk-canvas-edge-strong)) !important;
    stroke-width: 2px !important;
  }
}
```

`MobileCanvasShell.vue` script 头部（既有 import 之后）加：

```ts
import './MobileCanvasEdge.css'
```

- [ ] **Step 4: 跑测试与守卫确认通过**

Run:
```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && npx vitest run src/components/mobile/MobileCanvasEdge.test.ts src/styles/design-token.test.ts src/styles/theme-usage.test.ts src/styles/text-token-guard.test.ts src/styles/dead-styles.test.ts --maxWorkers=1 --no-file-parallelism
```
（守卫测试文件名以 `ls apps/web/src/styles/*.test.ts` 实际为准。）
Expected: 全部 PASS。

再跑 `cd /Users/4seven/workspace/pi-lnk/apps/web && npx vue-tsc -b`。Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk && git add apps/web/src/styles/design-tokens.css apps/web/src/components/mobile/MobileCanvasEdge.css apps/web/src/components/mobile/MobileCanvasShell.vue apps/web/src/components/mobile/MobileCanvasEdge.test.ts && git commit -m "feat(mobile): stronger default canvas edge visibility <=767px via --lnk-canvas-edge-strong (SP-F Q1)"
```

---

### 收尾

- [ ] 全量回归（分批）：server `src/agent/agent-canvas-tools*.test.ts src/agent/pi-runtime/pi-events.test.ts`；web Task 3 五文件 + `vue-tsc -b`。
- [ ] `docs/README.md` 登记 spec/plan 两份新文档。
- [ ] 真机走查项登记到移动端 UX 重构 §8 清单（连线可见性专项，V-1 的最终口径）——本轮只登记不实施。
