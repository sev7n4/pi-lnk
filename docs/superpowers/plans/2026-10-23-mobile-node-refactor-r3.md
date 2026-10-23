# 移动端节点重构 R3：状态收敛（状态机 + 壳层聚合）

> 来源：`docs/design/2026-10-22-mobile-node-refactor.md` §10.2 D-C + §10.3 Release 3。
> R1（瓦片化 + 范式反转 + 删 Dock）已上线（#555）。R2（编辑/生成闭环：空态路由 + 新建流）已上线（#560 → `3d7b2dbc`）。
> **R3 = 把「生成中 / 待确认 / 失败」从桌面 chrome 收敛到「瓦片轻态 + 壳层状态栏聚合」**——减法核心。

## 0. R3 要解决什么（代码级取证）

D-C 定义了节点状态机 `empty → generating → pending → confirmed → error`，但**移动端只落地了 `empty` 一行**（R2）。

移动端当前的状态呈现是**断的**：

| # | 断点 | 证据 | 后果 |
| - | ---- | ---- | ---- |
| 1 | **状态根本没传到磁贴** | `NodeRenderer.vue` 传 `MobileNodeTile` 的 props 只有 `id / type / data`（+ `v-bind="attrs"`），**没有 `:status`** | `MobileNodeTile.status` 恒 undefined ⇒ `statusBadge()` 恒返回 null ⇒ **状态徽标当前根本不渲染** |
| 2 | **徽标表只覆盖 2/5 态** | `nodeTypeConfigs.ts`：只有 image 判 `error`、video 判 `pending` | `generating` / `failed` / `fallback_pending` / `pending_confirm` 全无徽标；且 video 判的 `pending` **不是** `pending_confirm`（值不同，桌面用后者） |
| 3 | **tone 定义了但没样式** | `BadgeTone = 'idle' \| 'busy' \| 'warn' \| 'error'`，但 CSS 只有 `[data-tone='error']` 一条 | `busy` / `warn` / `idle` 无视觉 |
| 4 | **待确认态在移动端无处确认** | `ProposeConfirmOverlay` 是 PC 浮层；`MobileNodeActionSheet`（长按 sheet）**无确认/拒绝动作** | 移动端收到「待确认」节点 ⇒ 只能干瞪眼 |
| 5 | **生成中无聚合进度** | `MobileCanvasShell` 里 grep `statusBar` / `progress` / `aggregate` = 0 命中 | 多节点同时生成时，画布上只有角标小 spinner，用户不知道整体在干什么 |

### ⭐ 关键约束：不存在生成进度百分比

全仓取证：**节点数据里没有生成进度百分比字段**。唯一百分比是 `uploadProgress`（仅上传态）。
生成态只有「已耗时」——`generationStartedAt` + `formatElapsed()`（`nodeTaskChrome.ts:16`）。
`AgentSideRail.vue:1125` 明确写着「progress / eta：现链路只有已耗时，无完成比例 / 剩余时长」。

⇒ **R3 的「进度环」是不确定态 spinner + 计时，绝不假造百分比。** 假造一个假的 0%→100% 比不做更糟。

## Global Constraints

- **PC 零 diff**：桌面已有 `NodeTaskCornerActions` / `ProposeConfirmOverlay` / `SelectionBatchProgressCard` 三套成熟实现，**移动端只复用判据与回调，不改桌面组件**。
- **复用优先**：状态判据复用 `constants/dockStudio.ts`（`isNodeGenerating` / `isPendingConfirmNode` / `NODE_GENERATION_STATUS`）与 `nodeTaskChrome.ts` 的 `resolveTaskChrome()`；确认/拒绝复用 `handleAgentGenerateNode` / `handleProposeConfirmCancel`。
- **纯函数承载策略判断**（可行为级单测），页面层只做接线——与 R2 的 `resolveMobileNodeTapIntent` 同构。
- **44px 触控目标**：所有可点区域 ≥ 44×44（设计规范硬约束）。
- **令牌纪律**：只用 `--lnk-*`（L2/L3），禁裸 hex / `rgba(` / Tailwind 任意值。
- 分支纪律：`feat/mobile-node-refactor-r3` 自 `origin/master`（含 #558/#560/#393）；Conventional commits；每任务一 commit。

## Review Focus

1. **状态判据单一真源**：五态归一为一个纯函数 `resolveMobileNodeState()`，磁贴 / 状态栏 / 徽标三处消费同一判据。
2. **PC 零 diff**：`git diff origin/master...HEAD -- 'apps/web/src/components/canvas/CanvasNode*' 'apps/web/src/pages/CanvasPage.vue'` 只允许出现 `provide` / prop 接线行。
3. **不假造进度**：状态栏只显示「N 个生成中」+ 计时，不显示假百分比。
4. **待确认必须可操作**：移动端长按 sheet 能「确认 / 拒绝」，且复用桌面同一套语义（批次 2 confirm）。

## File Structure

```
apps/web/src/composables/mobileNodeState.ts             # 新增：纯函数 resolveMobileNodeState(node) → 五态
apps/web/src/composables/mobileNodeState.test.ts        # 新增：行为级单测
apps/web/src/components/canvas/NodeRenderer.vue          # 改：向 MobileNodeTile 传 :status（修断链 1）
apps/web/src/components/mobile/nodeTypeConfigs.ts        # 改：statusBadge 补全五态（修断链 2）
apps/web/src/components/mobile/MobileNodeTile.vue        # 改：状态轻态渲染（骨架/角标/红边+重试）
apps/web/src/components/mobile/MobileNodeStatusBar.vue   # 新增：壳层聚合状态栏（generating 计数 / pending 确认拒绝）
apps/web/src/components/mobile/MobileNodeStatusBar.test.ts # 新增
apps/web/src/components/mobile/MobileCanvasShell.vue     # 改：挂 MobileNodeStatusBar
apps/web/src/pages/CanvasPage.vue                        # 改：provide 状态聚合数据 + 确认/拒绝回调
```

---

## Task 1：状态判据纯函数（五态归一）

**RED** — `mobileNodeState.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { resolveMobileNodeState } from './mobileNodeState'

describe('resolveMobileNodeState（D-C 五态归一）', () => {
  it('无内容无状态 → empty', () => {
    expect(resolveMobileNodeState({ type: 'image', data: {} })).toBe('empty')
  })
  it('generating / fallback_pending → generating', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'generating' } })).toBe('generating')
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'fallback_pending' } })).toBe('generating')
  })
  it('pending_confirm → pending', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'pending_confirm' } })).toBe('pending')
  })
  it('error / failed → error', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'error' } })).toBe('error')
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'failed' } })).toBe('error')
  })
  it('有内容（url / content）且非生成态 → confirmed', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('confirmed')
    expect(resolveMobileNodeState({ type: 'text', data: { content: '你好' } })).toBe('confirmed')
  })
  it('生成态优先于内容（有 url 但仍在生成 → generating）', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { url: 'https://x/a.png', status: 'generating' } })).toBe('generating')
  })
})
```

**GREEN** — `mobileNodeState.ts`：

```ts
export type MobileNodeState = 'empty' | 'generating' | 'pending' | 'confirmed' | 'error'

export function resolveMobileNodeState(node: {
  type: string
  data?: Record<string, unknown> | null
}): MobileNodeState {
  const data = node.data ?? {}
  const status = String(data.status ?? '')
  if (isNodeGenerating(status)) return 'generating'
  if (status === NODE_PENDING_CONFIRM_STATUS) return 'pending'
  if (status === NODE_GENERATION_STATUS.error || status === NODE_GENERATION_STATUS.failed) return 'error'
  // 有内容即 confirmed（status 是 draft/idle/completed 等非语义态时）
  if (node.type === 'text') {
    return String(data.content ?? '').trim() ? 'confirmed' : 'empty'
  }
  return String(data.url ?? '') ? 'confirmed' : 'empty'
}
```

## Task 2：修断链（status 透传 + 徽标表补全）

**RED** — `MobileNodeTile.state.test.ts`：
- 断言 `NodeRenderer.vue` 向磁贴传了 `:status`（静态契约 + 行为级：挂载 NodeRenderer 传 status 后磁贴渲染对应徽标）。
- 断言 `nodeTypeConfigs.statusBadge` 覆盖 `generating` / `error` / `failed` / `pending_confirm` / `fallback_pending` 五类。

**GREEN**：
- `NodeRenderer.vue`：`:status="(data as any)?.status"`。
- `nodeTypeConfigs.ts`：`statusBadge` 改为**统一**由 `resolveMobileNodeState` 驱动（`generating`→{'生成中','busy'}、`pending`→{'待确认','warn'}、`error`→{'失败','error'}；`confirmed`/`empty` → null）。⚠️ 徽标不再是「按类型分别判」，而是「按状态统一判」——四类型一致性由此保证。

## Task 3：瓦片状态轻态（generating / error）

**RED** — `MobileNodeTile.state.test.ts` 追加：
- generating → 渲染骨架/进度环（`.mobile-node-generating`），不渲染内容。
- error → 渲染红边（`.mobile-node-tile[data-state='error']`）+ 44px 重试按钮，emit `retry`。
- pending → 渲染「待确认」角标。

**GREEN**：
- `MobileNodeTile.vue`：根元素加 `:data-state="state"`；generating 时渲染轻量进度环 + 计时文案；error 时渲染重试按钮（`emit('retry')`）→ 经 `NodeRenderer` → `inject(CANVAS_NODE_RETRY_KEY)`（桌面同一注入键，**不新建键**）。

## Task 4：壳层聚合状态栏 `MobileNodeStatusBar`

**RED** — `MobileNodeStatusBar.test.ts`：
- 有 generating 节点 → 显示「N 个生成中」+ 计时。
- 有 pending_confirm 节点 → 显示「待确认」+「确认 / 拒绝」两个 44px 按钮，emit `confirm` / `cancel`（带 nodeId）。
- 无节点 → 不渲染（`v-if`）。

**GREEN**：
- 新建 `MobileNodeStatusBar.vue`，props：`generatingCount` / `pendingNodes` / `elapsedText`；emits：`confirm(nodeId)` / `cancel(nodeId)`。
- `MobileCanvasShell.vue`：在 `MobileSaveStatus` **同带**（底部）挂载，`v-if="mobileAppTab === 'canvas' && !multiSelectActive"`（与保存状态行互斥，避免抢位）。
- `CanvasPage.vue`：provide 聚合数据 + 确认/拒绝回调（复用 `handleAgentGenerateNode` / `handleProposeConfirmCancel`）。

## Self-Review（每任务完成时）

- [ ] PC 路径零 diff（`git diff origin/master...HEAD -- 'apps/web/src/components/canvas/CanvasNode*'` 为空）
- [ ] 状态判据单一真源（`resolveMobileNodeState`），三处消费同一判据
- [ ] R1/R2 既有测试全绿（mobile 套件 + NodeRenderer + 磁贴 policy/placeholder/fit/tts/gesture）
- [ ] 令牌守卫三件套绿（`design-token` / `theme-usage` / `text-token-guard`）
- [ ] 44px 触控目标（可点区域）
- [ ] 无假造进度百分比
- [ ] commit message 标注「R3-T<n>」与复用的真源

## 不在本 release（防范围蔓延）

- D-D 波形后端契约与前端占位（P4 并行项，独立分支）
- 文本节点 composer 权重等 IA v4 议题（已裁决未实施族）
- 生成进度百分比的真实数据（后端无此字段 ⇒ 需后端先加，不是前端能补的）
- 桌面端 `ProposeConfirmOverlay` 的移动端重构（移动端用状态栏按钮，不复用浮层）
