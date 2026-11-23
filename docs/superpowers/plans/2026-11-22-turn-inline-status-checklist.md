# 单一当前态 + 流内折叠任务清单（B 形态）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: `executing-plans`（推荐）或 `subagent-driven-development` 逐 task 实施。步骤用 `- [ ]` 跟踪。
>
> **Goal:** 用一次替换刀移除旧三阶段条，改为**流尾**唯一当前态（零 parts 时仍在原轮首位）+ **轮首**流内折叠 checklist + 小结归位；用户 6 点反馈逐条闭环。
>
> **2026-11-23 二次拍板修订**：当前态落点从「轮首」改为「parts 循环之后」；清单留在轮首不跟随；其余设计不变。
>
> **Architecture:** 新增 1 个纯派生模块 `turnChecklistView.ts`（清单投影 + 收口判定迁入），
> `AgentTurnTimeline` 删三阶段 strip 后在 parts 循环之后渲染流尾当前态行（`turnLiveStatus` 单源；零 parts 时仍在消息气泡下方），轮首渲染
> `<details>` checklist（`taskProgress.items` 单源，收口折叠留凭据）；composer 灰字渲染与钉底任务卡删除。
>
> **Tech Stack:** Vue 3 `<script setup>` + TypeScript + vitest；仅 `apps/web` 改动，web-only 部署。
>
> **Spec:** [`../specs/2026-11-22-turn-inline-status-checklist-design.md`](../specs/2026-11-22-turn-inline-status-checklist-design.md)

## 0. 第一原则

吃满上游、不重复造轮子。等价物检索结论见规格 §0。本计划**零新增数据字段、零 SSE 事件、
零 DB migration、零新令牌、零新增 part kind**；唯一新增代码是一个纯派生模块与一段组件模板。
实施中出现「新造状态词 / 新造小结字段 / 阶段持久化到 parts」一律驳回。

## 1. Global Constraints（逐字取自规格）

- 流尾当前态恰好 1 条（零 parts 时仍在消息气泡下方原位），文本＝`turnLiveStatus(parts)`；三阶段词与 ①②③ 全仓 0 次。
- item 状态词与 `AgentTaskProgressCard.vue:15-23` 逐字一致；done 计数只算 done/skipped；空任务整块不渲染。
- 当前态行收口双门禁：`props.streaming === true` **且** `!isTurnFinalized(parts)`（稳定 id `notice:turn-summary`）。
- checklist **不受 streaming 门禁**：收口后折叠留凭据（Codex 范式 / UI 对比图 B）；默认折叠
  （`useDisclosure(() => false)`，对齐 Codex `compact_hyperlink_lines` 摘要行带 `a/b` 计数）；
  展开逐项按 InProgress→Pending→Completed 排序，完成态＝**打钩 ✓ + 删除线(line-through) + muted**、
  进行中＝accent `□`、等待＝暗 `□`（Codex TUI `plans.rs:290-292/329-331` 一手，字形/排序单源在
  `turnChecklistView.ts`）；不 Teleport、不钉底、不进 composer 系统层。
- composer 灰字渲染删除，但 `turnLiveStatus()` 函数保留（当前态行单源）。
- 推理摘要＝`thinking.text`（原位折叠块）；工具结果＝`tool.resultSummary`（原位 details）；
  下一步＝模型正文；出错＝error notice 重试入口。**对话流不拼任何小结**。
- 不复活 `turnStatusLine` / `statusTicker` / `settledDismissed` / 钉底镜像 / `describeActivityFromTimeline`。
- 令牌只用 `--lnk-*`，禁 `--lnk-hi-bg/hi-text` 表状态、禁新增 hex / `rgba(` / `--neo-*`。
- 移动端 / PC 同组件同形态；服务端 / pi-runtime / prompt-registry / DB 零改动。

## 2. Review Focus（规格暗示但测试最容易漏的 5 类输入）

1. **空任务与收口瞬间** —— 空 `taskProgress.items` 时 checklist 不渲染（无 0/0 空壳）；
   `streaming=false` 或 summary notice 到达后**当前态 0 条、checklist 折叠仍在**，summary notice 仍在。
2. **用户意图 vs 默认值** —— checklist 点开后任务继续更新，patch 不得把它弹回收起（照 thinking disclosure 契约）。
3. **清单与叙事不重复** —— 同一句工具人话不得同时出现在 checklist 与流尾状态行；
   thinking summary / tool resultSummary 仍在各自原位，不因删除旧 strip 而丢失。
4. **守卫退化** —— 删 `turnPhaseView` 后 `AgentSideRail.mobileLivePin.test.ts` 的 `turnLiveStatus`
   函数级要求仍成立；composer 灰字**渲染 0 次**；内联通道 `useTimeline(msg)` 仍在。
5. **CI 棘轮** —— 新增注释里不得出现受看守 token 字面量；`design-token.test.ts` 不因新样式上升。

## 3. 文件地图

| 文件 | 责任 |
|---|---|
| `apps/web/src/components/agent/turnChecklistView.ts`（新） | 清单纯投影 + `isTurnFinalized` 迁入 |
| `apps/web/src/components/agent/turnChecklistView.test.ts`（新） | 纯函数判据 + 禁造数 |
| `apps/web/src/components/agent/turnPhaseView.ts` / `.test.ts` | **删除**（三阶段视图退役） |
| `apps/web/src/components/agent/AgentTurnTimeline.vue` | 删 strip；加流尾当前态 + 轮首 checklist 模板/样式；`taskProgress` prop 保留 |
| `apps/web/src/components/agent/AgentTurnTimeline.turnState.test.ts`（新） | mount 生命周期与文案判据 |
| `apps/web/src/components/agent/AgentSideRail.vue` | 删 composer 任务卡与灰字渲染；保留 `:task-progress` 接线与 `turnLiveStatus()` 函数 |
| `apps/web/src/components/agent/AgentSideRail.turnChecklistWiring.test.ts`（新） | 活跃轮/历史轮接线、composer 无卡无灰字 |
| `apps/web/src/components/agent/AgentSideRail.mobileLivePin.test.ts` | 追加反向守卫 |
| `apps/web/src/components/agent/phaseAggregator.ts` | 零改动（`phaseForToolName` 保留给 `AgentExecutionTrace`） |
| `docs/.../specs/2026-11-22-turn-phase-progress-design.md` | 顶部标 `SUPERSEDED` 并指向本规格 |
| `docs/.../plans/2026-11-22-turn-phase-progress.md` | 顶部标 `SUPERSEDED` |
| `docs/README.md` + `scripts/docs/index_data.json` + `docs/superpowers/INDEX.md` | 文档登记与索引重生成 |

---

## 4. 任务分解

### Task 0 · 基线核对（本计划已执行，实施者只核对）

- [ ] **Step 1：核对基线**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/turn-phase-b-20261122
git log -1 --oneline origin/master        # 期望 004ffa2d 或更新同族
git branch --show-current                  # feat/turn-phase-b-20261122
git status --short                         # 工作区应干净
```

- [ ] **Step 2：依赖借用**（沙箱禁 symlink 安装时；见 branch-first-dev-workflow skill）

```bash
MAIN=/Users/4seven/workspace/pi-lnk
WT=$MAIN/.worktrees/turn-phase-b-20261122
test -d "$WT/node_modules" || ln -s $MAIN/node_modules "$WT/node_modules"
mkdir -p "$WT/apps/web/node_modules"
# 主仓条目逐条绝对软链；@lnkpi/{shared,agent} 指本 worktree 自己的 packages（见长期备忘铁律）
```

- [ ] **Step 3：旧文档标废 + 新文档登记**

在两份旧文档顶部插入：
```
> ⛔ SUPERSEDED（2026-11-22）：本方案被 `2026-11-22-turn-inline-status-checklist-design.md` 取代，
>   用户生产复测否定三阶段并列/序号/UI 拼小结/钉底任务卡。保留仅供决策轨迹追溯。
```
`docs/README.md` / `scripts/docs/index_data.json` / `docs/superpowers/INDEX.md` 登记新 spec+plan。

- [ ] **Step 4：提交**

```bash
git add docs/
git commit -m "docs(agent): 单一当前态与流内折叠清单立项规格+计划（取代三阶段方案）"
```

---

### Task 1 · 纯派生模块 `turnChecklistView.ts`

**Files:** Create `apps/web/src/components/agent/turnChecklistView.ts`、`.test.ts`
**Interfaces:** Consumes `AgentTaskProgressState.items`（既有）、`TimelinePart`（既有）；
Produces `deriveTurnChecklistView()` / `isTurnFinalized()`（Task 2 消费）。

- [ ] **Step 1：写失败测试**（完整文件）

```ts
import { describe, expect, it } from 'vitest'
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'
import { deriveTurnChecklistView, isTurnFinalized } from './turnChecklistView'

const P = (over: Partial<AgentTaskProgressState> = {}): AgentTaskProgressState => ({
  items: [], finished: false, ...over,
} as AgentTaskProgressState)

describe('deriveTurnChecklistView', () => {
  it('items 空 / null → null（不留 0/0 空壳）', () => {
    expect(deriveTurnChecklistView(null)).toBeNull()
    expect(deriveTurnChecklistView(P())).toBeNull()
  })

  it('状态词与 AgentTaskProgressCard 逐字一致，字段原样保留', () => {
    const v = deriveTurnChecklistView(P({ items: [
      { id: '1', title: '写脚本', activeForm: '正在写脚本', status: 'running' },
      { id: '2', title: '生成分镜', status: 'done', nodeId: 'node-2' },
      { id: '3', title: '导出', status: 'skipped', errorHint: '无需导出' },
      { id: '4', title: '重试', status: 'failed' },
    ] } as AgentTaskProgressState))!
    expect(v.items.map((i) => i.statusLabel)).toEqual(['进行中', '完成', '已跳过', '失败'])
    expect(v.items[1]!.nodeId).toBe('node-2')
    expect(v.items[2]!.errorHint).toBe('无需导出')
  })

  it('done 计数只算 done/skipped', () => {
    const v = deriveTurnChecklistView(P({ items: [
      { id: '1', status: 'running', title: 'a' },
      { id: '2', status: 'done', title: 'b' },
      { id: '3', status: 'skipped', title: 'c' },
      { id: '4', status: 'failed', title: 'd' },
      { id: '5', status: 'needs_user', title: 'e' },
    ] } as AgentTaskProgressState))!
    expect(v.doneCount).toBe(2)
    expect(v.total).toBe(5)
  })
})

describe('isTurnFinalized（从旧模块迁入，判据不变）', () => {
  it('只认稳定 id notice:turn-summary', () => {
    expect(isTurnFinalized([])).toBe(false)
    expect(isTurnFinalized([{ kind: 'text', id: 'x', text: 'a', status: 'done' }])).toBe(false)
    expect(isTurnFinalized([{ kind: 'notice', id: 'notice:turn-summary', text: 'x' } as TimelinePart])).toBe(true)
  })
})
```

- [ ] **Step 2：确认 RED**

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/turnChecklistView.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL — 模块不存在。

- [ ] **Step 3：最小实现**

```ts
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中', running: '进行中', retrying: '重试中', done: '完成',
  failed: '失败', needs_user: '需你处理', skipped: '已跳过',
}

export interface TurnChecklistItem {
  id: string
  title: string
  statusLabel: string
  activeForm?: string
  nodeId?: string
  errorHint?: string
  done: boolean
}

export interface TurnChecklistView {
  items: TurnChecklistItem[]
  doneCount: number
  total: number
}

export function isTurnFinalized(parts: TimelinePart[]): boolean {
  return parts.some((p) => p.kind === 'notice' && p.id === 'notice:turn-summary')
}

export function deriveTurnChecklistView(
  progress: AgentTaskProgressState | null | undefined,
): TurnChecklistView | null {
  const items = progress?.items ?? []
  if (!items.length) return null
  const view = items.map((it) => ({
    id: it.id,
    title: it.title,
    statusLabel: STATUS_LABEL[it.status] ?? it.status,
    ...(it.activeForm ? { activeForm: it.activeForm } : {}),
    ...(it.nodeId ? { nodeId: it.nodeId } : {}),
    ...(it.errorHint ? { errorHint: it.errorHint } : {}),
    done: it.status === 'done' || it.status === 'skipped',
  }))
  return { items: view, doneCount: view.filter((i) => i.done).length, total: view.length }
}
```

⚠️ `STATUS_LABEL` 必须与 `AgentTaskProgressCard.vue:15-23` 逐字一致；
若后续该文件改动，两处同步（本刀内可考虑抽出共享常量文件，但会扩大影响面——默认不抽，用测试锁死一致性）。

- [ ] **Step 4：确认 GREEN**，命令同 Step 2。Expected: 3/3 + 2/2 PASS。
- [ ] **Step 5：fs-scan 守卫测试**（追加到同文件）

```ts
import { readFileSync } from 'node:fs'
it('纯派生不得引计时/阶段分类/写操作', () => {
  const src = readFileSync(new URL('./turnChecklistView.ts', import.meta.url), 'utf8')
  expect(src).not.toMatch(/Date\.now|setInterval|turnStatusLine|phaseForToolName|\.push\(/)
})
```

- [ ] **Step 6：提交**

```bash
git add apps/web/src/components/agent/turnChecklistView.ts apps/web/src/components/agent/turnChecklistView.test.ts
git commit -m "feat(web): 清单纯派生与收口判定模块（B 形态）"
```

---

### Task 2 · AgentTurnTimeline 替换三阶段条

**Files:** Modify `AgentTurnTimeline.vue`；Create `AgentTurnTimeline.turnState.test.ts`
**Interfaces:** Consumes `turnLiveStatus()`（Task 2a）、`deriveTurnChecklistView()` / `isTurnFinalized()`（Task 1）、
`useDisclosure()`（既有）；Produces 流尾当前态行 + 轮首折叠 checklist。

- [ ] **Step 1：写失败测试**（完整文件，仿 `AgentTurnTimeline.plan.test.ts` mount 模式）

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'

const mountTurn = (parts: TimelinePart[], streaming = true, progress?: AgentTaskProgressState) =>
  mount(AgentTurnTimeline, { props: { parts, streaming, taskProgress: progress } })

const thinking = (id = 't1'): TimelinePart => ({
  kind: 'thinking', id, text: '思考摘要原文', status: 'running', startedAt: 1,
})

describe('流尾当前态（B 形态）', () => {
  it('活跃轮恰好 1 条，文本取 turnLiveStatus', () => {
    const w = mountTurn([thinking()])
    const rows = w.findAll('[data-testid="turn-current-state"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('深度思考中')
  })

  it('streaming=false 或收口后 0 条', () => {
    expect(mountTurn([thinking()], false).findAll('[data-testid="turn-current-state"]')).toHaveLength(0)
    const final = [{ kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张' } as TimelinePart]
    expect(mountTurn(final, true).findAll('[data-testid="turn-current-state"]')).toHaveLength(0)
  })

  it('旧三阶段词 / 序号 / UI 拼小结不出现', () => {
    const html = mountTurn([thinking()]).html()
    for (const banned of ['探索中', '创作中', '收尾中', '①', '②', '③', '小结：']) {
      expect(html).not.toContain(banned)
    }
  })

  it('推理摘要仍在 thinking 原位；工具结果仍在 tool 原位', () => {
    const parts: TimelinePart[] = [
      { kind: 'thinking', id: 't1', text: '真实推理摘要', status: 'done', startedAt: 1, endedAt: 2 },
      { kind: 'tool', id: 'k1', toolName: 'get_canvas_summary', status: 'done',
        resultSummary: '画布为空' } as TimelinePart,
    ]
    const html = mountTurn(parts).html()
    expect(html).toContain('真实推理摘要')
    expect(html).toContain('画布为空')
  })
})

describe('流内折叠 checklist', () => {
  const progress = {
    items: [
      { id: '1', title: '写脚本', activeForm: '正在写脚本', status: 'running' },
      { id: '2', title: '生成分镜', status: 'done' },
    ],
    finished: false,
  } as AgentTaskProgressState

  it('活跃轮有清单、默认折叠；空任务 0 块', () => {
    const w = mountTurn([thinking()], true, progress)
    const list = w.find('[data-testid="turn-task-checklist"]')
    expect(list.exists()).toBe(true)
    expect(list.attributes('open')).toBeUndefined()
    expect(list.text()).toContain('任务 1/2')
    expect(mountTurn([thinking()], true).findAll('[data-testid="turn-task-checklist"]')).toHaveLength(0)
  })

  it('展开后逐项显示状态词与 activeForm', async () => {
    const w = mountTurn([thinking()], true, progress)
    await w.find('[data-testid="turn-task-checklist"] summary').trigger('click')
    const text = w.find('[data-testid="turn-task-checklist"]').text()
    expect(text).toContain('进行中')
    expect(text).toContain('正在写脚本')
    expect(text).toContain('完成')
  })

  it('完成态＝打钩 ✓ + 删除线；进行中排序置顶（Codex 一手）', async () => {
    const w = mountTurn([thinking()], true, progress)
    await w.find('[data-testid="turn-task-checklist"] summary').trigger('click')
    const rows = w.findAll('[data-testid="turn-checklist-item"]')
    expect(rows[0].text()).toContain('正在写脚本')          // InProgress 置顶
    const doneRow = rows.find(r => r.text().includes('生成分镜'))!
    expect(doneRow.text()).toContain('✓')                    // 打钩，非 ×
    expect(doneRow.find('.line-through').exists()).toBe(true)// 删除线
  })

  it('收口后当前态消失、清单折叠保留为凭据', () => {
    const final = [{ kind: 'notice', id: 'notice:turn-summary', text: 'x' } as TimelinePart]
    const w = mountTurn(final, false, progress)
    expect(w.findAll('[data-testid="turn-current-state"]')).toHaveLength(0)
    const list = w.find('[data-testid="turn-task-checklist"]')
    expect(list.exists()).toBe(true)
    expect(list.attributes('open')).toBeUndefined()
  })
})
```

- [ ] **Step 2：确认 RED** —— 三阶段 strip 仍在 → 「旧三阶段词」用例 FAIL；新 testid 找不到 → FAIL。

- [ ] **Step 3：改 script**

1. import：删 `deriveTurnPhaseView` / `AgentTaskProgressState` 旧 import（若仅 strip 用），
   加 `turnLiveStatus` from `./activityLine`、`deriveTurnChecklistView` / `isTurnFinalized` from `./turnChecklistView`。
2. `taskProgress?: AgentTaskProgressState | null` prop **保留**。
3. 删 `PHASE_STATUS_LABEL` / `PHASE_INDEX_LABELS` / `phaseView` / `stripVisible`（`:379-388`）。
4. 新增：

```ts
const currentStateText = computed(() => turnLiveStatus(props.parts))
const checklist = computed(() => deriveTurnChecklistView(props.taskProgress))
const turnFinalized = computed(() => isTurnFinalized(props.parts))
const turnStateVisible = computed(() => Boolean(props.streaming && !turnFinalized.value))
const checklistVisible = computed(() => Boolean(turnStateVisible.value && checklist.value))
const checklistDisclosure = useDisclosure(() => false)
```

其中 `checklistVisible` **不含** `turnStateVisible`：

```ts
const checklistVisible = computed(() => Boolean(checklist.value))  // 收口后仍在，作折叠凭据
const turnStateVisible = computed(() => Boolean(props.streaming && !turnFinalized.value))
```

- [ ] **Step 4：改 template** —— 用下列两块替换 `:462-480` 的 `turn-phase-strip`：

```vue
<div
  v-if="turnStateVisible"
  class="turn-current-state"
  data-testid="turn-current-state"
  aria-live="polite"
>
  <span class="turn-current-state__dot" aria-hidden="true" />
  <span class="turn-current-state__text">{{ currentStateText }}</span>
</div>
<details
  v-if="checklistVisible"
  class="turn-task-checklist"
  data-testid="turn-task-checklist"
  :open="checklistDisclosure.isOpen.value"
  @toggle="checklistDisclosure.onNativeToggle($event.target.open)"
>
  <summary class="turn-task-checklist__summary">
    任务 {{ checklist!.doneCount }}/{{ checklist!.total }} · {{ checklistDisclosure.isOpen.value ? '收起' : '展开' }}
  </summary>
  <ul class="turn-task-checklist__list">
    <li v-for="item in checklist!.items" :key="item.id" class="turn-task-checklist__item">
      <span class="turn-task-checklist__status">{{ item.statusLabel }}</span>
      <span class="turn-task-checklist__title">{{ item.activeForm || item.title }}</span>
      <span v-if="item.errorHint" class="turn-task-checklist__hint">{{ item.errorHint }}</span>
      <CanvasLocatePinIcon v-if="item.nodeId" :size="12" />
    </li>
  </ul>
</details>
```

⚠️ `<details>` 不要写 `:open="computed bool"` 当受控值（会 patch 弹回）；用 `useDisclosure` 契约。
⚠️ `CanvasLocatePinIcon` 已在 `AgentTaskProgressCard.vue` 用过；本组件若未 import 需新增 import（既有依赖，非新建）。

- [ ] **Step 5：改样式** —— 删 `.turn-phase-strip*` 全部样式（`:1553-1579`），新增：

```css
.turn-current-state { display: flex; align-items: center; gap: 6px; color: var(--lnk-accent-text); font-size: 11px; }
.turn-current-state__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.5s infinite; }
.turn-task-checklist { border: 0.5px solid var(--lnk-border-default); border-radius: var(--border-radius-md); background: var(--lnk-surface-raised); }
.turn-task-checklist__summary { cursor: pointer; padding: 4px 8px; color: var(--lnk-text-secondary); }
.turn-task-checklist__list { padding: 2px 8px 6px; }
.turn-task-checklist__item { display: flex; align-items: baseline; gap: 6px; padding: 2px 0; }
.turn-task-checklist__status { min-width: 48px; opacity: 0.7; }
.turn-task-checklist__hint { color: var(--lnk-text-muted); }
```

令牌只用 `--lnk-*`（既有白名单），不新增 hex / `rgba(` / `--neo-*`；`@keyframes pulse` 若既有则复用，不新增同名。

- [ ] **Step 6：确认 GREEN**，命令：

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/AgentTurnTimeline.turnState.test.ts --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 7：删除旧模块**

```bash
git rm apps/web/src/components/agent/turnPhaseView.ts apps/web/src/components/agent/turnPhaseView.test.ts \
        apps/web/src/components/agent/AgentTurnTimeline.phaseStrip.test.ts \
        apps/web/src/components/agent/AgentSideRail.phaseStripWiring.test.ts
```
⚠️ 删前 grep 确认无残留 import；`phaseAggregator.ts` 的 `phaseForToolName` **不删**（`AgentExecutionTrace` 在用）。

- [ ] **Step 8：提交**

```bash
git add apps/web/src/components/agent/
git commit -m "feat(web): 流尾唯一当前态与流内折叠清单替换三阶段条"
```

---

### Task 3 · AgentSideRail 删钉底任务卡 + 守卫

**Files:** Modify `AgentSideRail.vue`、`AgentSideRail.mobileLivePin.test.ts`；Create `AgentSideRail.turnChecklistWiring.test.ts`

- [ ] **Step 1：写失败测试**

```ts
it('composer 区不再有任务卡与灰字；活跃轮接线仍在', () => {
  const html = mountSideRailForTest().html()
  expect(html).not.toContain('data-testid="composer-task-card"')  // 若旧卡无 testid，改用类名扫描
  expect(html).not.toContain('data-testid="turn-live-status"')
})
```

具体 mount 方式仿 `AgentSideRail.turnLiveStatus.test.ts`；若旧卡无稳定 testid，则先给删除前卡加临时 testid
再写"删除后 0 次"的判据（TDD 红→删→绿）。

- [ ] **Step 2：确认 RED**
- [ ] **Step 3：删除 `AgentSideRail.vue:3837-3842` 的 `AgentTaskProgressCard` 渲染块**；
  `showTaskCardAtComposer` 若无其他消费则一并删除（grep 确认）。
  另删 `AgentSideRail.vue:3976-3982` 的 `turn-live-status` 灰字渲染块；`activityLine.turnLiveStatus()`
  函数与 `:task-progress` 接线**不动**（当前态行 / checklist 单源）。
- [ ] **Step 4：追加反向守卫到 `AgentSideRail.mobileLivePin.test.ts`**：

```ts
it('旧三阶段方案不得复活', () => {
  const rail = readFileSync(new URL('./AgentSideRail.vue', import.meta.url), 'utf8')
  const timeline = readFileSync(new URL('./AgentTurnTimeline.vue', import.meta.url), 'utf8')
  expect(rail + timeline).not.toMatch(/turnPhaseView|turn-phase-strip|PHASE_INDEX_LABELS/)
  expect(rail).not.toMatch(/AgentTaskProgressCard/)  // composer 卡退役
  expect(rail + timeline).toMatch(/turnLiveStatus/)  // 派生函数保留（当前态单源）
  expect(rail).not.toContain('data-testid="turn-live-status"') // 灰字渲染已删
})
```

- [ ] **Step 5：确认 GREEN** + `vue-tsc -b`
- [ ] **Step 6：提交**

```bash
git add apps/web/src/components/agent/
git commit -m "refactor(web): 任务卡退出 composer 区并锁死反向守卫"
```

---

### Task 4 · 全量验证与证据

- [ ] **Step 1：定向测试全绿**

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/turnChecklistView.test.ts \
  src/components/agent/AgentTurnTimeline.turnState.test.ts \
  src/components/agent/AgentSideRail.turnChecklistWiring.test.ts \
  src/components/agent/AgentSideRail.mobileLivePin.test.ts \
  src/components/agent/phaseAggregator.test.ts \
  src/styles/design-token.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 2：`vue-tsc -b`**（勿加 `--noEmit`）
- [ ] **Step 3：变异自检** —— 对 `deriveTurnChecklistView` 的 done 计数与 `turnStateVisible` 门禁各做一次变异，
      确认有测试转 RED（防"测试自匹配"）。
- [ ] **Step 4：全量 web 测试**（4 核顺序跑，勿并行两包）
- [ ] **Step 5：提交/推送/PR** —— 见 branch-first-dev-workflow：push → PR → CI 全绿 → 查 mergeStateStatus → squash 合并。

---

### Task 5 · 部署与生产 CDP 走查

- [ ] **Step 1：web-only 部署** —— push 触发 deploy 自动分流 web-only；判据＝产物 chunk 含新标记
      （`turn-current-state` / `turn-task-checklist`）。必要时光补派 `deploy_web_only=true`。
- [ ] **Step 2：生产走查** —— 测试账号 `17279698608`，输入「请帮我生成一个关于小犀牛的皮克斯动画漫剧」。
      CDP 要点见长期备忘：先点 `.agent-fab` 展开、composer＝`.agent-composer textarea`、
      `Input.insertText` + `Input.dispatchKeyEvent` 发送、**250ms 密采样**。
- [ ] **Step 3：判据** —— 流尾 ≤1 条当前态（零 parts 时原位）、无三阶段词/序号/UI 拼小结；清单在流内可展开；
      composer 上方无任务卡；收口后当前态与清单消失、summary notice 仍在。截图存 `.workbuddy/e2e-cdp/`（不入库）。
- [ ] **Step 4：诚实边界** —— 未自然触发的项（如 agnes 429）如实标注，不写 ALL_PASS。

## 5. 完成定义

- 用户 6 点反馈逐条有对应判据并通过；
- 定向测试 + `vue-tsc -b` + CI 全绿，变异自检 2/2 转 RED；
- squash 合并 + web-only 部署 + 生产 CDP 走查 PASS；
- 旧 spec/plan 标 SUPERSEDED，新文档入索引；主仓工作区不被污染。
