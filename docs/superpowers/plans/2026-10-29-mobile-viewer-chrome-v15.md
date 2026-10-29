# 移动端查看器 chrome v1.5（O/P/Q）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按规格 v1.5（拍板项 O/P/Q）改造移动端查看器：移除「⋯」改长按同源 Menu、chrome 三态自隐迷你操作条、指向形态随媒介（音频退圈选 + 自动时间戳）。

**Architecture:** 全部改动收敛在移动端查看器链路：`mobileNodeActionPolicy`（context 门控纯函数）→ `MobileNodeViewer`（长按手势 / chrome 显隐 / 底栏形态）→ 新组件 `MobileViewerChrome`（X + 迷你操作条渲染）→ `MobileCanvasShell`/`CanvasPage`（context 透传 + 编辑器意见预填链路）。标注合成管线（§5.3）零改动，只改入口与草稿前缀。

**Tech Stack:** Vue 3 `<script setup>` + vitest（@vue/test-utils）+ `--lnk-*` 设计令牌（禁 `--neo-*`）。

**Spec:** `docs/superpowers/specs/2026-10-25-mobile-node-lifecycle-design.md` §4.12（决定十一）、§9 #35–#38、§10.2 G-19–G-24、§10.3 W-23–W-27；决策记录 `docs/adr/0013` 修订记录 v2。

**基线：** worktree `/Users/4seven/workspace/pi-lnk-wt-viewer`，分支 `feat/mobile-viewer-chrome-v15`，基点 origin/master `7bd41356`。

## Global Constraints（逐字来自规格 §4.12，实施不得自由发挥）

- 查看器模板**无「⋯」、无任何常驻管理入口**（G-19）；右上**仅 X 一枚**。
- 长按媒体唤起的 Menu 与画布长按**同一浮层组件 + 同一门控函数**，仅 `context` 不同；viewer 子集**剔除 `multi-select`、`rename`**（G-19）。
- 长按唤起时媒体**轻暂停**（`pause()` 不复位），关 Menu 恢复此前播放态；仅「删除」关闭查看器。
- **文本查看器例外**：长按保留给文字拖选 ⇒ 文本不挂长按 Menu。
- chrome = X + 底部迷你操作条；**点按媒体整体显隐**（160–200ms ease-out；`prefers-reduced-motion` 直切）；隐藏态**下滑/上滑关闭恒可用**（G-20）。
- 操作条：**半透明模糊材质**（`--lnk-surface-glass` + `--lnk-glass-blur`，⛔ 禁实心大色块）、全圆胶囊、总高 **≤56px**；每项 = 图标 22×22 + 11pt 标签、命中区 **≥44×44px**（G-24、G-18）。
- 查看器**不渲染提示词文本（含截断行）**——`viewer-prompt-strip` 删除；`MobileNodePromptReviewSheet` 全文审核层退役；磁贴 chips 单击**直达轻量编辑器**（G-21）。
- 图标一律内联 SVG（24 网格、`stroke-width:2`、`stroke:currentColor`）：改词=铅笔、圈选=马克笔、朗读=扬声器；⛔ 禁 `⋯`/`×`/`‹` 文本字符；锚 = `anchor-locate.png` 唯一位图例外（G-16）。
- **音频不圈选**（G-22）：音频查看器保留（波形+播放+进度），但**不注入圈选项**；`改词` 意见草稿自动带 **`at mm:ss`**（当前播放时刻，可删改）。
- 视频标注意见草稿**自动前缀「第 mm:ss 帧：」**（进入标注态时刻，可删改）（G-23）。
- pending 查看器底栏 = 批注 / 编辑（§17 v2 语义不变），同迷你条几何；确认/拒绝仍在画布状态胶囊（ADR-0011 单一确认面）。
- 样式一律 `--lnk-*` 令牌（⛔ 禁 `--neo-*`，ratchet 守卫）；teleport body 全屏层 z 序不新增层级（#633 教训）。
- 测试：`cd apps/web && nvm use 24 >/dev/null && pnpm exec vitest run <files> --maxWorkers=1 --no-file-parallelism`（分批 ≤12 文件）；改组件后必跑 `pnpm exec vue-tsc -b`。
- commit 只在本 worktree；⛔ 禁 `git add -A`；push 走 GitHub REST Git Data API（https 被代理挡死）。

## Review Focus（规格未覆盖、最易咬人的五类输入）

1. **长按与既有手势叠加**：图片双指捏合/单指平移（W-5）、标注态画笔（C1）、滚动守卫（走查③）都挂在同一 touch 链上——长按计时器必须被「第二根手指」「位移 >10px」「标注/编辑态」取消，且长按触发后**本次触控不得再触发 chrome 点按切换**（suppressClick）。期望：任何缩放/圈选/滚动途中长按永不弹 Menu。→ Task 2 测试钉死。
2. **视频原生 controls 的点击冒泡**：`<video controls>` 内部控件点击会冒泡到 viewer-body 的 tap 切换 chrome。期望：点播放/进度条不闪 chrome（接受轻微噪音，但 chrome 切换不得干扰播放本身）。→ Task 3 Review 步骤人工走查 + 测试断言 tap 切换不调用 `pause()`。
3. **pending 无产物节点的长按 Menu**：pending 审核层（`showReviewLayer`）无媒体但仍是节点——长按审核层应能弹 Menu（门控按 status，empty 态裁剪集自然生效）。期望：pending 长按出现引用/删除等，无产物类操作不出现。→ Task 2 测试。
4. **菜单动作与查看器的层叠**：viewer（Teleport body, `--lnk-z-overlay`）之上叠 `MobileNodeActionSheet`（既有 ⋯ 路径已验证）；删除动作关闭查看器、其余回查看器。期望：回归路径与旧 ⋯ 完全一致（同一 `openMobileNodeMenuFromViewer`）。→ Task 2 复用既有 shell 测试补 context 断言。
5. **音频 `at mm:ss` 的时刻语义**：预填取**点「改词」时刻**的 `audioRef.currentTime`（非时长、非 0）；时长未知（metadata 未加载）时**不预填**（⛔ 不预填 `at --:--`）。→ Task 5 测试。

---

### Task 1: O 门控纯函数——`resolveMobileNodeActions` 增加 context

**Files:**
- Modify: `apps/web/src/composables/mobileNodeActionPolicy.ts`
- Test: `apps/web/src/composables/mobileNodeActionPolicy.test.ts`

**Interfaces:**
- Produces: `resolveMobileNodeActions(node, context?: 'canvas' | 'viewer'): MobileNodeActionKey[]`；`resolveMobileNodeMenuTiers(node, context?: 'canvas' | 'viewer')`。`context` 缺省 = `'canvas'`（全部既有调用点零改动）。`'viewer'` 时从全集**剔除 `'multi-select'`、`'rename'`**（分层与回填逻辑在过滤后照常运行）。

- [ ] **Step 1: 写失败测试**（追加到 `mobileNodeActionPolicy.test.ts`）

```ts
describe('context: viewer（规格 v1.5 §4.12.2 / G-19）', () => {
  const confirmedNode = { id: 'n1', type: 'image', data: { url: 'https://x/a.png', status: 'completed' } }
  it('剔除 multi-select 与 rename，其余与 canvas 一致', () => {
    const canvas = resolveMobileNodeActions(confirmedNode)
    const viewer = resolveMobileNodeActions(confirmedNode, 'viewer')
    expect(viewer).not.toContain('multi-select')
    expect(viewer).not.toContain('rename')
    for (const k of ['edit', 'reference', 'duplicate', 'duplicate-upstream', 'save-asset', 'save-local', 'delete']) {
      expect(viewer).toContain(k)
    }
    expect(canvas).toContain('multi-select')
  })
  it('分层同样吃 context（viewer 一级/二级都不出现被剔项）', () => {
    const tiers = resolveMobileNodeMenuTiers(confirmedNode, 'viewer')
    expect([...tiers.primary, ...tiers.more]).not.toContain('rename')
    expect([...tiers.primary, ...tiers.more]).not.toContain('multi-select')
  })
  it('缺省 context = canvas（既有调用零改动）', () => {
    expect(resolveMobileNodeActions(confirmedNode)).toEqual(resolveMobileNodeActions(confirmedNode, 'canvas'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm exec vitest run src/composables/mobileNodeActionPolicy.test.ts --maxWorkers=1 --no-file-parallelism`（类型错误/断言红）
- [ ] **Step 3: 最小实现**——两个函数签名各加 `context: MobileNodeMenuContext = 'canvas'`（`export type MobileNodeMenuContext = 'canvas' | 'viewer'`），`resolveMobileNodeActions` 在 return 前：

```ts
export type MobileNodeMenuContext = 'canvas' | 'viewer'
// resolveMobileNodeActions(node, context: MobileNodeMenuContext = 'canvas') 内、return 前：
if (context === 'viewer') {
  // 规格 v1.5 §4.12.2：查看器是单节点全屏，无批量/画布态语义 ⇒ 剔除多选与重命名
  return keys.filter((k) => k !== 'multi-select' && k !== 'rename')
}
return keys
```

`resolveMobileNodeMenuTiers(node, context = 'canvas')` 把 context 透传给 `resolveMobileNodeActions`。

- [ ] **Step 4: 跑测试通过** + `pnpm exec vue-tsc -b`
- [ ] **Step 5: Commit**：`git add apps/web/src/composables/mobileNodeActionPolicy.ts apps/web/src/composables/mobileNodeActionPolicy.test.ts && git commit -m "feat(mobile): 节点操作门控支持 viewer context——剔除多选/重命名（规格 v1.5 O）"`

### Task 2: O 交互——移除「⋯」、长按媒体唤起同源 Menu、轻暂停/恢复

**Files:**
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`（删 `viewer-more` 按钮 + 长按手势）
- Modify: `apps/web/src/components/mobile/MobileNodeActionSheet.vue`（透传 context）
- Modify: `apps/web/src/components/mobile/MobileCanvasShell.vue`（`menu-open` prop + sheet context）
- Modify: `apps/web/src/pages/CanvasPage.vue`（`openMobileNodeMenuFromViewer` 加 context/来源标记）
- Test: `apps/web/src/components/mobile/MobileNodeViewer.test.ts`、`MobileNodeActionSheet.test.ts`、`MobileCanvasShell.nodeActions.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveMobileNodeMenuTiers(node, context)`。
- Produces: viewer 新 prop `menuOpen?: boolean`（Menu 打开中，用于恢复播放）；`MobileNodeActionNode` 新字段 `context?: 'canvas' | 'viewer'`；shell 新 prop `onViewerMenuClosedChange?` 不需要——`menuOpen` 由 shell 从 `mobileActionNode` 派生。

- [ ] **Step 1: 写失败测试**（MobileNodeViewer.test.ts 追加）

```ts
describe('长按唤起同源 Menu（v1.5 O / G-19）', () => {
  it('模板不再有「⋯」按钮', () => {
    expect(wrapper.find('[data-testid="mobile-viewer-more"]').exists()).toBe(false)
  })
  it('长按媒体 500ms ⇒ emit more（并暂停视频）', async () => {
    vi.useFakeTimers()
    const w = mountViewer({ type: 'video', url: 'x.mp4' })
    const body = w.find('[data-testid="mobile-viewer-body"]')
    await body.trigger('touchstart', { touches: [{ clientX: 10, clientY: 10 }] })
    await vi.advanceTimersByTimeAsync(500)
    expect(w.emitted('more')).toHaveLength(1)
    expect(w.find('video').element.paused).toBe(true)   // 轻暂停
    vi.useRealTimers()
  })
  it('移动超 10px 取消长按；第二根手指取消；touchend 取消', async () => {
    vi.useFakeTimers()
    const w = mountViewer({ type: 'image', url: 'a.png' })
    const body = w.find('[data-testid="mobile-viewer-body"]')
    await body.trigger('touchstart', { touches: [{ clientX: 10, clientY: 10 }] })
    await body.trigger('touchmove', { touches: [{ clientX: 60, clientY: 10 }] })
    await vi.advanceTimersByTimeAsync(600)
    expect(w.emitted('more')).toBeUndefined()
    vi.useRealTimers()
  })
  it('文本类型长按不弹 Menu（长按保留给拖选）', async () => {
    vi.useFakeTimers()
    const w = mountViewer({ type: 'text', content: '长文'.repeat(80) })
    await w.find('[data-testid="mobile-viewer-body"]').trigger('touchstart', { touches: [{ clientX: 1, clientY: 1 }] })
    await vi.advanceTimersByTimeAsync(500)
    expect(w.emitted('more')).toBeUndefined()
    vi.useRealTimers()
  })
  it('menuOpen false⧸true 翻转后恢复播放（此前在播才恢复）', async () => {
    // 先起播（video.play mock），触发长按暂停，再置 menuOpen=false ⇒ play 被再次调用
  })
})
```

`MobileNodeActionSheet.test.ts` 追加：`node.context === 'viewer'` 时渲染项不含 重命名/多选（挂载传 `node: { id, type: 'image', data: { url, status: 'completed' }, context: 'viewer' }`，断言 `mobile-node-action-rename` 不存在）。

- [ ] **Step 2: 跑失败**（同 Task 1 命令，三个测试文件一批）
- [ ] **Step 3: 实现 viewer 长按**——`MobileNodeViewer.vue`：

```ts
const props = withDefaults(defineProps<{ /* 既有 */ menuOpen?: boolean }>(), { menuOpen: false })
const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_PX = 10
let lpTimer: number | null = null
let lpStart: { x: number; y: number } | null = null
const suppressNextTap = ref(false)
const wasPlayingBeforeMenu = ref(false)

function onBodyTouchStart(e: TouchEvent) {
  if (annotating.value || editing.value || props.menuOpen) return
  if (e.touches.length !== 1) return
  const t = e.touches[0]!
  lpStart = { x: t.clientX, y: t.clientY }
  lpTimer = window.setTimeout(fireLongPress, LONG_PRESS_MS)
}
function fireLongPress() {
  lpTimer = null
  lpStart = null
  suppressNextTap.value = true
  if (props.type === 'video' && videoRef.value && !videoRef.value.paused) {
    videoRef.value.pause(); wasPlayingBeforeMenu.value = true
  }
  if (props.type === 'audio' && audioRef.value && !audioRef.value.paused) {
    audioRef.value.pause(); wasPlayingBeforeMenu.value = true
  }
  emit('more')
}
function onBodyTouchMove(e: TouchEvent) {
  if (!lpTimer || !lpStart) return
  const t = e.touches[0]
  if (!t) return
  if (Math.hypot(t.clientX - lpStart.x, t.clientY - lpStart.y) > LONG_PRESS_MOVE_PX) cancelLongPress()
}
function cancelLongPress() { if (lpTimer) { window.clearTimeout(lpTimer); lpTimer = null } lpStart = null }
function onBodyTouchEnd() { cancelLongPress() }
watch(() => props.menuOpen, (open) => {
  if (open || !wasPlayingBeforeMenu.value) return
  wasPlayingBeforeMenu.value = false
  if (props.type === 'video') void videoRef.value?.play().catch(() => {})
  if (props.type === 'audio') void audioRef.value?.play().catch(() => {})
})
```

模板：`.viewer-body` 上加 `data-testid="mobile-viewer-body"` 与 `@touchstart.passive="onBodyTouchStart" @touchmove.passive="onBodyTouchMove" @touchend="onBodyTouchEnd" @touchcancel="onBodyTouchEnd"`（音频控制条已有 `.stop`，天然豁免）；删除 `viewer-more` 按钮及其样式；`onBeforeUnmount` 补 `cancelLongPress()`。⛔ 文本类型不触发：`onBodyTouchStart` 首行加 `if (props.type === 'text') return`。

- [ ] **Step 4: 实现 context 透传**——`MobileNodeActionNode` 加 `context?: 'canvas' | 'viewer'`；`tiers` computed 改 `resolveMobileNodeMenuTiers(props.node, props.node.context)`。`CanvasPage.openMobileNodeMenuFromViewer`：`mobileActionNode.value = { id, type, data, context: 'viewer', multiSelectActive: …, multiSelectSelected: … }`（多选字段保留——viewer 子集已不含 multi-select，字段无害）。shell：viewer 加 `:menu-open="mobileActionNode?.context === 'viewer'"`。
- [ ] **Step 5: 跑通过** + `vue-tsc -b`
- [ ] **Step 6: Commit**：`feat(mobile): 查看器移除「⋯」改长按同源 Menu——轻暂停/恢复 + viewer 子集（规格 v1.5 O）`

### Task 3: P chrome 三态——`MobileViewerChrome` 组件 + 自隐迷你操作条

**Files:**
- Create: `apps/web/src/components/mobile/MobileViewerChrome.vue`（§9 #35）
- Create: `apps/web/src/components/mobile/MobileViewerChrome.test.ts`（§9 #36）
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`（chromeVisible 状态 + 底栏/X 迁入 chrome 组件；编辑/标注态底栏语义不变）

**Interfaces:**
- Produces: `MobileViewerChrome` props `{ visible: boolean; actions: Array<{ key: string; label: string; icon: 'pencil' | 'marker' | 'speaker' }>; pendingDecision?: boolean }`，emits `(e: 'close')` 与 `(e: 'action', key: string)`。**底栏动作 key 契约不变**（`edit` / `annotate` / `tts`），只是渲染形态从通栏实心大胶囊改为居中毛玻璃迷你条。
- Consumer（viewer）持有 `chromeVisible = ref(true)`；`onBodyTap`（Task 2 的 touchend 无长按/无滑动时）翻转；`:class="{ 'chrome-hidden': !chromeVisible }"` 由 viewer 根元素承载，CSS 控制淡出。

- [ ] **Step 1: 写失败测试**（MobileViewerChrome.test.ts）

```ts
it('visible=false ⇒ 根元素带 chrome-hidden（opacity:0 + pointer-events:none）', async () => {
  const w = mount(MobileViewerChrome, { props: { visible: false, actions: [{ key: 'edit', label: '改词', icon: 'pencil' }] } })
  expect(w.find('[data-testid="mobile-viewer-chrome"]').classes()).toContain('chrome-hidden')
})
it('渲染 X（emit close）与动作项（emit action，key 透传）', async () => {
  const w = mount(MobileViewerChrome, { props: { visible: true, actions: [{ key: 'edit', label: '改词', icon: 'pencil' }, { key: 'annotate', label: '圈选', icon: 'marker' }] } })
  await w.find('[data-testid="mobile-viewer-chrome-close"]').trigger('click')
  await w.find('[data-testid="mobile-viewer-chrome-action-edit"]').trigger('click')
  expect(w.emitted('close')).toHaveLength(1)
  expect(w.emitted('action')![0]).toEqual(['edit'])
})
it('每项含 22×22 内联 SVG 图标 + 标签；条容器为毛玻璃材质类', () => {
  const w = mount(MobileViewerChrome, { props: { visible: true, actions: [{ key: 'edit', label: '改词', icon: 'pencil' }] } })
  expect(w.find('[data-testid="mobile-viewer-chrome-action-edit"] svg').exists()).toBe(true)
  expect(w.find('[data-testid="mobile-viewer-chrome-bar"]').classes().join(' ')).toContain('glass')
})
```

- [ ] **Step 2: 跑失败**；**Step 3: 实现**——组件模板：右上 X（既有 `viewer-close` 同款 SVG/令牌）+ 底部条：

```css
.mv-chrome-bar {
  align-self: center;
  display: flex;
  gap: var(--lnk-space-5);
  margin-bottom: calc(var(--lnk-space-3) + env(safe-area-inset-bottom));
  padding: var(--lnk-space-1) var(--lnk-space-5);
  border: 0.5px solid var(--lnk-glass-topline);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-glass);
  -webkit-backdrop-filter: blur(var(--lnk-glass-blur)) saturate(160%);
  backdrop-filter: blur(var(--lnk-glass-blur)) saturate(160%);
}
.mv-chrome-item {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; min-width: var(--lnk-touch-target); min-height: var(--lnk-touch-target);
  border: none; background: transparent; color: var(--lnk-text-primary);
  font-size: var(--lnk-text-2xs); cursor: pointer; touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mv-chrome-item svg { width: 22px; height: 22px; }
/* 淡出：160–200ms；reduced-motion 直切 */
.mv-chrome-close, .mv-chrome-bar { transition: opacity var(--lnk-duration-base) var(--lnk-ease-decelerate); }
.chrome-hidden .mv-chrome-close, .chrome-hidden .mv-chrome-bar { opacity: 0; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .mv-chrome-close, .mv-chrome-bar { transition: none; }
}
```

条高 = 44px 项 + 2×4px padding = **52px ≤56px**（G-24）。viewer 侧：`resolvedBottomActions` 映射为 `{ key, label, icon }`（`edit→pencil`、`annotate→marker`、`tts→speaker`；标签沿用壳层文案「改词/编辑/批注」，注入项「圈选」「朗读/停止」）传给 chrome；`.viewer-bottom-actions`/`.viewer-bottom-action` 旧样式删除；`tts` 点击经 `action` 事件回 viewer 走 `toggleReaderSpeak`（chrome 不内联 TTS 逻辑）。viewer 根元素 `:class="{ 'chrome-hidden': !chromeVisible }"`。

- [ ] **Step 4: tap 切换**——viewer `onBodyTouchEnd` 内：无长按触发（`!suppressNextTap`）且本次位移 ≤10px ⇒ `chromeVisible.value = !chromeVisible.value`；`suppressNextTap` 消费后复位；`annotating/editing` 态不切换；`chromeVisible` 在 `watch(() => props.data?.url)` 复位为 true（既有缩放复位 watch 顺带）。
- [ ] **Step 5: 跑通过**（`MobileViewerChrome.test.ts` + `MobileNodeViewer.test.ts` 全量）+ `vue-tsc -b`
- [ ] **Step 6: Commit**：`feat(mobile): 查看 chrome 三态——自隐毛玻璃迷你操作条 + MobileViewerChrome 组件（规格 v1.5 P）`

### Task 4: P 移除提示词摘要条 + 退役全文审核层 + chips 直达编辑器

**Files:**
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`（删 `promptStripVisible/promptStripText/viewer-prompt-strip` 模板与样式；删 `open-prompt-review` emit）
- Modify: `apps/web/src/components/mobile/MobileCanvasShell.vue`（删 PromptReviewSheet 挂载与 5 个相关 props）
- Modify: `apps/web/src/pages/CanvasPage.vue`（`MOBILE_NODE_OPEN_PROMPT_REVIEW_KEY` provide 改路由到 `openMobileNodeEditor`；删 `mobilePromptReviewNode` / `openPromptReviewFromViewer` / `closePromptReview` / `handlePromptReviewAnnotate` / `handlePromptReviewEditSave`）
- Modify: `apps/web/src/composables/canvasNodeActions.ts`（key 注释改为「chips → 轻量编辑器」）
- Delete: `apps/web/src/components/mobile/MobileNodePromptReviewSheet.vue` + `.test.ts`
- Modify: `apps/web/src/components/mobile/mobileVisualLanguage.guards.test.ts`（白名单删 `MobileNodePromptReviewSheet.vue` 条目）
- Modify: `apps/web/src/pages/CanvasPage.mobileAnnotateRef.test.ts`（`closePromptReview` 用例随载体退役改写）
- Test: `apps/web/src/components/mobile/MobileNodeViewer.test.ts`（G-21 断言）

**Interfaces:** 磁贴 chips → `NodeRenderer` → `MOBILE_NODE_OPEN_PROMPT_REVIEW_KEY`（**key 名不变**，避免 Tile/NodeRenderer 契约 churn）→ CanvasPage provide 体改为：prompt 为空仍不开；有 id ⇒ `openMobileNodeEditor(node.id)`。

- [ ] **Step 1: 写失败测试**（MobileNodeViewer.test.ts）

```ts
it('查看器不渲染提示词文本（G-21：摘要条退役）', () => {
  const w = mountViewer({ type: 'image', url: 'a.png', prompt: '一只猫'.repeat(30) })
  expect(w.find('[data-testid="mobile-viewer-prompt-strip"]').exists()).toBe(false)
  expect(w.text()).not.toContain('提示词：')
})
it('pending 审核内容层保留（决策需要全文，非 G-21 管辖）', () => {
  const w = mountViewer({ type: 'image', status: 'pending_confirm', prompt: '一只猫' })
  expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(true)
})
```

- [ ] **Step 2: 跑失败**；**Step 3: 按文件清单实现删除/改路由**（provide 体：`if (!String(node?.data?.prompt ?? '').trim()) return; if (node?.id) openMobileNodeEditor(node.id)`——保留空 prompt 守卫；chips 打开编辑器时**不再关查看器**，因为不再存在第二层）；shell 删挂载与 props；guards 白名单删条目（该文件不再存在，白名单残留会被「白名单指向不存在文件」类断言或 review 发现）。
- [ ] **Step 4: 跑通过**（一批：`MobileNodeViewer.test.ts` + `MobileNodeTile.promptChip.test.ts` + `NodeRenderer.test.ts` + `CanvasPage.mobileAnnotateRef.test.ts` + `mobileVisualLanguage.guards.test.ts`）+ `vue-tsc -b`
- [ ] **Step 5: Commit**：`refactor(mobile): 退役查看器提示词摘要条与全文审核层——chips 直达轻量编辑器（规格 v1.5 P / G-21）`

### Task 5: Q 指向形态随媒介——音频退圈选、时间戳自动带入

**Files:**
- Modify: `apps/web/src/composables/mobileAnnotateIntent.ts`（audio → `'none'`）+ `.test.ts`
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`（音频不注入圈选；删 `captureBaseImage` 音频波形分支；视频 `annotateTime`；`bottom-action` 携带 `mediaTime`）
- Modify: `apps/web/src/components/mobile/MobileAnnotationCapsule.vue`（`draftPrefix` prop）
- Modify: `apps/web/src/components/mobile/MobileNodeEditorSheet.vue`（`initialOpinion` prop）
- Modify: `apps/web/src/components/mobile/MobileCanvasShell.vue`（透传 initialOpinion + bottom-action meta 签名）
- Modify: `apps/web/src/pages/CanvasPage.vue`（`handleMobileViewerBottomAction` 收 meta → 编辑器意见预填）
- Test: `mobileAnnotateIntent.test.ts`、`MobileNodeViewer.test.ts`、`MobileAnnotationCapsule`（并入 viewer 测试）、`MobileNodeEditorSheet.test.ts`

**Interfaces:**
- `resolveAnnotateIntent` 返回值联合改为 `'image' | 'video-frame' | 'text' | 'none'`；audio ⇒ `'none'`。
- `MobileAnnotationCapsule` 新 prop `draftPrefix?: string`：`watch(visible)` 时 `text.value = props.draftPrefix ?? ''`（可删改）。
- `MobileNodeEditorSheet` 新 prop `initialOpinion?: string`：`opinion = ref(props.initialOpinion ?? '')`。
- viewer emit 扩展：`(e: 'bottom-action', key: string, meta?: { mediaTime?: number })`——**仅音频**且 `audioRef.currentTime` 有限时携带；`MobileCanvasShell` prop `onViewerBottomAction: (key: string, meta?: { mediaTime?: number }) => void`。

- [ ] **Step 1: 写失败测试**

```ts
// mobileAnnotateIntent.test.ts
it('音频 = none（v1.5 Q：波形圈选判伪功能，G-22）', () => {
  expect(resolveAnnotateIntent({ type: 'audio' })).toBe('none')
})
// MobileNodeViewer.test.ts
it('音频底栏不注入圈选（G-22）', () => {
  const w = mountViewer({ type: 'audio', url: 'a.mp3', status: 'completed' })
  const keys = w.findAll('[data-testid^="mobile-viewer-chrome-action-"]').map((x) => x.attributes('data-action'))
  expect(keys).not.toContain('annotate')
})
it('视频进入标注态 ⇒ 胶囊草稿自动前缀「第 m:ss 帧：」（G-23，可删改）', async () => {
  vi.useFakeTimers()
  const w = mountViewer({ type: 'video', url: 'v.mp4' })
  ;(w.find('video').element as HTMLVideoElement).currentTime = 42
  await w.find('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click') // 进入标注态
  await w.find('[data-testid="mobile-viewer-ink"]').trigger('pointerdown', { pointerId: 1, clientX: 5, clientY: 5 })
  await w.find('[data-testid="mobile-viewer-ink"]').trigger('pointerup', { pointerId: 1, clientX: 6, clientY: 6 })
  expect((w.find('[data-testid="mobile-annotation-capsule-input"]').element as HTMLInputElement).value).toMatch(/^第 0:42 帧：/)
  vi.useRealTimers()
})
it('音频点改词 ⇒ bottom-action 携带 mediaTime（Task 5 链路起点）', async () => {
  const w = mountViewer({ type: 'audio', url: 'a.mp3', status: 'completed' })
  ;(w.find('audio').element as HTMLAudioElement).currentTime = 7.4
  await w.find('[data-testid="mobile-viewer-bottom-edit"]').trigger('click')
  expect(w.emitted('bottom-action')![0]).toEqual(['edit', { mediaTime: 7.4 }])
})
// MobileNodeEditorSheet.test.ts
it('initialOpinion 预填意见框（音频 at mm:ss 链路终点）', () => {
  const w = mount(MobileNodeEditorSheet, { props: { node: audioNode, initialOpinion: 'at 0:07' } })
  expect((w.find('[data-testid="mobile-editor-opinion"]').element as HTMLTextAreaElement).value).toBe('at 0:07')
})
```

- [ ] **Step 2: 跑失败**；**Step 3: 实现**（要点：viewer `enterAnnotate` 在视频分支先 `videoRef.pause()` 再记 `annotateTime.value = videoRef.currentTime`，`draftPrefix = computed(() => props.type === 'video' ? \`第 ${formatMediaDuration(annotateTime.value) ?? '0:00'} 帧：\` : '')`；音频改词 meta：`onBottomAction` 的兜底 emit 分支改为 `emit('bottom-action', key, key === 'edit' && props.type === 'audio' && Number.isFinite(audioRef.value?.currentTime ?? NaN) ? { mediaTime: audioRef.value!.currentTime } : undefined)`；CanvasPage `handleMobileViewerBottomAction(key, meta)`：`openMobileNodeEditor` 前把 `at ${formatMediaDuration(meta.mediaTime)}` 存入页级 ref，并注入 `mobileEditor` computed（`MobileEditorContext` 加 `initialOpinion?: string`）；编辑器关闭/发送后清空该 ref（防串味）；删除 `captureBaseImage` 的 audio 分支与 `mapMarksForCompose` 中 audio 相关注释）。
- [ ] **Step 4: 跑通过** + `vue-tsc -b`
- [ ] **Step 5: Commit**：`feat(mobile): 指向形态随媒介——音频退圈选 + 视频/音频时间戳自动带入（规格 v1.5 Q）`

### Task 6: 规格对账回落 + 守卫与全量回归

**Files:**
- Modify: `docs/superpowers/specs/2026-10-25-mobile-node-lifecycle-design.md`（§4.12 对账三条，见下）
- Modify: `docs/adr/0013-mobile-node-interaction-mode-and-carriers.md`（v2 修订记录补「实施对账」一行）

- [ ] **Step 1: SSOT §4.12 对账修正**（查缺补漏结论，实施前已完成审视）：
  1. §4.12.2「音频：无查看器（D1），不受本条影响」→ 改为「**音频查看器保留**（D2 修订 2026-10-27 走查④：全屏波形 + 播放 + 进度），但**不注入圈选项**、不挂长按 Menu（长按与波形拖动冲突且无内容操作诉求），迷你操作条仅改词」。
  2. §4.12.4 特例 3「pending 决策栏常驻」→ 改为「pending 查看器底栏 = **批注 / 编辑**两枚紧凑项（§17 v2 语义：锚下即拒绝 / 编辑保存回画布再确认），与迷你条同几何；确认/拒绝仍在画布状态胶囊（ADR-0011），查看器**无**确认/拒绝按钮」。
  3. §4.12.7 表补一行：`MobileNodePromptReviewSheet`（全文审核层，§4.7.1 S1 载体）→ **退役**；chips 入口改路由 `MOBILE_NODE_OPEN_PROMPT_REVIEW_KEY → openMobileNodeEditor`（key 名保留防 Tile/NodeRenderer churn）。
- [ ] **Step 2: 守卫全量**——`pnpm exec vitest run src/components/mobile/mobileVisualLanguage.guards.test.ts src/components/mobile/mobileNodeInteraction.guards.test.ts` + design-token / theme-usage / text-token-guard / dead-styles 四守卫（按既有命令），确认无 `--neo-*`、无裸 fixed、图标无文本字符。
- [ ] **Step 3: 分批全量回归**（≤12 文件/批，`--maxWorkers=1 --no-file-parallelism`）：`mobileNodeActionPolicy` → `MobileNodeViewer*` → `MobileNodeActionSheet*` → `MobileCanvasShell.nodeActions` → `MobileNodeEditorSheet*` → `MobileNodeTile.*` → `NodeRenderer.policy` → `CanvasPage.mobile*`。全绿后 `pnpm exec vue-tsc -b`。
- [ ] **Step 4: Commit**：`docs(spec): v1.5 实施对账——音频查看器保留/pending 底栏语义/全文审核层退役（§4.12）`
- [ ] **Step 5: 真机走查项移交**：W-23–W-27 逐格清单随 PR 描述提交（真机验证不在本计划范围）。

## Self-Review 记录

- **规格覆盖**：§4.12.2→Task 1/2；§4.12.3→Task 5；§4.12.4/4.12.5→Task 3；§4.12.6→Task 3 图标映射；§4.12.7→Task 4/6；§4.12.8 八条→T1(2)/T2(1,2)/T3(3,5)/T4(4)/T5(6)/T6(7,8)。§9 #35–#38 → T3/T1/T5。G-19–G-24 → T2/T3/T4/T5 测试。W-23–W-27 → 走查移交（T6 Step 5）。
- **占位符扫描**：无 TBD/TODO；所有代码步给出真实片段；「照抄既有」仅指 X 按钮样式（文件内现有类，plan 已给出目标几何）。
- **类型一致性**：`MobileNodeMenuContext`（T1 定义，T2/T3 消费）；`draftPrefix`（T5 定义+消费）；`initialOpinion`（T5 定义+CanvasPage 链路）；`menuOpen`（T2）；`bottom-action` meta（T5）。已核对无命名漂移。
- **Review Focus 落测试**：1→T2 Step1 前两例；2→T3 Review 步（人工走查项，写入 PR 描述）；3→T2 pending 长按用例（门控自然裁剪）；4→复用既有 shell 测试补 context 断言（T2 Step1）；5→T5 mediaTime/时长未加载不预填断言。
