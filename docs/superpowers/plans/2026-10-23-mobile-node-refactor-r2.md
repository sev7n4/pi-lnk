# 移动端节点重构 R2：编辑/生成闭环（spec-plan）

> 来源：`docs/design/2026-10-22-mobile-node-refactor.md` §10.3 Release 2（PR-B 编辑器 sheet 复用 `DockStudioRouter` + FAB+ 新建流，Q3 复用已确认）。
> R1（瓦片化 + 范式反转 + 删 Dock + coach mark）已上线（PR #555 → master `cffb4527`）。
> **R1 已交付**：`MobileNodeEditorSheet`（复用 DockStudioRouter）+ 长按动作 sheet「编辑」+ tap→viewer 四语义 + TTS。
> **R2 只剩闭环**：R1 删掉了移动端 Dock，但「新建」与「空节点」两条路断在半空——

## 0. R2 要解决的两个断点（代码级取证）

| # | 断点 | 证据 | 后果 |
| - | ---- | ---- | ---- |
| 1 | **新建后无编辑入口** | `CanvasPage.vue:1916 handleDockAdd`：建节点 → `selectOnlyNode` → `focusNodeById`。PC 端选中即开 `DockStudioToolbar`；**移动端 Dock 已被 R1 删掉**（`v-if` 加 `!isMobileLayout`）⇒ 新节点选中后没有任何编辑器承载 | FAB+ 选类型 → 得到一个空磁贴，用户无处写 prompt ⇒ 新建流断裂 |
| 2 | **空节点 tap = 空白查看器** | `NodeRenderer.vue:34 onTileOpen` 无条件 `openViewer(...)`；`MobileNodeViewer` 的 img/video 均 `v-if="url"` | tap 空图/空视频/空文本 ⇒ 全屏一片空白；空音频 tap 走 `toggleAudio()` 播一个空 src，毫无反应 | 

## Global Constraints

- **PC 零 diff**：`handleDockAdd` 的 PC 路径（select + focus + dock 自动开）一行不动；只加移动端分支。
- **复用优先**：新建后开的 sheet 就是 R1 的 `MobileNodeEditorSheet`（Q3「create sheet 与 edit sheet 同源」）——不新建组件、不复制逻辑。
- **D-C 状态机**：本 release 只落地 `empty` 行（tap → 「点击生成/撰写」主动作 = 编辑 sheet）；`generating/pending/confirmed/error` 归 Release 3。
- 纯函数承载策略判断（可行为级单测），页面层只做接线——与 R1 的 `MOBILE_NODE_*_KEY` 注入键模式同构。
- 分支纪律：`feat/mobile-node-refactor-r2` 自 `origin/master`；Conventional commits；每任务一 commit。

## Review Focus

1. **PC 回归零 diff**（R1 审阅焦点同款）：`handleDockAdd` 桌面路径与 `DockStudioToolbar` 门控不被本 release 触碰。
2. **空态判定单一真源**：`resolveMobileNodeTapIntent` 是纯函数；NodeRenderer/CanvasPage/tile 三处消费同一判据，不各写一遍。
3. **不回归 R1 四语义**：有内容的图/视/音/文 tap 行为（viewer/内联播放/TTS/阅读器）必须逐条保住——用既有测试兜底。

## File Structure

```
apps/web/src/composables/mobileNodeOpenPolicy.ts     # 新增：纯函数 resolveMobileNodeTapIntent(node)
apps/web/src/composables/mobileNodeOpenPolicy.test.ts # 新增：行为级单测
apps/web/src/components/canvas/NodeRenderer.vue      # 改：onTileOpen 消费策略（空 → 请求 editor）
apps/web/src/composables/canvasNodeActions.ts        # 改：新增 MOBILE_NODE_OPEN_EDITOR_KEY（tap 空节点 → 编辑 sheet）
apps/web/src/pages/CanvasPage.vue                    # 改：handleDockAdd 移动端分支 + provide 新键
apps/web/src/components/mobile/MobileNodeTile.vue    # 改：空音频 tap 不再 toggleAudio，emit('tap') 交策略
apps/web/src/pages/CanvasPage.mobileCreateLoop.test.ts # 新增：静态契约（新建闭环 + 空态路由）
```

---

## Task 1：空态路由纯函数（策略单一真源）

**RED** — `mobileNodeOpenPolicy.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { resolveMobileNodeTapIntent } from './mobileNodeOpenPolicy'

describe('resolveMobileNodeTapIntent（空态路由，D-C empty 行）', () => {
  it('有 url 的图/视频 → viewer', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'video', data: { url: 'https://x/a.mp4' } })).toBe('viewer')
  })
  it('空 url 的图/视频 → editor（不开空白灯箱）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: '' } })).toBe('editor')
    expect(resolveMobileNodeTapIntent({ type: 'video', data: {} })).toBe('editor')
  })
  it('有内容的文本 → viewer；空文本 → editor', () => {
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '你好' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '' } })).toBe('editor')
  })
  it('音频 → tile 内联处理（不进 viewer/editor 路由）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('inline')
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: {} })).toBe('editor')
  })
})
```

**GREEN** — `mobileNodeOpenPolicy.ts`：

```ts
/** 移动端 tap 意图（R2）：viewer = 全屏查看器；editor = 编辑 sheet；inline = 磁贴内联处理（音频）。 */
export type MobileNodeTapIntent = 'viewer' | 'editor' | 'inline'

export function resolveMobileNodeTapIntent(node: {
  type: string
  data?: Record<string, unknown> | null
}): MobileNodeTapIntent {
  const data = node.data ?? {}
  if (node.type === 'audio') {
    return typeof data.url === 'string' && data.url ? 'inline' : 'editor'
  }
  if (node.type === 'text') {
    const content = data.content
    return typeof content === 'string' && content.trim() ? 'viewer' : 'editor'
  }
  const url = data.url
  return typeof url === 'string' && url ? 'viewer' : 'editor'
}
```

## Task 2：NodeRenderer 消费策略 + 空音频 tile 改道

**RED** — `NodeRenderer.policy.test.ts`（静态契约，同 R1 `NodeRenderer.test.ts` 风格）：断言 `NodeRenderer.vue` 引用 `resolveMobileNodeTapIntent` 且 `onTileOpen` 按意图分流；断言 `MobileNodeTile.vue` 音频分支空 url 时 `emit('tap')`。

**GREEN**：
- `NodeRenderer.vue`：`inject(MOBILE_NODE_OPEN_EDITOR_KEY)`；`onTileOpen` 先算意图——`editor` → `openEditor({id,type,data})`；否则 `openViewer(...)`。
- `canvasNodeActions.ts`：新增 `MOBILE_NODE_OPEN_EDITOR_KEY` + `MobileNodeOpenEditorFn`（与 VIEWER 键同构）。
- `MobileNodeTile.vue`：`onTileClick` 音频分支——`props.data?.url` 为空时 `emit('tap')` 交策略，不再 `toggleAudio()`。

## Task 3：新建流闭环（FAB+ → 新节点 → 编辑 sheet）

**RED** — `CanvasPage.mobileCreateLoop.test.ts`（静态契约）：断言 `handleDockAdd` 函数体内含 `isMobileLayout` 分支与 `openMobileNodeEditor(id)` 调用；断言 `provide(MOBILE_NODE_OPEN_EDITOR_KEY, ...)` 存在且回调设 `mobileEditorNode`。

**GREEN** — `CanvasPage.vue`：
- `handleDockAdd`：`if (isMobileLayout.value) openMobileNodeEditor(id)`（在 `focusNodeById` 后；PC 路径不变）。
- `provide(MOBILE_NODE_OPEN_EDITOR_KEY, (node) => { if (node?.id) openMobileNodeEditor(node.id) })`。

## Self-Review（每任务完成时）

- [ ] PC 路径零 diff（`git diff origin/master...HEAD -- '*DockStudioToolbar*'` 为空）
- [ ] R1 既有测试全绿（mobile 套件 + NodeRenderer + CanvasPage 契约）
- [ ] 纯函数单测覆盖四条类型 × 空/非空
- [ ] `vue-tsc --noEmit` 干净；令牌守卫三件套绿
- [ ] commit message 标注「R2-T<n>」与复用的真源（handleDockAdd / MobileNodeEditorSheet）

## 不在本 release（防范围蔓延）

- D-C 的 `generating/pending/error` 三行与 `MobileNodeStatusBar`（Release 3）
- D-D 波形后端契约与前端占位（P4 并行项，独立分支）
- 文本节点 composer 权重等 IA v4 议题（已裁决未实施族）
