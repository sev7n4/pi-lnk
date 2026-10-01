# Agent 进度可见性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在任何时刻都能从侧栏直接读到「正在做什么 / 做得怎么样 / 下一步做什么」，并消除阻塞等待期的白块与「生成回复中 · Ns」假卡死。

**Architecture:** 三区模型（照搬 `vendor/earendil-works/pi/tui-plan.md` 的区域钉底解法）：
- **R1 正文流**（`agent-chat-scroll`）——只放**已完成**的轮次气泡与历史产物卡；
- **R2 底部钉住**（`agent-input-area`）——自上而下：活体过程（仅本轮活跃）→ 两行状态行 → 下一步 chips → composer；
- **R3 活体过程**——钉在 R2 内，回合收束后**沉降**回 R1 的气泡末尾并折叠。
关键动作只有一个：把当前轮的 `AgentExecutionTrace` 从「气泡内部末尾」（`AgentSideRail.vue:2850`）搬到「composer 上方」。所有判定下沉为**纯函数 + vitest**（本仓既有约定：`toolPresentation.ts` / `executionTraceReducer.ts` / `turnStatusBar.ts` 都是纯模块配单测），`.vue` 只做接线。

**Tech Stack:** Vue 3 `<script setup lang="ts">` + Pinia store + vitest；pi-runtime（fastify, ESM TS）与 NestJS（apps/server）两端仅 Activity 事件一处改动。

**Spec:** `docs/mockups/agent-progress-ux-system.html`（四张线框：执行中 / 等待确认 / 完成；§「待决项 1-10」即本计划的任务来源，10 条已全部拍板按推荐默认执行）。

## Global Constraints

- **不引入 AG-UI / A2UI 协议**（决策 7）。只借用 Activity/Interrupt 二分与「agent 只声明意图、客户端目录决定渲染」两条思路。
- **P0 单独上线**（决策 9）：任务 1-4 为一个 PR，纯前端、零协议变更、零 helm 改动；可随时回退。
- **等待态必须显示距自动取消的剩余时间**（决策 6）；缺省文案「处理中」，禁止把内部工具名（如 `upsert_media_node`）显示给用户（决策 5）。
- **chips 走白名单，最多 2 个**（决策 4）；未知 chipSet 一律不渲染任何按钮。
- **产物卡保留在聊天流内**（决策 10），本计划不搬动 `AgentCanvasOutputs` 的位置。
- **新 worktree 依赖装配**：`node_modules` 软链主仓；`apps/server/node_modules` 必须建**真实目录**后逐条软链主仓内容（含 `@lnkpi`）；`apps/web/node_modules` 整体软链（`.bin/vitest` 在里面）。
- **类型判据**：`vue-tsc -b`（勿 `--noEmit`）；本机噪音 `mermaid` TS2307 不算回归。
- **落盘判据**：只有 `git status` 显示 ` M` / `??` 才算写入成功（历史上有 Edit 报成功但零落盘的案例），每步提交后用 `git -C <worktree> status --short` 复核。
- **提交粒度**：每个 task 一个 commit。

## Review Focus

1. **阻塞等待期（0 token）** —— 最容易出现「白块 + 假卡死」；行为应为：气泡完全不渲染，状态行走 waiting，过程卡钉在 composer 上方显示最新人话。
2. **首 token 之前** —— 用户点了发送后的一秒内；行为应为：无气泡、过程卡出现、状态行「处理中 · 1s」，不得闪一片空白。
3. **回合收束瞬间**（streaming=false 但生成任务仍跑）—— 过程卡不能同时出现在钉底区和气泡里（双渲染）。
4. **未知/新增工具名**（如后续 B-N 批次新注册的工具）—— `presentToolStep` 必须降级为「处理中」，不得吐 `⚙ 调用 xxx`。
5. **历史消息回放**（replay 无 `streaming` 字段）—— 老消息不得因新判定被吞掉气泡（用户消息、纯文本助手消息仍要渲染）。
6. **402 渠道余额不足** —— 真实现场（deepseek 欠费）已从 401 之外的状态码被吞成泛化文案，必须可区分于「生成失败，请重试」。
7. **chips 白名单收敛** —— 收敛后 chipSet 分支从 7 组降到 1 组，漏掉的分支会让某个交互手势彻底消失（靠 `data-testid` 回归兜底）。

---

### Task 1: 空气泡零渲染（决策 2）

**Files:**
- Create: `apps/web/src/components/agent/bubbleVisibility.ts`
- Create: `apps/web/src/components/agent/bubbleVisibility.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:268-283`（抽函数）、`:2784`（气泡容器 `v-if`）
- Test: `apps/web/src/components/agent/turnStatusBar.test.ts`（不动，Task 2 改）

**Interfaces:**
- Consumes: `@/components/agent/agentInterruptGate` 的 `filterAssistantVisibleText` / `filterUserVisibleText` / `isMachineOnlyVisibleText`
- Produces: `hasBubbleContent(msg: AgentStreamMessage): boolean`、`hasBubbleText(msg): boolean` —— AgentSideRail 模板用 `hasBubbleContent` 决定是否渲染 `.agent-bubble` 容器

- [x] **Step 1: 写失败测试** —— `bubbleVisibility.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { AgentStreamMessage } from '@/stores/agent'
import { hasBubbleContent } from '@/components/agent/bubbleVisibility'

function assistant(content: string, streaming = false) {
  return { id: 'a1', role: 'assistant', content, streaming, createdAt: 1 } as AgentStreamMessage
}

describe('hasBubbleContent', () => {
  it('流式但零内容（阻塞等待期）→ false，不渲染白块', () => {
    expect(hasBubbleContent(assistant('', true))).toBe(false)
  })
  it('流式且已有 token → true', () => {
    expect(hasBubbleContent(assistant('起', true))).toBe(true)
  })
  it('非流式无内容且无产物/无 trace → false', () => {
    expect(hasBubbleContent(assistant(''))).toBe(false)
  })
  it('助手机器指令文本（filter 后为空）→ false', () => {
    expect(hasBubbleContent(assistant('[[tool_result]]'))).toBe(false)
  })
  it('仅机器可见文本的用户消息 → false', () => {
    expect(hasBubbleContent({ id: 'u1', role: 'user', content: '[[t]]' } as AgentStreamMessage)).toBe(false)
  })
  it('用户正常消息恒 true', () => {
    expect(hasBubbleContent({ id: 'u2', role: 'user', content: '画只狗' } as AgentStreamMessage)).toBe(true)
  })
})
```
> ⚠️ 跑之前先确认 `AgentStreamMessage` 的字段与 `filterAssistantVisibleText` 的过滤前缀， Step 3 实现时以真实过滤结果对齐（先跑一次测试看 `content='[[tool_result]]'` 是否真被过滤）。

- [x] **Step 2: 跑测试确认失败**
Run: `cd apps/web && ./node_modules/.bin/vitest run src/components/agent/bubbleVisibility.test.ts`
Expected: FAIL —— `hasBubbleContent` is not defined

- [x] **Step 3: 实现纯函数**

`apps/web/src/components/agent/bubbleVisibility.ts`：

```ts
/**
 * 气泡可见性（P0 决策 2）：**零内容不渲染气泡**。
 * 阻塞等待期（waiting_user）不产生任何 token，旧实现 `if (msg.streaming) return true`
 * 会渲染一个只有内边距和闪烁光标的气泡 = 用户看到的「白色方块」。
 */
import {
  filterAssistantVisibleText,
  filterUserVisibleText,
  isMachineOnlyVisibleText,
} from '@/components/agent/agentInterruptGate'
import type { AgentStreamMessage } from '@/stores/agent'

/** 助手/助手流式正文此刻是否有可见文本。 */
export function hasBubbleText(msg: AgentStreamMessage): boolean {
  const filtered =
    msg.role === 'user'
      ? filterUserVisibleText(msg.content ?? '')
      : filterAssistantVisibleText(msg.content ?? '')
  return filtered.trim().length > 0
}

/** 气泡容器是否渲染：正文之外还兼容引用条/产物卡等由模板自身判断的场景。 */
export function hasBubbleContent(msg: AgentStreamMessage): boolean {
  if (msg.role === 'user') return !isMachineOnlyVisibleText(msg.content ?? '')
  return hasBubbleText(msg)
}
```

- [x] **Step 4: 跑测试确认通过**
Expected: PASS（6/6）

- [x] **Step 5: AgentSideRail 接线**

`AgentSideRail.vue:278-283` 删除 `shouldShowMessageBubbleText`，改为从模块导入：
```ts
import { hasBubbleContent, hasBubbleText } from '@/components/agent/bubbleVisibility'
```
模板 `:2784` 气泡容器加条件：
```html
<div
  v-if="hasBubbleContent(msg)"
  class="agent-bubble text-[13px] leading-relaxed"
  :class="msg.role === 'user' ? 'agent-bubble-user' : 'agent-bubble-assistant'"
>
```
`:2812` 的 `<p v-else-if="shouldShowMessageBubbleText(msg)">` 改为 `v-if="hasBubbleText(msg)"`，并把 `:2817` 的光标条件从 `msg.streaming` 改为 `msg.streaming && hasBubbleText(msg)`（零内容时不闪光标）。

- [x] **Step 6: 类型判据**
Run: `cd apps/web && ./node_modules/.bin/vue-tsc -b`
Expected: 仅既有 `mermaid` TS2307 噪音

- [x] **Step 7: 提交**
  - ✅ 已合入 master `1b90044`（P0 PR）：bubbleVisibility 单测绿，vue-tsc 仅剩既有 mermaid 噪音。
```bash
git -C .worktrees/feat/agent-progress-visible add apps/web/src/components/agent/bubbleVisibility.ts apps/web/src/components/agent/bubbleVisibility.test.ts apps/web/src/components/agent/AgentSideRail.vue
git -C .worktrees/feat/agent-progress-visible commit -m "fix(web): 零内容不渲染助手气泡（消除阻塞等待期白块）"
```

---

### Task 2: 状态行两行 + 人话 + 402（决策 3 + 附带待办）

**Files:**
- Create: `apps/web/src/components/agent/activityLine.ts`
- Create: `apps/web/src/components/agent/activityLine.test.ts`
- Modify: `apps/web/src/components/agent/turnStatusBar.ts`（`turnStatusLine` / `waitHint` / `failureReason`）
- Modify: `apps/web/src/components/agent/turnStatusBar.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:644-665`（喂 activity/hint）、`:3004-3011`（渲染次行）

**Interfaces:**
- Consumes: `executionTraceReducer` 的 `ExecutionStep[]`、`toolPresentation` 的 `presentToolStep`
- Produces:
  - `describeActivity(steps?: ExecutionStep[]): string | null`（最新非 phase 步骤的人话，无步可说返回 `null`）
  - `turnStatusLine` 现返回 `{ text, hint?, mode } | null`（`hint` 为 undefined 时模板不渲染次行）
  - `waitHint(deadline: number | null | undefined, now: number): string | null`

- [x] **Step 1: 写失败测试**

`activityLine.test.ts`：
```ts
import { describe, expect, it } from 'vitest'
import { describeActivity } from '@/components/agent/activityLine'
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'

function step(over: Partial<ExecutionStep>): ExecutionStep {
  return { id: 's1', kind: 'tool', label: '调用 upsert_media_node', status: 'running', ...over }
}

describe('describeActivity（「正在做什么」人话）', () => {
  it('最新工具步 → 注册表动词（registry 命中）', () => {
    expect(describeActivity([step({ kind: 'tool', meta: { toolName: 'upsert_media_node' } })]))
      .toBe('创建节点')
  })
  it('跳过 phase 门控步骤，取最新真实动作', () => {
    const steps = [step({ kind: 'phase', label: '生成门控', status: 'waiting_user' }), step({ kind: 'tool', meta: { toolName: 'arrange_nodes' } })]
    expect(describeActivity(steps)).toBe('整理布局')
  })
  it('thinking 步 → 思考中', () => {
    expect(describeActivity([step({ kind: 'thinking', label: '思考中…' })])).toBe('思考中…')
  })
  it('无步骤 / undefined → null（上层降级为「处理中」）', () => {
    expect(describeActivity([])).toBeNull()
    expect(describeActivity(undefined)).toBeNull()
  })
})
```
`turnStatusBar.test.ts` 追加（不改既有 4 条断言）：
```ts
it('running：有 activity 时替换「生成回复中」为主语', () => {
  expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 3400, waiting: false, activity: '创建节点' }))
    .toEqual({ text: '创建节点 · 3s', mode: 'running' })
})
it('running：无 activity → 保持原「生成回复中」文案（回归防线）', () => {
  expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 3400, waiting: false }))
    .toEqual({ text: '生成回复中 · 3s', mode: 'running' })
})
it('waiting：带截止时刻 → hint 倒计时', () => {
  const r = turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 5000, waiting: true, waitingTool: 'propose_generation', waitingDeadline: t0 + 305_000 })
  expect(r).toEqual({ text: '等待你在画布上确认生成', hint: '还剩 5 分钟自动取消', mode: 'waiting' })
})
it('402：渠道余额不足（区别于泛化「生成失败，请重试」）', () => {
  expect(failureReason({ status: 402 })).toBe('渠道余额不足')
})
```

- [x] **Step 2: 跑测试确认失败**
Run: `cd apps/web && ./node_modules/.bin/vitest run src/components/agent/activityLine.test.ts src/components/agent/turnStatusBar.test.ts`
Expected: FAIL —— `describeActivity` / `hint` / 402 分支均不存在

- [x] **Step 3: 实现 activityLine.ts**

```ts
/**
 * 「正在做什么」人话（P0 决策 3 + 决策 5 兜底）。
 * 数据源 = 现有 executionTrace 步骤（Web 侧现算，不新增协议事件；
 * 决策 8 的 activity 事件是 P1 的增强，用来补 done/total 进度）。
 */
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'
import { presentToolStep } from '@/components/agent/toolPresentation'

/** 最新一步的人话（已跳过 phase 门控步）；无步可说返回 null。 */
export function describeActivity(steps?: ExecutionStep[]): string | null {
  if (!steps || steps.length === 0) return null
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i]
    if (s.kind === 'phase' && s.status !== 'waiting_user') continue
    const { label } = presentToolStep(s)
    return label
  }
  return null
}
```

- [x] **Step 4: 改 turnStatusBar.ts**

```ts
/** 缺省活动主语：注册表与 trace 都拿不到人话时的兜底，禁止吐内部工具名（决策 5）。 */
export const GENERIC_ACTIVITY = '处理中'

export function waitHint(deadline: number | null | undefined, now: number): string | null {
  if (deadline == null) return null
  const left = Math.max(0, Math.ceil((deadline - now) / 1000))
  if (left <= 0) return '即将自动取消'
  if (left < 60) return `${left}s 后自动取消`
  return `还剩 ${Math.ceil(left / 60)} 分钟自动取消`
}

export function turnStatusLine(input: TurnStatusLineInput): TurnStatusLine {
  if (input.isStreaming) {
    if (input.waiting) {
      const text = input.waitingTool === 'propose_generation' ? '等待你在画布上确认生成' : '等待你确认'
      return { text, hint: waitHint(input.waitingDeadline, input.now), mode: 'waiting' }
    }
    const subject = input.activity?.trim() ? input.activity : '生成回复中'
    const seconds = input.turnStartedAt != null
      ? Math.max(0, Math.floor((input.now - input.turnStartedAt) / 1000))
      : 0
    return { text: `${subject} · ${seconds}s`, mode: 'running' }
  }
  if (input.lastFailed) return { text: `生成失败 · ${input.lastFailed}`, mode: 'failed' }
  return null
}
```
`TurnStatusLineInput` 增两个可选字段：`activity?: string | null`、`waitingDeadline?: number | null`；`TurnStatusLine` 增 `hint?: string`（`text` / `mode` 保持同名，既有测试不破）。
`failureReason` 在 401 前插入：`if (status === 402) return '渠道余额不足'`。

- [x] **Step 5: 跑测试确认通过**
Expected: PASS

- [x] **Step 6: AgentSideRail 接线**

`:644-665` 的 `turnStatus` computed 补参数：
```ts
activity: describeActivity(lastAssistantMessage.value?.executionTrace?.steps) ?? GENERIC_ACTIVITY,
waitingDeadline: agent.blockingWait?.deadlineAt ?? null,
```
（`deadlineAt` 在 Task 4 由 store 的 `waiting_user` 事件写入，本步先留 `null` 不影响功能——hint 为空即不渲染次行。）

模板 `:3004-3011`：
```html
<p v-if="turnStatus" class="agent-turn-status mx-0.5 mb-1 text-[11px]" :class="`agent-turn-status--${turnStatus.mode}`" data-testid="turn-status-line">
  {{ turnStatus.text }}
  <span v-if="turnStatus.hint" class="ml-1 opacity-70">· {{ turnStatus.hint }}</span>
</p>
```

- [x] **Step 7: 类型判据 + 提交**
  - ✅ 已合入 master `1b90044`：activityLine / turnStatusBar 单测绿；未登记工具兜底「处理中」，不吐内部名。
Run: `vue-tsc -b` → 仅 `mermaid` 噪音；`git status` 复核 4 个文件为 ` M`
```bash
git -C .worktrees/feat/agent-progress-visible commit -m "feat(web): 状态行两行——‘正在做什么’人话 + 402 渠道余额不足"
```

---

### Task 3: 活体过程钉底 + 收束沉降（决策 1）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:2850-2855`（气泡内 trace 条件）、`:3000-3011` 前（钉底渲染）
- Modify: `apps/web/src/components/agent/AgentExecutionTrace.vue:9-14`（`dense` prop）

**Interfaces:**
- Produces: `isPinnedTrace(msg: AgentStreamMessage): boolean`（AgentSideRail 内部 computed + 函数）；`AgentExecutionTrace` 新增 `dense?: boolean`

- [x] **Step 1: 写待办清单（TDD 前置的类型回归）**
改 `AgentExecutionTrace.vue` 的 props：
```ts
const props = defineProps<{
  trace: ExecutionTraceState
  streaming?: boolean
  /** 钉底模式（本轮活跃）：只渲染单行摘要头，不渲染步骤列表。 */
  dense?: boolean
}>()
```
`showTrace` 计算属性里加 `props.dense` 分支：dense 时头行文案改为 `正在：<icon> <最新人话> · N 步`，`toggle()` 仅在不 dense 时生效。

- [x] **Step 2: 跑构建确认类型错误**
Run: `cd apps/web && ./node_modules/.bin/vue-tsc -b`
Expected: 成功（仅噪音）

- [x] **Step 3: 钉底接线（`AgentSideRail.vue`）**
```ts
/**
 * 活体过程归属（P0 决策 1）：本轮活跃时过程卡钉在 composer 上方，
 * 回合收束（无流式且无任务卡）后沉降回气泡末尾。
 * ⚠️ 同一个判定同时用在钉底与气泡两处，否则收束瞬间会双渲染。
 */
const liveTrace = computed(() => {
  const last = [...agent.messages].reverse().find((m) => m.role === 'assistant')
  if (!last?.executionTrace) return null
  const active = agent.isStreaming || showTaskCard.value || Boolean(last.streaming)
  return active ? last.executionTrace : null
})
const pinnedTraceOwned = computed(() => liveTrace.value !== null)
```
模板气泡内（`:2850`）：
```html
<AgentExecutionTrace
  v-if="msg.role === 'assistant' && msg.executionTrace && !pinnedTraceOwned"
  :trace="msg.executionTrace"
  :streaming="Boolean(msg.streaming)"
  @focus-node="onFocusNode($event)"
/>
```
模板钉底（`agent-input-area` 内，`<p v-if="turnStatus">` 之前）：
```html
<AgentExecutionTrace
  v-if="liveTrace"
  class="agent-live-trace mb-1"
  :trace="liveTrace"
  :streaming="agent.isStreaming"
  dense
  @focus-node="onFocusNode($event)"
/>
```

- [x] **Step 4: 类型判据**
Run: `vue-tsc -b`；Expected: 仅 `mermaid` 噪音

- [ ] **Step 5: 手工冒烟（无组件测试，靠人工核对）**
  - ⚠️ **未完成**：Plan 要求人眼在浏览器逐条核对 4 个时点（首 token 前 / 工具调用中 / 回合结束 / 阻塞等待），本轮没有做；代码与构建已实证（已合入 master `1b90044`）。线上验证解锁后再补。
起 `pnpm --filter @lnkpi/web dev`，在任意画布发一句「画一只卡通小狗」：
1. 首 token 前：无气泡、钉底出现单行过程卡、状态行「处理中 · 1s」；
2. 工具调用中：钉底头行变成「正在 创建节点 · 3 步」，气泡仍未出现（若本轮无文本）；
3. 回合结束：钉底消失，气泡末尾出现折叠的「执行过程（N 步）」。
4. 阻塞等待（propose）：钉底过程卡 + 状态行「等待你在画布上确认生成」。

- [x] **Step 6: 提交**
  - ✅ 已合入 master `1b90044`：AgentExecutionTrace 新增 `dense` prop + `liveTrace` 钉底/沉降接线（Step 5 手工冒烟见上）。
```bash
git -C .worktrees/feat/agent-progress-visible commit -m "feat(web): 活体过程钉底到 composer 上方，回合收束后沉降回气泡"
```

---

### Task 4: 等待倒计时 + 兜底「处理中」（决策 6 + 决策 5 兜底）

**Files:**
- Modify: `apps/web/src/stores/agent.ts`（`blockingWait` 增 `deadlineAt`、消费 `waiting_user` 事件带的 `timeoutMs`）
- Modify: `apps/web/src/components/agent/toolPresentation.ts:72-76`（未知工具兜底）
- Modify: `apps/web/src/components/agent/turnStatusBar.test.ts` + `toolPresentation.test.ts`（补断言）

**Interfaces:**
- Produces: store `blockingWait: { toolName, callId?, nodeId?, deadlineAt?: number } | null`；`presentToolStep` 未知名 → `{ icon: '⚙', label: '处理中' }`

- [x] **Step 1: 写失败测试**
```ts
// toolPresentation.test.ts 追加
it('未知工具名 → 降级「处理中」（不得吐内部名）', () => {
  expect(presentToolStep({ label: '调用 future_tool', meta: { toolName: 'future_tool' } }))
    .toEqual({ icon: '⚙', label: '处理中' })
})
```

- [x] **Step 2: 跑测试确认失败**
Run: `cd apps/web && ./node_modules/.bin/vitest run src/components/agent/toolPresentation.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**
`toolPresentation.ts:72-76` 的兜底分支改为 `return { icon: FALLBACK_ICON, label: '处理中' }`。
store：`waiting_user` 事件落点（现有 `:283` 附近）改为
```ts
blockingWait.value = wait && wait.toolName
  ? { ...wait, deadlineAt: Date.now() + (wait.timeoutMs ?? 300_000) }
  : null
```
（`timeoutMs` 缺省 300000 = 与线上 `ASK_USER_TIMEOUT_MS=300000` 一致；本 PR 不改 runtime。）

- [x] **Step 4: 跑测试确认通过**
Expected: PASS

- [x] **Step 5: 提交**
  - ✅ 已合入 master `1b90044`：turnStatusBar「自动取消」文案 + stores/agent.ts `deadlineAt` 就位（决策 6）。
```bash
git -C .worktrees/feat/agent-progress-visible commit -m "feat(web): 等待态显示剩余取消时间 + 未知工具降级为‘处理中’"
```

---

### Task 5: chips 白名单收敛为最多 2 个（决策 4）

**Files:**
- Create: `apps/web/src/components/agent/nextChips.ts`
- Create: `apps/web/src/components/agent/nextChips.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（删 7 组 `v-else-if` 按钮块，改单个 `dockChips` 块；`awaitingGenerationPropose` 仅保留给 `AgentPresentationHost` 用）

**Interfaces:**
- Produces: `nextChips(input: { chipSet: string | null; canPromoteVariant: boolean; proposeWait: boolean }): NextChip[]`，`NEXT_CHIP_MAX = 2`，`runNextChip(action)` 在 AgentSideRail 内按 `action.kind` 分发到既有 handler

- [x] **Step 1: 写失败测试**

`nextChips.test.ts`：
```ts
import { describe, expect, it } from 'vitest'
import { nextChips, NEXT_CHIP_MAX } from '@/components/agent/nextChips'

describe('nextChips（决策 4：白名单 + 最多 2 个）', () => {
  it('generation_propose → 确认生成 / 取消', () => {
    const chips = nextChips({ chipSet: 'generation_propose', canPromoteVariant: false, proposeWait: true })
    expect(chips.map((c) => c.label)).toEqual(['确认生成', '取消'])
    expect(chips.length).toBeLessThanOrEqual(NEXT_CHIP_MAX)
  })
  it('未知 chipSet → 空（不渲染任何按钮）', () => {
    expect(nextChips({ chipSet: 'future_kind', canPromoteVariant: false, proposeWait: false })).toEqual([])
  })
  it('null chipSet → 空', () => {
    expect(nextChips({ chipSet: null, canPromoteVariant: false, proposeWait: false })).toEqual([])
  })
  it('recipe_promote：无父版本时降级为单主按钮', () => {
    const chips = nextChips({ chipSet: 'recipe_promote', canPromoteVariant: false, proposeWait: false })
    expect(chips.length).toBe(1)
    expect(chips[0].primary).toBe(true)
  })
})
```

- [x] **Step 2: 跑测试确认失败**
Expected: FAIL

- [x] **Step 3: 实现 nextChips.ts（白名单逐条对应现有 7 组手势）**

```ts
/** P1 决策 4：下一步动作收敛为白名单 —— agent 只声明意图，按钮由客户端目录决定，且恒 ≤2 个。 */
export const NEXT_CHIP_MAX = 2

export type NextChipAction =
  | { kind: 'preset'; text: string }
  | { kind: 'confirm_propose' }
  | { kind: 'cancel_propose' }
  | { kind: 'confirm_atomic' }
  | { kind: 'cancel_atomic' }
  | { kind: 'new_task' }

export interface NextChip { key: string; label: string; primary?: boolean; action: NextChipAction }

export function nextChips(input: {
  chipSet: string | null
  canPromoteVariant: boolean
  proposeWait: boolean
}): NextChip[] {
  const { chipSet, canPromoteVariant, proposeWait } = input
  if (!chipSet) return []
  switch (chipSet) {
    case 'plan':
      return [
        { key: 'plan-1', label: '确认方案', primary: true, action: { kind: 'preset', text: '1' } },
        { key: 'plan-2', label: '换方向', action: { kind: 'preset', text: '2' } },
      ]
    case 'copy':
      return [{ key: 'copy-1', label: '保留文案，继续', primary: true, action: { kind: 'preset', text: '1' } }]
    case 'topo':
      return [{ key: 'topo-1', label: '按这个结构', primary: true, action: { kind: 'preset', text: '1' } }]
    case 'atomic':
      return [
        { key: 'atomic-1', label: '确认生成', primary: true, action: { kind: 'confirm_atomic' } },
        { key: 'atomic-2', label: '取消', action: { kind: 'cancel_atomic' } },
      ]
    case 'generation_propose':
      return proposeWait
        ? [
            { key: 'prop-1', label: '确认生成', primary: true, action: { kind: 'confirm_propose' } },
            { key: 'prop-2', label: '取消', action: { kind: 'cancel_propose' } },
          ]
        : []
    case 'recipe_confirm':
      return [
        { key: 'rc-1', label: '确认落到画布', primary: true, action: { kind: 'preset', text: '确认落到画布' } },
        { key: 'rc-2', label: '先不改', action: { kind: 'preset', text: '先不改' } },
      ]
    case 'recipe_promote':
      return canPromoteVariant
        ? [
            { key: 'rp-1', label: '保存为当前模板的改版', primary: true, action: { kind: 'preset', text: '保存为当前模板的改版' } },
            { key: 'rp-2', label: '存成一套新模板', action: { kind: 'preset', text: '存成一套新模板' } },
          ]
        : [{ key: 'rp-0', label: '存成一套新模板', primary: true, action: { kind: 'preset', text: '存成一套新模板' } }]
    case 'image_qa':
      return [
        { key: 'qa-1', label: '保留这张', primary: true, action: { kind: 'preset', text: '1' } },
        { key: 'qa-2', label: '重新生成', action: { kind: 'preset', text: '2' } },
      ]
    default:
      return []
  }
}
```

- [x] **Step 4: 跑测试确认通过**
Expected: PASS

- [x] **Step 5: 模板替换**
`AgentSideRail.vue` 里 `:3032-3184` 的 7 个 `v-if / v-else-if ... 按钮块` 替换为：
```html
<div v-if="dockChips.length" class="mb-2 flex flex-wrap gap-2 px-0.5" data-testid="next-chips">
  <button
    v-for="chip in dockChips"
    :key="chip.key"
    type="button"
    class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
    :class="chip.primary ? 'agent-preset-primary font-medium' : ''"
    :disabled="agent.isStreaming"
    @click="runNextChip(chip.action)"
  >
    {{ chip.label }}
  </button>
</div>
```
配套 script：
```ts
const dockChips = computed(() =>
  nextChips({
    chipSet: chipSet.value,
    canPromoteVariant: canPromoteVariant.value,
    proposeWait: proposeWait.value != null,
  }),
)
function runNextChip(action: NextChipAction) {
  switch (action.kind) {
    case 'preset': sendPreset(action.text); break
    case 'confirm_propose': confirmProposeGeneration(); break
    case 'cancel_propose': cancelProposeGeneration(); break
    case 'confirm_atomic': confirmAtomicChip(); break
    case 'cancel_atomic': cancelAtomicChip(); break
    case 'new_task': startNewTask(); break
  }
}
```
⚠️ 删除前逐条确认每个 `data-testid`（`generation-propose-confirm` / `-cancel`、`atomic-confirm-dock` / `atomic-confirm-cancel`、`recipe-promote-variant`、`recipe-promote-new`、`recipe-promote-seed-confirm`、`recipe-promote-seed-back`、`recipe-promote-variant-confirm`、`recipe-promote-variant-back`、`new-task-chip`）都被合并进新块，并用 `git grep -n` 复核无残留引用。

- [x] **Step 6: 类型判据 + 提交**
  - ✅ 已合入 master `747a77a`（PR #93）：nextChips 白名单 + 10 个既有 data-testid 锚点全部保留。
`vue-tsc -b` 通过后 `git status` 复核，再 commit：
```bash
git -C .worktrees/feat/agent-progress-visible commit -m "feat(web): 下一步动作收敛为白名单 chips（最多 2 个）"
```

---

### Task 6: 注册表全量补齐（决策 5 剩余部分）

**Files:**
- Modify: `apps/web/src/components/agent/toolPresentation.ts:12-45`

**Interfaces:**
- Produces: `TOOL_PRESENTATION` 覆盖运行时注册的全部工具名（权威清单：`services/pi-runtime/src/tools/*.ts` 里 `name: "..."` 的 40 个）

- [x] **Step 1: 拉权威清单**
Run: `grep -rhoE 'name: "[a-z_]+"' services/pi-runtime/src/tools/*.ts | sort -u`
与 `TOOL_PRESENTATION` 的 key 做差集，逐个补动词（建议：`delete_nodes` 删除节点、`remove_edges` 删除连线、`read_document` 读文档、`save_memory` 记入记忆、`recall_memory` 回忆记忆、`update_node` 更新节点、`list_model_options` 查看可用模型、`web_search` 联网搜索、`web_fetch` 抓取网页）。

- [x] **Step 2: 补注册表**
- [x] **Step 3: 写覆盖性断言**（防未来批次漏补）
```ts
// toolPresentation.test.ts
it('权威清单里的每个工具名都能映射到人话（不含 run_ 前缀的生成类）', () => {
  const canonical = ['delete_nodes', 'remove_edges', 'read_document', 'save_memory', 'recall_memory', 'update_node', 'list_model_options', 'web_search', 'web_fetch']
  for (const name of canonical) {
    expect(TOOL_PRESENTATION[name]).toBeDefined()
  }
})
```
- [x] **Step 4: 跑测试 + 类型判据**
Expected: PASS / 仅 `mermaid` 噪音
- [x] **Step 5: 提交**
  - ✅ 已合入 master `747a77a`：toolPresentation 覆盖性断言就位（Step 3 防未来批次漏补）。

---

### Task 7: `activity` 事件三层贯通（决策 8，P1）

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（`NormalizedEventType` 增 `"activity"`；`dispatchActivity` 在 `tool_start` 同帧广播 `{ toolName, done }`）
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（显式 case，禁止走 `pi_` 前缀透传）
- Modify: `apps/web/src/stores/agent.ts`（`activity` ref + 事件落点）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（status 行优先读 store.activity，缺省回落 `describeActivity`）

**Interfaces:**
- Produces: `activity` 事件 → `{ toolName?: string; done?: number }`；Web `describeRuntimeActivity(activity)`
- ⚠️ **修订（实测）**：原稿的 `label` / `total` 都**不实现**。
  - `label`：中文是客户端目录（`TOOL_PRESENTATION`）的责任（决策 7），runtime 侧再来一份必然漂移 → runtime 只给 `toolName`。
  - `total`：vendor harness 的 `turn_start` 载荷只有 `{ lane, runId, turnId }`，**全仓 grep 不到任何计划步数**；`tool_start` 也是逐条发射、不带“本批共几个”→ 无源可造。前端据此只说「第 N 步」，不渲染「3/8」假分母。
  - Web 侧类型为 `describeRuntimeActivity({ toolName?, done? })`，无 `activityLabel` 计算属性（就地合进 `traceActivity` computed）。

- [x] **Step 1: runtime 事件 + 单测**（pi-runtime 侧 `session-manager` 已有 `dispatchWaitingUser` 范式可照抄，`waiting_user` 在 pod 内已实证）
- [x] **Step 2: Nest 显式映射**（`pi-events.ts` 仿 `case "waiting_user"` 写法）
- [x] **Step 3: Web store 落点 + 模板优先读 activity**
- [x] **Step 4: pi-runtime 单测 + Nest 单测全绿**
- [x] **Step 5: 提 pi-runtime PR → 等 CI 绿 → 合并 → 盯部署（API→pi-runtime→web 串行，队列必须空）**
  - PR #92 · CI 绿 · squash 为 master `bef50b0` · 手动 dispatch `runtime-deploy.yml` tag **0.0.28**（`feature_grep`/`feature_file` 留空）· helm rev **44** deployed。
  - 取证：pod 内 `activity/dispatchActivity/activityStep` 三个特征串全在；生产 E2E 直连抓到 5 条 `{"type":"activity","data":{"toolName":"get_canvas_summary","done":1}}`。
  Run（部署后自检，留空 `feature_grep` / `feature_file` 让校验步骤跳过——昨晚填错文件名导致镜像白构建一次）：
  `docker run --rm --entrypoint sh 127.0.0.1:5000/pi-runtime:<tag> -c 'ls /app/services/pi-runtime/dist/'`
- [x] **Step 6: 合并进本分支（squash 后 rebase origin/master）**
  - ⚠️ `git rebase --onto origin/master <已上游commit>^` 会撞「内容已在上游」冲突（这个 commit 正是被 squash 进 master 的那个）→ 改用 `reset --hard origin/master` + `cherry-pick` 剩余 commit，干净无冲突。
  - 结果：PR #93 squash 为 master `747a77a`。

---

### Task 8: 产物卡回归验收（决策 10）

- [x] **Step 1:** 确认 `AgentCanvasOutputs` 仍在助手气泡内渲染（`.agent-bubble` 内，`:2871` 附近），本计划不改其位置。
  - 交叉核对：`git show 7d57132 -- AgentSideRail.vue | grep -c AgentCanvasOutputs` = **0**（chips 收敛那 −267 行没碰到它）；样式 `.agent-bubble-assistant :deep(.agent-canvas-outputs)` 仍在。
- [ ] **Step 2:** 手工跑一轮完整生成 → 结论：**产物卡保留在聊天流助手气泡内，无漂移**（决策 10 成立）。
  - ⚠️ **上一版错勾为 [x]，此处撤回**：实际只做了静态代码核对（`git show 7d57132 … | grep -c AgentCanvasOutputs` = 0 + 样式选择器仍在），**并没有真的跑一轮完整生成**；生成链路人工验收未执行（用户侧线上验证暂缓）。
  - 本轮 Task 7 的改动只碰状态行人话与 chips 渲染点，不碰气泡结构；图片产物渲染走 `AgentCanvasOutputs`，未改动。
- [x] **Step 3:** 无代码改动，仅记录结论（如上）。

---

## 执行顺序与交付节奏

| 批次 | 任务 | 上线面 |
|---|---|---|
| **P0（本轮）** | 1-4 | 纯前端，一个 PR，零协议/零 helm 改动 |
| P1 | 5, 6 | 纯前端（5 与 3 有模板重叠，可随 P0 一起或紧接） |
| P1 | 7 | pi-runtime → Nest → Web 三层 + 一次 helm 升级 |
| P2 | 8 | 验收 |

P0 合并前先盯 Deploy 自动跑（API→web 串行），web 队列清空后再 squash merge 进 master。
