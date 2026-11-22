> ⛔ SUPERSEDED（2026-11-22）：用户生产复测否定三阶段并列 / ①②③ 序号 / UI 拼装小结 / 钉底任务卡。
> 本方案由 `2026-11-22-turn-inline-status-checklist-design.md` 取代，保留本文仅供决策轨迹追溯。

# 一轮 Turn 内阶段性状态与阶段小结（临时进度）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`（推荐）或
> `superpowers:subagent-driven-development` 逐 task 实施。步骤使用 `- [ ]` 跟踪。
>
> **Goal:** 在活跃 Turn 的 SSE 对话流内联渲染「命名阶段 + 阶段小结」，回合收口即消失，历史轮零残留。
>
> **Architecture:** 渲染期纯派生视图（不落库、不发事件）接入 `AgentTurnTimeline`；阶段分类复用
> `phaseAggregator` 既有 `WRITE_TOOLS` 语义（析出 `phaseForToolName`）；任务进度通过既有
> `taskProgress` 状态以 prop 传入，composer 灰字与轮末摘要完全不动。
>
> **Tech Stack:** Vue 3 `<script setup>` + TypeScript + vitest + Pinia；仅 `apps/web` 改动。
>
> **Spec:** [`../specs/2026-11-22-turn-phase-progress-design.md`](../specs/2026-11-22-turn-phase-progress-design.md)

## 0. 第一原则

吃满上游、不重复造轮子。逐项「等价物检索」结论见规格 §0；本计划**零新增数据字段、
零 SSE 事件、零 DB migration、零新令牌**，只新增 1 个纯函数导出、1 个纯派生模块、
1 个 prop 与 1 段组件内模板。任何实施中出现的「新造字段 / 新造事件 / 造数」一律驳回。

## 1. Global Constraints（逐字取自规格）

- 阶段小结 = **临时进度 + 完成时收口**；活跃期可见，收口即消失，不写 `parts`、不进历史。
- 阶段名只能来自 `PHASE_BADGE`（探索中 / 创作中 / 收尾中），不造第四态。
- `parts` 为空 ⇒ 视图返回 `null`；无真实小结/细节 ⇒ 不渲染，禁止 `0/0`、`XXXXXX` 占位。
- 收口双门禁：`props.streaming === true` **且** `!isTurnFinalized(parts)`（稳定 id `notice:turn-summary`）。
- 活跃/未开始阶段永不显示耗时；耗时只用 `tool.ms` / `thinking.startedAt,endedAt` 真实字段。
- 禁止复活 `turnStatusLine` / `statusTicker` / `settledDismissed` / 钉底镜像 / `describeActivityFromTimeline`。
- 禁止新增「执行过程」总折叠块（折叠粒度仍是单个 part）。
- 令牌只用 `--lnk-*`，禁用 `--lnk-hi-bg/hi-text` 表示状态、禁新增 hex / `rgba(` / `--neo-*`。
- 移动端 / PC 同组件同形态，不新增 `isMobileLayout` 分支。
- 服务端 / pi-runtime / prompt-registry / DB 零改动；部署仅 web-only。

## 2. Review Focus（规格暗示但任务测试最容易漏的 5 类输入）

1. **上滑回看历史时活跃轮仍在滚动流内** —— 阶段条不得钉底/镜像，composer 灰字必须仍可见；
   测到 Task 4 的 `AgentSideRail` 接线用例 + 守卫用例。
2. **收口瞬间与刷新后** —— `streaming=false` 或 `notice:turn-summary` 到达后 strip 必须为 0，
   而持久摘要 notice 必须仍在；测到 Task 3 的生命周期用例。
3. **无 task 事件 / 无耗时字段 / 未知工具** —— 不得出现 `0/0`、假秒数或凭空阶段名；
   测到 Task 2 的纯函数用例（缺字段 / 空数组 / `brand_new_tool`）。
4. **两个状态面互相矛盾** —— 等待确认时阶段不得自行推进，composer `turn-live-status`
   必须保持原文案与位置；测到 Task 2 等待态用例 + Task 4 原灰字断言保持通过。
5. **主题与令牌** —— 活跃阶段在深浅主题下均可读且只用 `--lnk-*`；测到 Task 3 令牌扫描 +
   `design-token.test.ts`。

## 3. 文件地图

| 文件 | 责任 |
|---|---|
| `apps/web/src/components/agent/phaseAggregator.ts` | 既有阶段分类单源；新增导出 `phaseForToolName()`，`derivePhase()` 改为调用它 |
| `apps/web/src/components/agent/turnPhaseView.ts`（新） | `parts + taskProgress → TurnPhaseView` 纯派生；`isTurnFinalized()` |
| `apps/web/src/components/agent/turnPhaseView.test.ts`（新） | 纯函数行为与禁造数判据 |
| `apps/web/src/components/agent/AgentTurnTimeline.vue` | 新增 `taskProgress?` prop 与 strip 模板/样式；不改任何 part 分支 |
| `apps/web/src/components/agent/AgentTurnTimeline.phaseStrip.test.ts`（新） | mount 生命周期与文案判据 |
| `apps/web/src/components/agent/AgentSideRail.vue` | 仅 1 行 prop 接线 |
| `apps/web/src/components/agent/AgentSideRail.phaseStripWiring.test.ts`（新） | 活跃轮 vs 历史轮的 prop 归属、灰字不回退 |
| `apps/web/src/components/agent/AgentSideRail.mobileLivePin.test.ts` | 扩展反向守卫（已有文件，只追加） |
| `docs/README.md` + `scripts/docs/index_data.json` + `docs/superpowers/INDEX.md` | 文档登记与索引重生成（本 docs 分支已做/实施分支同步） |

---

## 4. 任务分解

### Task 0 · 文档与分支基线（本计划已执行，实施者只需核对）

- [ ] **Step 1：核对基线**

```bash
cd /Users/4seven/workspace/pi-lnk
git log -1 --oneline origin/master        # 期望 2b98f446 或更新的同族基线
git branch --show-current                 # 文档分支 docs/turn-phase-progress-20261122
git status --short                        # 主仓其它窗口的脏改动，全程只读，不碰
```

- [ ] **Step 2：实施另开 feat 分支**（不在 docs 分支上写代码）

```bash
git fetch origin
git worktree add .worktrees/turn-phase-progress-impl \
  -b feat/turn-phase-progress-20261122 origin/master
```

- [ ] **Step 3：依赖借用**（沙箱禁 symlink 安装时用；见 branch-first-dev-workflow skill）

```bash
MAIN=/Users/4seven/workspace/pi-lnk
WT=$MAIN/.worktrees/turn-phase-progress-impl
cd "$WT" && rm -rf node_modules packages/*/node_modules
ln -s $MAIN/node_modules node_modules
mkdir -p packages/web/node_modules
ln -s $MAIN/packages/web/node_modules/vitest packages/web/node_modules/vitest
ln -s $MAIN/packages/web/node_modules/typescript packages/web/node_modules/typescript
```

- [ ] **Step 4：提交**

```bash
git add docs/superpowers/specs/2026-11-22-turn-phase-progress-design.md \
        docs/superpowers/plans/2026-11-22-turn-phase-progress.md docs/README.md \
        scripts/docs/index_data.json docs/superpowers/INDEX.md
git commit -m "docs(agent): 一轮 Turn 阶段性状态与临时阶段小结立项规格+计划"
```

---

### Task 1 · 从既有分类析出 `phaseForToolName`（零语义变化）

**Files:** Modify `apps/web/src/components/agent/phaseAggregator.ts:23-37`；Test
`apps/web/src/components/agent/phaseAggregator.test.ts`

**Interfaces:** Consumes `WRITE_TOOLS`, `AgentPhase`（已存在）；Produces
`phaseForToolName(toolName: string): AgentPhase | null`（Task 2 消费）。

- [ ] **Step 1：写失败测试**（追加到既有 describe）

```ts
it('phaseForToolName 与 derivePhase 分类同源（同一份 WRITE_TOOLS）', () => {
  expect(phaseForToolName('get_canvas_summary')).toBeNull()
  expect(phaseForToolName('set_node_text')).toBe('creating')
  expect(phaseForToolName('upsert_media_node')).toBe('creating')
  expect(phaseForToolName('run_image')).toBe('creating')
  expect(phaseForToolName('cancel_generation')).toBe('wrapping')
  expect(phaseForToolName('brand_new_tool')).toBeNull()

  // 等价性：derivePhase 对同一 trace 的结果 = 逐工具 phaseForToolName 的单调推进
  //（注意：不能用 reduce 初始 null 做等价断言 —— read-only 序列 derivePhase 返回
  // 'exploring' 而 reduce 返回 null，是两回事；同源性由「共用同一份 WRITE_TOOLS +
  // 本用例逐名分类断言」保证。）
  const t = createExecutionTrace()
  applyToolCall(t, 'get_canvas_summary', { ok: 1 })
  applyToolCall(t, 'run_image', { ok: 1 })
  applyToolCall(t, 'cancel_generation', { ok: 1 })
  expect(derivePhase(t.steps)).toBe('wrapping')
})
```

同时把 import 改为
`import { derivePhase, phaseForToolName, PHASE_BADGE } from './phaseAggregator'`（不再需要
`type AgentPhase`，等价断言已改为直接分类断言）。

- [ ] **Step 2：确认 RED**

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/phaseAggregator.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL — `phaseForToolName is not a function`。

- [ ] **Step 3：最小实现**（`phaseAggregator.ts`，`derivePhase` 内部改为调用，保持未知工具不推进）

```ts
/** 只判工具名对应的阶段；与 derivePhase 共用同一份 WRITE_TOOLS，禁止另造分类表。 */
export function phaseForToolName(toolName: string): AgentPhase | null {
  if (toolName === 'cancel_generation') return 'wrapping'
  if (WRITE_TOOLS.has(toolName) || toolName.startsWith('run_')) return 'creating'
  return null
}

export function derivePhase(steps: ExecutionStep[]): AgentPhase | null {
  const toolSteps = steps.filter((s) => s.kind === 'tool')
  if (toolSteps.length === 0) return null
  let phase: AgentPhase = 'exploring'
  for (const s of toolSteps) {
    const next = phaseForToolName(s.meta?.toolName ?? '')
    if (next) phase = next
  }
  return phase
}
```

- [ ] **Step 4：确认 GREEN**，命令同 Step 2。Expected: 7/7 PASS。
- [ ] **Step 5：提交**

```bash
git add apps/web/src/components/agent/phaseAggregator.ts \
        apps/web/src/components/agent/phaseAggregator.test.ts
git commit -m "refactor(web): 阶段分类单源析出 phaseForToolName（零语义变化）"
```

---

### Task 2 · 纯派生视图 `turnPhaseView.ts`

**Files:** Create `apps/web/src/components/agent/turnPhaseView.ts`、
`apps/web/src/components/agent/turnPhaseView.test.ts`

**Interfaces:** Consumes `phaseForToolName` / `PHASE_BADGE`（Task 1）、`TimelinePart`、
`AgentTaskProgressState` / `formatTaskProgressLine`、`presentToolStep`、
`formatDuration`、`resolveWaitingFromTimeline`（均既有）；Produces
`deriveTurnPhaseView()` / `isTurnFinalized()`（Task 3 消费）。

- [ ] **Step 1：写失败测试**（完整文件）

```ts
import { describe, expect, it } from 'vitest'
import type { TimelinePart } from './turnTimeline'
import { deriveTurnPhaseView, isTurnFinalized } from './turnPhaseView'

const T = (p: Partial<Extract<TimelinePart, { kind: 'thinking' }>> = {}): TimelinePart => ({
  kind: 'thinking', id: 't1', text: '', status: 'done', startedAt: 100, endedAt: 900, ...p,
})
const Tool = (toolName: string, status = 'done', ms = 800): TimelinePart => ({
  kind: 'tool', id: `k:${toolName}`, toolName, status, ms,
} as TimelinePart)

describe('deriveTurnPhaseView（渲染期派生，零落库）', () => {
  it('空 parts → null（不造阶段）', () => {
    expect(deriveTurnPhaseView([])).toBeNull()
  })

  it('仅 thinking → exploring 进行中，无小结、无耗时', () => {
    const v = deriveTurnPhaseView([T({ status: 'running', endedAt: undefined })])!
    expect(v.stages.map((s) => s.id)).toEqual(['exploring', 'creating', 'wrapping'])
    expect(v.activeIndex).toBe(0)
    expect(v.stages[0]!.status).toBe('running')
    expect(v.stages[0]!.durationLabel).toBeUndefined()
    expect(v.stages[0]!.summary).toBeUndefined()
  })

  it('读工具推进探索、写工具推进创作；前一阶段变 done 且小结只用真实人话', () => {
    const v = deriveTurnPhaseView([
      Tool('get_canvas_summary'), Tool('upsert_media_node'),
    ])!
    expect(v.activeIndex).toBe(1)
    expect(v.stages[0]!.status).toBe('done')
    expect(v.stages[0]!.summary).toContain('感知画布')
    expect(v.stages[0]!.durationLabel).toBe('800ms')
    expect(v.stages[1]!.status).toBe('running')
  })

  it('run_ 前缀与 cancel_generation 与 derivePhase 同分类', () => {
    expect(deriveTurnPhaseView([Tool('run_image')])!.activeIndex).toBe(1)
    expect(deriveTurnPhaseView([Tool('cancel_generation')])!.activeIndex).toBe(2)
  })

  it('等待确认冻结阶段 detail，不自行推进', () => {
    const parts = [
      Tool('get_canvas_summary'),
      { kind: 'proposal', id: 'p1', toolName: 'propose_generation', title: '生成',
        status: 'pending_confirm', startedAt: 1 } as TimelinePart,
    ]
    const v = deriveTurnPhaseView(parts)!
    expect(v.activeIndex).toBe(0)
    expect(v.stages[0]!.detail).toBe('等待你确认（阶段暂不推进）')
  })

  it('taskProgress 的 activeForm 优先成为活跃阶段 detail', () => {
    const v = deriveTurnPhaseView([Tool('upsert_media_node')], {
      items: [{ id: '1', title: '写脚本', activeForm: '正在编写脚本', status: 'running' }],
      finished: false,
    })!
    expect(v.stages[1]!.detail).toContain('正在编写脚本')
  })

  it('耗时字段缺失 ⇒ 不出数字；未知工具不造阶段名', () => {
    const v = deriveTurnPhaseView([
      { kind: 'tool', id: 'k1', toolName: 'brand_new_tool', status: 'done' } as TimelinePart,
      Tool('upsert_media_node'),
    ])!
    expect(v.stages[0]!.durationLabel).toBeUndefined()
    expect(v.stages[0]!.summary).not.toMatch(/undefined|NaN|0\/0/)
    expect(v.stages.map((s) => s.label)).toEqual(['探索中', '创作中', '收尾中'])
  })
})

describe('isTurnFinalized', () => {
  it('只有稳定 id notice:turn-summary 为真', () => {
    expect(isTurnFinalized([])).toBe(false)
    expect(isTurnFinalized([Tool('get_canvas_summary')])).toBe(false)
    expect(isTurnFinalized([
      { kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张', tone: 'info' },
    ])).toBe(true)
  })
})
```

- [ ] **Step 2：确认 RED**（命令同 Task 1，目标 `turnPhaseView.test.ts`），Expected: 模块不存在。
- [ ] **Step 3：最小实现**（完整文件，严格照规格 §5.2 R1–R8）

```ts
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'
import { formatTaskProgressLine } from './agentTaskProgress'
import { formatDuration } from './executionStepLabels'
import { phaseForToolName, PHASE_BADGE, type AgentPhase } from './phaseAggregator'
import { presentToolStep } from './toolPresentation'
import { resolveWaitingFromTimeline } from './turnStatusBar'

const PHASE_ORDER: AgentPhase[] = ['exploring', 'creating', 'wrapping']

export type TurnPhaseStageStatus = 'done' | 'running' | 'pending'

export interface TurnPhaseStage {
  id: AgentPhase
  label: string
  status: TurnPhaseStageStatus
  summary?: string
  durationLabel?: string
  detail?: string
}

export interface TurnPhaseView {
  stages: TurnPhaseStage[]
  activeIndex: number
}

export function isTurnFinalized(parts: TimelinePart[]): boolean {
  return parts.some((p) => p.kind === 'notice' && p.id === 'notice:turn-summary')
}

type ToolPart = Extract<TimelinePart, { kind: 'tool' }>

function toolLabel(p: ToolPart): string {
  return presentToolStep({
    label: p.toolName,
    kind: 'tool',
    status: p.status,
    meta: { toolName: p.toolName, args: p.args },
  }).label
}

function summarizeStage(group: TimelinePart[]): string | undefined {
  const segments: string[] = []
  const labels = [...new Set(group.filter((p): p is ToolPart => p.kind === 'tool').map(toolLabel))]
  if (labels.length) {
    const head = labels.slice(0, 2).join('、')
    segments.push(labels.length > 2 ? `${head} 等 ${labels.length} 步` : head)
  }
  const artifacts = group.filter((p) => p.kind === 'artifact' && p.status === 'done').length
  if (artifacts) segments.push(`生成 ${artifacts} 张`)
  const plan = group.find((p) => p.kind === 'plan')
  if (plan?.kind === 'plan') segments.push(`方案已提出（${plan.steps.length} 步）`)
  if (!segments.length && group.some((p) => p.kind === 'thinking')) segments.push('思考完成')
  return segments.length ? segments.join('、') : undefined
}

function stageDuration(group: TimelinePart[]): string | undefined {
  if (!group.length) return undefined
  let ms = 0
  for (const p of group) {
    if (p.kind === 'tool') {
      if (typeof p.ms !== 'number') return undefined
      ms += p.ms
    } else if (p.kind === 'thinking') {
      if (p.endedAt == null) return undefined
      ms += p.endedAt - p.startedAt
    }
  }
  return formatDuration(ms)
}

function activeDetail(
  parts: TimelinePart[],
  taskProgress: AgentTaskProgressState | null | undefined,
  group: TimelinePart[],
): string | undefined {
  if (resolveWaitingFromTimeline(parts)) return '等待你确认（阶段暂不推进）'
  if (taskProgress && !taskProgress.finished) {
    return formatTaskProgressLine(taskProgress.items) ?? undefined
  }
  const plan = [...group].reverse().find((p) => p.kind === 'plan')
  if (plan?.kind === 'plan') {
    const activeForm = plan.steps.find((s) => s.activeForm)?.activeForm
    if (activeForm) return `正在：${activeForm}`
  }
  const running = [...group].reverse().find(
    (p): p is ToolPart => p.kind === 'tool' && p.status === 'running',
  )
  return running ? `正在：${toolLabel(running)}` : undefined
}

export function deriveTurnPhaseView(
  parts: TimelinePart[],
  taskProgress?: AgentTaskProgressState | null,
): TurnPhaseView | null {
  if (!parts.length) return null
  let active: AgentPhase = 'exploring'
  const buckets: Record<AgentPhase, TimelinePart[]> = {
    exploring: [], creating: [], wrapping: [],
  }
  for (const p of parts) {
    const next = p.kind === 'tool' ? phaseForToolName(p.toolName) : null
    if (next) active = next
    buckets[active].push(p)
  }
  const activeIndex = PHASE_ORDER.indexOf(active)
  const stages: TurnPhaseStage[] = PHASE_ORDER.map((id, index) => {
    const group = buckets[id]
    const status: TurnPhaseStageStatus =
      index < activeIndex ? 'done' : index === activeIndex ? 'running' : 'pending'
    return {
      id,
      label: PHASE_BADGE[id].label,
      status,
      ...(status === 'done'
        ? { summary: summarizeStage(group), durationLabel: stageDuration(group) }
        : {}),
      ...(status === 'running' ? { detail: activeDetail(parts, taskProgress, group) } : {}),
    }
  })
  return { stages, activeIndex }
}
```

- [ ] **Step 4：确认 GREEN**（命令同 Step 2），Expected: 8/8 PASS。
- [ ] **Step 5：变异自检**

```bash
# 把 stageDuration 的 `return undefined` 全改成 `return formatDuration(0)` ⇒ 「耗时字段缺失」用例必须 RED；还原
# 把 activeDetail 里 taskProgress 分支删掉 ⇒ activeForm 用例必须 RED；还原
```
- [ ] **Step 6：提交**

```bash
git add apps/web/src/components/agent/turnPhaseView.ts \
        apps/web/src/components/agent/turnPhaseView.test.ts
git commit -m "feat(web): Turn 阶段视图纯派生（临时小结、收口即消失）"
```

---

### Task 3 · `AgentTurnTimeline` 内联阶段条

**Files:** Modify `apps/web/src/components/agent/AgentTurnTimeline.vue`（脚本 props 区约 `:20-70`、
模板根 `:438` 之前）；Create `apps/web/src/components/agent/AgentTurnTimeline.phaseStrip.test.ts`

**Interfaces:** Consumes `deriveTurnPhaseView` / `isTurnFinalized`（Task 2）、
`AgentTaskProgressState`（Task 4 以 prop 传入）；Produces DOM `data-testid="turn-phase-strip"`。

- [ ] **Step 1：写失败测试**（完整文件，mount 形态照 `AgentTurnTimeline.plan.test.ts:33-67`）

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

const parts: TimelinePart[] = [
  { kind: 'tool', id: 'k1', toolName: 'get_canvas_summary', status: 'done', ms: 800 },
  { kind: 'tool', id: 'k2', toolName: 'upsert_media_node', status: 'running' },
]
const mountStrip = (streaming: boolean, ps: TimelinePart[] = parts) =>
  mount(AgentTurnTimeline, { props: { parts: ps, streaming, canvasNodes: [] } })

describe('AgentTurnTimeline — 临时阶段条', () => {
  it('streaming=true 才渲染，三阶段顺序 + 格式（「状态」· status）', () => {
    const w = mountStrip(true)
    const strip = w.find('[data-testid="turn-phase-strip"]')
    expect(strip.exists()).toBe(true)
    const rows = strip.findAll('.turn-phase-strip__row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('「探索中」')
    expect(rows[0]!.text()).toContain('已完成')
    expect(rows[0]!.text()).toContain('小结：')
    expect(rows[1]!.text()).toContain('「创作中」')
    expect(rows[1]!.text()).toContain('进行中')
    expect(rows[2]!.text()).toContain('待开始')
    expect(w.text()).not.toContain('0/0')
  })

  it('streaming=false（历史轮）整块消失，既有摘要 notice 仍在', () => {
    const withSummary = [
      ...parts,
      { kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张 · 用时 2s', tone: 'info' },
    ] as TimelinePart[]
    const w = mountStrip(false, withSummary)
    expect(w.find('[data-testid="turn-phase-strip"]').exists()).toBe(false)
    expect(w.text()).toContain('已生成 1 张')
  })

  it('taskProgress 传入时 detail 出现在活跃阶段；不传不造数', () => {
    const withProp = mount(AgentTurnTimeline, {
      props: {
        parts, streaming: true, canvasNodes: [],
        taskProgress: {
          items: [{ id: '1', title: '写脚本', activeForm: '正在编写脚本', status: 'running' }],
          finished: false,
        },
      },
    })
    expect(withProp.find('[data-testid="turn-phase-strip"]').text()).toContain('正在编写脚本')
    expect(mountStrip(true).find('[data-testid="turn-phase-strip"]').text()).not.toContain('正在编写脚本')
  })

  it('阶段条只用 --lnk-* 令牌，不含 --neo-* / --lnk-hi-*', () => {
    const css = wStyle()
    expect(css).toMatch(/--lnk-accent-subtle|--lnk-text-secondary/)
    expect(css).not.toMatch(/--neo-|--lnk-hi-bg|--lnk-hi-text/)
  })
})

function wStyle() {
  // 源码契约：样式块内令牌白名单（组件 DS 大，不做渲染态计算）
  const src = readFileSync(resolve(__dirname, 'AgentTurnTimeline.vue'), 'utf8')
  return src.slice(src.indexOf('.turn-phase-strip'), src.indexOf('</style>'))
}
```

- [ ] **Step 2：确认 RED**（vitest 目标 `AgentTurnTimeline.phaseStrip.test.ts`）。
- [ ] **Step 3：实现脚本侧**（在 `defineProps` 追加可选 prop，新增 computed）

```ts
import type { AgentTaskProgressState } from './agentTaskProgress'
import { deriveTurnPhaseView, isTurnFinalized } from './turnPhaseView'

// ⛔ 不引入 withDefaults —— 既有组件是裸 defineProps<{...}>()（:38-60，10 个 props），
// 换 withDefaults 等于重声明全部 props、无意义 diff。只往类型里追加一个可选 prop：
// deriveTurnPhaseView 第二参已接受 undefined，无需默认值。
const props = defineProps<{
  // ...既有 props 全部保留，不改动
  taskProgress?: AgentTaskProgressState | null
}>()

const phaseView = computed(() => deriveTurnPhaseView(props.parts, props.taskProgress))
const stripVisible = computed(
  () => Boolean(props.streaming && phaseView.value && !isTurnFinalized(props.parts)),
)
const PHASE_STATUS_LABEL: Record<string, string> = {
  done: '已完成', running: '进行中', pending: '待开始',
}
```

- [ ] **Step 4：实现模板**（`AgentTurnTimeline.vue:438` 的 `<div v-if="hasContent">` 内、
      `<template v-for="part in parts">` **之前**插入，不改动任何 part 分支顺序）

```vue
<div v-if="stripVisible" class="turn-phase-strip" data-testid="turn-phase-strip">
  <div
    v-for="(stage, idx) in phaseView!.stages"
    :key="stage.id"
    class="turn-phase-strip__row"
    :class="`is-${stage.status}`"
  >
    <span class="turn-phase-strip__index">{{ ['①', '②', '③'][idx] }}</span>
    <span
      class="turn-phase-strip__label"
      :aria-live="stage.status === 'running' ? 'polite' : undefined"
    >「{{ stage.label }}」</span>
    <span class="turn-phase-strip__status">· {{ PHASE_STATUS_LABEL[stage.status] }}</span>
    <span v-if="stage.detail" class="turn-phase-strip__detail">· {{ stage.detail }}</span>
    <span v-if="stage.summary" class="turn-phase-strip__summary">
      小结：{{ stage.summary }}<template v-if="stage.durationLabel">（{{ stage.durationLabel }}）</template>
    </span>
  </div>
</div>
```

- [ ] **Step 5：实现样式**（组件 `<style scoped>` 内追加；令牌白名单见 Global Constraints）

```css
.turn-phase-strip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid var(--lnk-border-default);
  border-radius: 8px;
  background: var(--lnk-surface-raised);
}
.turn-phase-strip__row { display: flex; flex-wrap: wrap; gap: 4px; color: var(--lnk-text-muted); }
.turn-phase-strip__row.is-running {
  color: var(--lnk-accent-text);
  background: var(--lnk-accent-subtle);
  border-radius: 4px;
  padding: 1px 4px;
}
.turn-phase-strip__row.is-done { color: var(--lnk-text-secondary); }
.turn-phase-strip__index { opacity: 0.7; }
```

- [ ] **Step 6：确认 GREEN**（同 Step 2），并跑令牌守卫：

```bash
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/styles/design-token.test.ts --maxWorkers=1 --no-file-parallelism
```
- [ ] **Step 7：提交**

```bash
git add apps/web/src/components/agent/AgentTurnTimeline.vue \
        apps/web/src/components/agent/AgentTurnTimeline.phaseStrip.test.ts
git commit -m "feat(web): 对话流内联临时阶段条（收口即消失）"
```

---

### Task 4 · 接线、守卫与不回退验证

**Files:** Modify `apps/web/src/components/agent/AgentSideRail.vue:3629-3645`（1 行 prop）与
`apps/web/src/components/agent/AgentSideRail.mobileLivePin.test.ts`（追加）；Create
`apps/web/src/components/agent/AgentSideRail.phaseStripWiring.test.ts`

**Interfaces:** Consumes `taskProgress` ref（`:540`）、`isLiveTurnMessage()`（`:555-558`）；
Produces 最新活跃轮 timeline 的 `taskProgress` prop。

- [ ] **Step 1：写接线失败测试**（完整文件；复用 `AgentSideRail.turnLiveStatus.test.ts:18-43`
      的 mock 与 `mountRail()` 形态）

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AgentSideRail from './AgentSideRail.vue'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import { useAgentStore } from '@/stores/agent'

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue({ messages: [] }) },
}))
vi.mock('@/services/api-base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api-base')>()), apiUrl: (p: string) => p,
}))
vi.mock('@/services/provider-api', () => ({
  providerApi: { bootstrap: vi.fn().mockResolvedValue({
    platformChannel: null, channels: [], preferences: null, webdav: null,
  }) },
}))
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '' }) } }))

describe('阶段条接线：只挂最新活跃轮，灰字不回退', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('最新 streaming 轮拿到 taskProgress，历史轮为 undefined', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {},
    }))
    const router = createRouter({ history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }] })
    await router.push('/'); await router.isReady()
    const w = mount(AgentSideRail, { global: { plugins: [router] }, props: { sessionId: 's1' } })
    await flushPromises()
    const agent = useAgentStore()
    agent.messages.push({ id: 'm-old', role: 'assistant', content: '', streaming: false,
      timeline: { turnStartedAt: 1, parts: [
        { kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张', tone: 'info' },
      ] } } as never)
    agent.messages.push({ id: 'm-live', role: 'assistant', content: '', streaming: true,
      timeline: { turnStartedAt: 2, parts: [
        { kind: 'tool', id: 'k1', toolName: 'get_canvas_summary', status: 'done', ms: 800 },
      ] } } as never)
    await flushPromises()

    const timelines = w.findAllComponents(AgentTurnTimeline)
    expect(timelines).toHaveLength(2)
    expect(timelines[0]!.props('taskProgress')).toBeUndefined()
    expect(timelines[1]!.props('taskProgress')).toBeDefined()
    expect(w.findAll('[data-testid="turn-phase-strip"]')).toHaveLength(1)
  })
})
```

- [ ] **Step 2：确认 RED**（vitest 目标 `AgentSideRail.phaseStripWiring.test.ts`）。
- [ ] **Step 3：最小接线**（`AgentSideRail.vue:3629-3645`，只加 1 行）

```vue
:task-progress="isLiveTurnMessage(msg) ? taskProgress : undefined"
```

- [ ] **Step 4：追加反向守卫**（`AgentSideRail.mobileLivePin.test.ts` 末尾新 `it`）

```ts
it('⑤ 阶段条不得变成播报式状态行：无 ticker / 无新 notice / 无钉底', () => {
  const view = stripComments(readFileSync(resolve(__dirname, 'turnPhaseView.ts'), 'utf8'))
  expect(view, '禁止秒表时钟').not.toMatch(/Date\.now|setInterval/)
  expect(view, '禁止复活 turnStatusLine').not.toMatch(/turnStatusLine/)
  const timeline = stripComments(readFileSync(resolve(__dirname, 'turnTimeline.ts'), 'utf8'))
  expect(timeline, '禁止把阶段小结写成持久 notice').not.toMatch(/notice:phase-/)
  expect(rail, 'composer 灰字必须仍在').toMatch(/turnLiveStatus/)
  expect(rail, '内联时间线通道必须仍在').toMatch(/v-if="useTimeline\(msg\)"/)
})
```

- [ ] **Step 5：确认全组 GREEN**（三个文件按序跑，勿并行）

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/phaseAggregator.test.ts \
  src/components/agent/turnPhaseView.test.ts \
  src/components/agent/AgentTurnTimeline.phaseStrip.test.ts \
  src/components/agent/AgentSideRail.phaseStripWiring.test.ts \
  src/components/agent/AgentSideRail.mobileLivePin.test.ts \
  src/components/agent/AgentSideRail.turnLiveStatus.test.ts \
  --maxWorkers=1 --no-file-parallelism
```
- [ ] **Step 6：类型检查**

```bash
cd apps/web && env -u NODE_OPTIONS pnpm exec vue-tsc -b   # ⛔ 不加 --noEmit
```
- [ ] **Step 7：提交**

```bash
git add apps/web/src/components/agent/AgentSideRail.vue \
        apps/web/src/components/agent/AgentSideRail.mobileLivePin.test.ts \
        apps/web/src/components/agent/AgentSideRail.phaseStripWiring.test.ts
git commit -m "fix(web): 阶段条只接最新活跃轮 + 反向守卫"
```

---

### Task 5 · PR / CI / web-only 部署 / 生产复测 / 收尾

- [ ] **Step 1：推分支开 PR**（本机 git push 502 时走 `gh api` REST；blob 正文用 `-F content=@file`）

```bash
export PATH="/usr/local/bin:$PATH"
git push -u origin feat/turn-phase-progress-20261122
gh pr create --base master --head feat/turn-phase-progress-20261122 \
  --title "feat(web): Turn 内阶段性状态与临时阶段小结（完成即消失）" \
  --body "对应 spec: docs/superpowers/specs/2026-11-22-turn-phase-progress-design.md；零新增事件/字段/DB，只 web-only 部署"
```
- [ ] **Step 2：盯 CI 全绿**（`gh pr checks <n>`；下钻 `Build monorepo` 的 `pnpm test` step 日志）
- [ ] **Step 3：squash 合并**，逐路径 KEPT 核验（合并树 == CI 验证 head 树）
- [ ] **Step 4：web-only 部署**（push 触发自动分流；补派必须带 `deploy_web_only=true`）
      判据=产物 chunk 含 `turn-phase-strip`
- [ ] **Step 5：生产 CDP 五态走查**（一次性探针放本地 `.workbuddy/e2e-cdp/`，不入库）
      按规格 §9.3：发消息 → 首 part → 工具 → 等待确认 → 收口；附加「上滑回看灰字仍可见」
- [ ] **Step 6：收尾**：`git worktree remove` → 删本地/远程分支 → 追加工作日志到
      `.workbuddy/memory/2026-11-22.md`（只记录已闭环事实，不提前宣告 ALL_PASS）

## 5. 环境判据（本机）

- vitest：nvm node24 + `--maxWorkers=1 --no-file-parallelism`；本机 4 核慢 ≠ 回归，以 CI 为准。
- worktree 依赖软链跨目录解析慢；本地定向测试按「小步提交 → 单文件 → 类型检查」顺序，勿并行跑两套全量。
- `vue-tsc -b` 勿加 `--noEmit`；pnpm 须 `env -u NODE_OPTIONS`。
- `git push` 502 ⇒ `gh api` REST 推 PR：blob（`-F content=@file`）→ tree（`base_tree` 只传改动路径）→
  commit → ref → PR；`--jq` 重定向会多一个尾随换行，正文回读长度。
- 合并最强证据 = 合并树 == CI 验证 head 树；docs 分支与 impl 分支分开，避免文档改动混进代码 PR。
- 生产 CDP：headless + 单会话内设置触摸仿真；判据是真 DOM 计数，不是源码字符串。

## 6. 风险与回滚

- **阶段条变回播报式状态行**：Task 4 守卫转 RED ⇒ 立即停，回退 Task 3 模板。
- **等待态阶段误推进**：Task 2 等待用例转 RED ⇒ 回退到 `resolveWaitingFromTimeline` 分支之前。
- **token/对比度不过**：用 `--lnk-accent-subtle/accent-text`，不用 `--lnk-hi-*`；设计令牌测试转 RED 则改样式不改令牌。
- **回滚**：纯前端、无 DB/事件/migration ⇒ revert 单个 squash commit + web-only 重部署；
  历史轮天然没有阶段条残留，无需数据清理。

## 7. 完成定义

规格 §9 全部满足（单测 + 变异 + 守卫 + 类型 + CI + 生产 CDP），且**生产复测完成前不宣告 ALL_PASS**。

## 8. 计划自审（写完即查）

- **规格覆盖**：G1→Task 2/3；G2→Task 2 R4/R5/R6；G3→Task 3 生命周期 + Task 4 守卫；
  G4→Task 1/2 + Task 4 灰字保持；G5→Task 3 同组件无媒体查询。无遗漏。
- **占位符扫描**：无 `TBD` / `TODO` / `implement later` / "similar to Task N"；每个代码步骤含完整片段。
- **类型一致性**：`phaseForToolName` → `deriveTurnPhaseView` → `phaseView` → `stage.*` 名称
  在 Task 1/2/3 中逐字一致；`taskProgress` prop 名在 Task 3/4 中一致。
- **Review Focus**：§2 五条均落到 Task 2/3/4 的具体用例；无空项。

## 9. 开工前审核结论（2026-11-22，评审人=主会话）

逐行复核基线 2b98f446 后修正 3 处（已回写本文档）：

1. **Task 1 测试判据错误**：`reduce` 等价断言对 read-only 工具序列误判
   （`derivePhase` 返回 `'exploring'`，`reduce` 初始 `null` 返回 `null`）→ 改为逐名分类
   断言 + 尾态直接断言（§4 Task 1 Step 1 已改）。
2. **Task 3 契约不符**：`withDefaults` 需重声明全部 10 个既有 props，而组件是裸
   `defineProps<{...}>()`（`AgentTurnTimeline.vue:38-60`）→ 改为类型内追加可选 prop。
3. **spec R5 漏 thinking 素材**：实现对 thinking-only 的 done 阶段给 `思考完成`
   （真实素材非造数），R5 原文未列 → spec 已补。

接线契约确认无误：`taskProgress` ref `:540`（`emptyTaskProgress()`，永非 null）、
`isLiveTurnMessage` `:555-559`（含 `showTaskCard` 分支 ⇒ 挂起回合仍算活跃）、
`AgentTurnTimeline` 接线点 `:3629-3645`、`useTimeline` = `role==='assistant' &&
Boolean(msg.timeline)`（`agentMessageRender.ts:150-152`）、wiring 测试 mocks 与
`AgentSideRail.turnLiveStatus.test.ts:18-43/107-126` 逐字同形、`stripComments` 助手在
`agentSingleScrollOwner.test`（mobileLivePin 已 import）。

**执行模式裁决：Native（主会话逐刀 TDD），不用 SDD 子代理。**理由：6 刀强顺序耦合
（Task1 输出即 Task2 输入，Task2/3 共享类型契约），且契约细节已在本会话逐行核实——
子代理交接需重读 spec 并重建同等上下文，漂移风险大于并行收益；SDD 适用于可并行、
互不依赖的 task 集，本计划不满足。
