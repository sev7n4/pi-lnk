# PR1 失败 Toast 与 Agent 诊断入口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画布手工生成失败时，用户得到一条可点击的失败 toast，并能在既有诊断抽屉里一键唤起 Agent 诊断（预填消息、等用户发送）。

**Architecture:** 纯前端、纯增量。新增 `useGenerationFailureToast` composable（纯决策函数 + watcher 装配），CanvasPage 挂载；新增 `CANVAS_AGENT_DIAGNOSE_KEY` provide/inject 通道（照 `CANVAS_NODE_RETRY_KEY` 先例），CanvasPage provide → MediaInspectorDrawer 动作段注入按钮 → agent store 预填 composer 文本 → AgentSideRail 消费（设 input + focus + 清空）。

**Tech Stack:** Vue 3 `<script setup>` + Composition API、element-plus `ElMessage`、pinia、vitest

**Spec:** `docs/superpowers/specs/2026-10-13-generation-failure-recovery-and-motion-prompt-design.md` §4

## Global Constraints

- **只加不改**：不改 `useNodeGeneration.ts` 任何既有 error patch 点、不改 MediaInspectorDrawer 既有三段式/重试/退款逻辑。
- 复用 `short.userMessage` / `short.errorCode`（`useNodeGeneration.ts:264-267`）与 `generationDiagnostic.ts`，**禁止新建错误码映射表**。
- 失败 toast 文案格式：`{节点标题} 生成失败：{userMessage}`。
- 「让 Agent 诊断」**预填不自动发送**（用户显式点发送 = 意图表达）。
- 同一节点重复失败只 toast 一次（收口去重）。
- 既有 `MediaInspectorDrawer.refund-retry.test.ts` 必须全绿（防碰坏 S2-3）。

## Review Focus

- 节点从 `generating` → `error` 与从 `draft` → `error`（用户从未见过生成中）都应 toast——后者是「参数非法直接失败」形态。
- 用户取消生成（`errorMessage` = 已取消 + 退款）**不应** toast：取消是用户动作不是故障。
- toast 去重键是 nodeId：同一节点失败 → 修参数再失败，应**第二次** toast（去重只在「未再次失败前」有效）。
- 画布有多个节点同时失败时，toast 逐条出（不合并、不丢）。
- AgentSideRail 未挂载（画布只读页）时，provide 缺失 ⇒ 抽屉按钮必须降级隐藏而非报错（`inject(KEY, null)` 判空）。

---

### Task 1: 失败 toast 决策纯函数 + composable

**Files:**
- Create: `apps/web/src/composables/useGenerationFailureToast.ts`
- Test: `apps/web/src/composables/useGenerationFailureToast.test.ts`

**Interfaces:**
- Consumes: 无（纯函数起步）
- Produces:
  - `shouldToastForFailure(prev: { status?: unknown; errorMessage?: unknown } | null | undefined, next: { status?: unknown; errorMessage?: unknown } | null | undefined): boolean`
  - `useGenerationFailureToast(): { onNodeError(node: { id: string; title?: string; status?: unknown; errorMessage?: unknown }): void }`（内部持 `Set<string>` 去重 + `ElMessage.warning`，点击回调由 Task 3 的 CanvasPage 提供）

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/composables/useGenerationFailureToast.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shouldToastForFailure } from './useGenerationFailureToast'

describe('shouldToastForFailure', () => {
  it('generating → error：toast', () => {
    expect(shouldToastForFailure({ status: 'generating' }, { status: 'error', errorMessage: '上游超时' })).toBe(true)
  })
  it('draft → error（参数非法直接失败）：toast', () => {
    expect(shouldToastForFailure({ status: 'draft' }, { status: 'error', errorMessage: '积分不足' })).toBe(true)
  })
  it('已取消（errorMessage 含「已取消」）：不 toast', () => {
    expect(shouldToastForFailure({ status: 'generating' }, { status: 'error', errorMessage: '已取消，8 积分已返回' })).toBe(false)
  })
  it('error → error（重复快照）：不 toast', () => {
    expect(shouldToastForFailure({ status: 'error', errorMessage: '上游超时' }, { status: 'error', errorMessage: '上游超时' })).toBe(false)
  })
  it('completed → error（出图后节点被改挂）：不 toast', () => {
    expect(shouldToastForFailure({ status: 'completed' }, { status: 'error', errorMessage: 'x' })).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/composables/useGenerationFailureToast.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写最小实现**

```ts
// apps/web/src/composables/useGenerationFailureToast.ts
import { ElMessage } from 'element-plus'
import { onScopeDispose, ref } from 'vue'

interface NodeErrorLike {
  status?: unknown
  errorMessage?: unknown
}

/** 取消是用户动作不是故障：errorMessage 以「已取消」开头的不 toast。 */
function isCancellation(node: NodeErrorLike): boolean {
  const msg = typeof node.errorMessage === 'string' ? node.errorMessage : ''
  return msg.startsWith('已取消')
}

export function shouldToastForFailure(prev: NodeErrorLike | null | undefined, next: NodeErrorLike | null | undefined): boolean {
  if (!next || next.status !== 'error') return false
  if (isCancellation(next)) return false
  if (prev?.status === 'error') return false // 重复快照/轮询重放
  if (prev?.status === 'completed') return false // 终态节点被改挂不是本次生成失败
  return true
}

export interface FailureToastNode {
  id: string
  title?: string
  status?: unknown
  errorMessage?: unknown
}

/**
 * 节点失败 toast：同一 nodeId 只 toast 一次，直到该 id 再次失败前。
 * dedupe 键在 toast 触发时登记；重试后再次失败由调用方先 clearNodeDedupe。
 */
export function useGenerationFailureToast(opts: { onOpenDetail: (nodeId: string) => void }) {
  const toasted = new Set<string>()
  function onNodeError(node: FailureToastNode): void {
    if (toasted.has(node.id)) return
    toasted.add(node.id)
    const title = node.title?.trim() || '节点'
    const msg = typeof node.errorMessage === 'string' && node.errorMessage ? node.errorMessage : '生成失败'
    ElMessage({
      type: 'warning',
      duration: 8000,
      message: `${title} 生成失败：${msg}`,
      onClick: () => opts.onOpenDetail(node.id),
    })
  }
  function clearNodeDedupe(nodeId: string): void {
    toasted.delete(nodeId)
  }
  onScopeDispose(() => toasted.clear())
  return { onNodeError, clearNodeDedupe }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/composables/useGenerationFailureToast.test.ts`
Expected: PASS（5/5）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/composables/useGenerationFailureToast.ts apps/web/src/composables/useGenerationFailureToast.test.ts
git commit -m "feat(web): 生成失败 toast 决策纯函数 + composable（PR1 Task1）"
```

---

### Task 2: CanvasPage 挂载 watcher（generating→error 转移检测）

**Files:**
- Modify: `apps/web/src/pages/CanvasPage.vue`（watcher 挂载点，紧邻既有节点状态相关 watcher；不碰既有逻辑）
- Test: 无新单测（watcher 装配由 Task 1 纯函数 + 手动回归覆盖；下一任务补集成断言）

**Interfaces:**
- Consumes: Task 1 的 `useGenerationFailureToast` / `shouldToastForFailure`
- Produces: CanvasPage 内 `failureToast` 实例 + `openNodeDiagnostic(nodeId)` 函数（Task 3 复用同一函数做「让 Agent 诊断」的详情跳转）

- [ ] **Step 1: 读挂载点上下文**

Run: `grep -n "watch(" apps/web/src/pages/CanvasPage.vue | head -20`，选一个**已存在的节点数据 watcher**（`nodes` 或 `canvas.nodes`）作为紧邻插入点；同时 `grep -n "MediaInspectorDrawer\|inspector" apps/web/src/pages/CanvasPage.vue | head` 找到诊断抽屉的显隐控制 ref（Task 3 的 `openNodeDiagnostic` 要复用它）。

- [ ] **Step 2: 实现 watcher + 诊断打开函数**

在 `<script setup>` 内（Task 1 import 之后）加入：

```ts
const { onNodeError: toastNodeFailure, clearNodeDedupe } = useGenerationFailureToast({
  onOpenDetail: (nodeId) => { void openNodeDiagnostic(nodeId) },
})

// 失败 toast：只监听「转移到 error」的边，不监听快照相等。
// 重试开始（→ generating/completed）即清该节点去重，保证「失败→重试→再失败」第二次也 toast。
watch(
  () => nodes.value.map((n) => ({ id: n.id, status: n.data?.status, errorMessage: n.data?.errorMessage })),
  (curr, prevByIdArr) => {
    const prevById = new Map((prevByIdArr ?? []).map((p) => [p.id, p]))
    for (const cur of curr) {
      const prev = prevById.get(cur.id)
      if (cur.status === 'generating') clearNodeDedupe(cur.id)
      if (shouldToastForFailure(prev, cur)) toastNodeFailure(cur)
    }
  },
  { deep: false },
)
```

> ⚠️ `nodes` 的确切来源 ref 名以 Step 1 grep 结果为准（可能是 `canvasNodes` / `flowNodes`）；映射数组保持浅比较、`deep: false`，避免每轮轮询全量 deep diff。

`openNodeDiagnostic(nodeId)`：找到 MediaInspectorDrawer 的显隐 ref（如 `inspectorNodeId`），设为该 nodeId 并置 `true`——**照抄该文件内既有的「打开诊断抽屉」调用点写法**（grep `inspector` 附近必有先例，如节点角标 `!` 的点击处理），不要自造打开路径。

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && ../../node_modules/.bin/vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "CanvasPage\|useGenerationFailureToast" | head`
Expected: 无新增错误（既有错误基线不变）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/CanvasPage.vue
git commit -m "feat(web): CanvasPage 挂载生成失败 toast watcher（PR1 Task2）"
```

---

### Task 3: 诊断抽屉「让 Agent 诊断」入口（provide/inject + composer 预填）

**Files:**
- Modify: `apps/web/src/composables/canvasNodeActions.ts`（加 InjectionKey + 类型，照 `CANVAS_NODE_RETRY_KEY` 先例）
- Modify: `apps/web/src/stores/agent.ts`（加 `pendingDiagnosticText` ref + `requestAgentDiagnose(text)` / `consumePendingDiagnosticText()`）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（watch 消费：设 `input.value` + `composerRef.value?.focus()`）
- Modify: `apps/web/src/components/media/MediaInspectorDrawer.vue`（动作段注入按钮）
- Modify: `apps/web/src/pages/CanvasPage.vue`（provide 实现）
- Test: `apps/web/src/components/media/MediaInspectorDrawer.agent-diagnose.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `openNodeDiagnostic`（不直接用，provide 实现只依赖 store）
- Produces:
  - `CANVAS_AGENT_DIAGNOSE_KEY: InjectionKey<CanvasNodeAgentDiagnoseFn>`
  - `type CanvasNodeAgentDiagnoseFn = (info: { nodeId: string; title: string; userMessage: string; errorCode?: string }) => void`
  - store: `requestAgentDiagnose(text: string): void` / `consumePendingDiagnosticText(): string | null`

- [ ] **Step 1: 写失败测试（抽屉按钮）**

```ts
// apps/web/src/components/media/MediaInspectorDrawer.agent-diagnose.test.ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MediaInspectorDrawer from './MediaInspectorDrawer.vue'
import { CANVAS_AGENT_DIAGNOSE_KEY } from '@/composables/canvasNodeActions'

// 挂载辅助：沿用 MediaInspectorDrawer.refund-retry.test.ts 的 props/provide 写法
//（node = error 态、diagnostic = { userMessage: '上游超时', code: 'upstream_timeout' }），
//额外 provide: { [CANVAS_AGENT_DIAGNOSE_KEY as symbol]: spy }
describe('让 Agent 诊断入口', () => {
  it('error 态 + provide 存在 → 渲染按钮；点击 → 带 nodeId/userMessage/errorCode 调用', async () => {
    const spy = vi.fn()
    const wrapper = mount(MediaInspectorDrawer, { /* 同 refund-retry.test.ts:150 的 provide 模式 */ global: { provide: { [CANVAS_AGENT_DIAGNOSE_KEY as symbol]: spy } } })
    const btn = wrapper.findAll('button').find((b) => b.text().includes('让 Agent 诊断'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: expect.any(String),
      userMessage: '上游超时',
      errorCode: 'upstream_timeout',
    }))
  })
  it('provide 缺失（inject 回落 null）→ 按钮不渲染', () => {
    const wrapper = mount(MediaInspectorDrawer, { /* 无 provide */ })
    const btn = wrapper.findAll('button').find((b) => b.text().includes('让 Agent 诊断'))
    expect(btn).toBeFalsy()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/components/media/MediaInspectorDrawer.agent-diagnose.test.ts`
Expected: FAIL（按钮不存在）

- [ ] **Step 3: 实现四层改动**

① `canvasNodeActions.ts` 追加（照 `CANVAS_NODE_RETRY_KEY` 的声明形式逐字对齐）：

```ts
export type CanvasNodeAgentDiagnoseFn = (info: {
  nodeId: string
  title: string
  userMessage: string
  errorCode?: string
}) => void

export const CANVAS_AGENT_DIAGNOSE_KEY: InjectionKey<CanvasNodeAgentDiagnoseFn> = Symbol('canvasAgentDiagnose')
```

② `stores/agent.ts` 追加（放在既有 ref 声明区）：

```ts
const pendingDiagnosticText = ref<string | null>(null)
function requestAgentDiagnose(text: string): void {
  pendingDiagnosticText.value = text
}
function consumePendingDiagnosticText(): string | null {
  const text = pendingDiagnosticText.value
  pendingDiagnosticText.value = null
  return text
}
// 并在 store return 中导出这三个
```

③ `AgentSideRail.vue`：在 `const input = ref('')`（:179）附近加：

```ts
watch(() => agentStore.pendingDiagnosticText, (text) => {
  if (!text) return
  input.value = text
  agentStore.consumePendingDiagnosticText()
  nextTick(() => composerRef.value?.focus())
})
```

（`agentStore` 以该文件内既有的 store 引用名为准。）

④ `CanvasPage.vue`：紧邻 `provide(CANVAS_NODE_RETRY_KEY, ...)`（:4349）加：

```ts
provide(CANVAS_AGENT_DIAGNOSE_KEY, (info) => {
  const text = `视频节点 ${info.nodeId} 生成失败了（原因：${info.userMessage}${info.errorCode ? `，错误码：${info.errorCode}` : ''}），帮我诊断并给下一步建议`
  agentStore.requestAgentDiagnose(text)
})
```

⑤ `MediaInspectorDrawer.vue`：`const retryNode = inject(CANVAS_NODE_RETRY_KEY, null)`（:46）旁加 `const agentDiagnose = inject(CANVAS_AGENT_DIAGNOSE_KEY, null)`；在动作段（S2-3 换模型重试区 `:668` 附近的模板位置，**之后**）加按钮：

```vue
<el-button v-if="agentDiagnose && diagnostic" size="small" @click="agentDiagnose({
  nodeId: nodeId,
  title: nodeTitle,
  userMessage: diagnosticMessage.value,
  errorCode: diagnostic.value?.code,
})">让 Agent 诊断</el-button>
```

（`nodeId` / `nodeTitle` 以该组件内既有的节点 prop 名为准，grep `defineProps` 确认。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/components/media/MediaInspectorDrawer.agent-diagnose.test.ts src/components/media/MediaInspectorDrawer.refund-retry.test.ts`
Expected: PASS（新 2 条 + 既有 refund-retry 全绿）

- [ ] **Step 5: 类型检查 + Commit**

```bash
cd apps/web && ../../node_modules/.bin/vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "MediaInspector|AgentSideRail|CanvasPage|canvasNodeActions|stores/agent" | head
git add apps/web/src/composables/canvasNodeActions.ts apps/web/src/stores/agent.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/media/MediaInspectorDrawer.vue apps/web/src/pages/CanvasPage.vue apps/web/src/components/media/MediaInspectorDrawer.agent-diagnose.test.ts
git commit -m "feat(web): 诊断抽屉「让 Agent 诊断」入口——provide/inject + composer 预填（PR1 Task3）"
```

---

### Task 4: PR 前回归（web 全量相关面）

**Files:**
- Modify: 无

- [ ] **Step 1: 跑受影响文件的全量测试**

Run:
```bash
cd apps/web && ../../node_modules/.bin/vitest run src/composables/useGenerationFailureToast.test.ts src/components/media/ src/components/canvas/NodeTaskCornerActions 2>&1 | tail -15
```
Expected: 全 PASS

- [ ] **Step 2: 跑 design-token / theme 守卫（.css 未动，防误伤）**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/styles/ 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 3: 推送 + 开 PR**

```bash
git push -u origin <branch>
gh pr create --base master --title "feat(web): 生成失败 toast + 诊断抽屉 Agent 诊断入口（PR1/②④）" --body "实现 spec §4：docs/superpowers/specs/2026-10-13-generation-failure-recovery-and-motion-prompt-design.md。复用既有诊断体系（F11），只补两增量。"
```

- [ ] **Step 4: 盯 CI 到全绿后 squash 合并**

```bash
gh pr checks <n>   # 全 pass
gh pr merge <n> --squash   # 不加 --delete-branch
```
