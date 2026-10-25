# 移动端节点生命周期与载体分工 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让移动端画布节点有一套单一可查的手势门控（4 类节点 × 5 态 × 2 手势 + 多选态叠加），并把模式①（agent 驱动）的主闭环在移动端打通：看产物 → 手指圈一下 → 写一句 → 锚回传 → agent 重生成。

**Architecture:** 分三个包落地。**M1 原则闭环**只改纯函数与既有组件的退出通道，不引入新组件；**M2** 分两半——「操作集补全」（在既有动作 sheet 上加三项 + 加状态门控 + 删除确认）与「载体改造」（新建轻量编辑器 + 标注浮层，拆掉 `MobileNodeEditorSheet` 对 `DockStudioRouter` 的复用）；**M3** 补行为级守卫与真机走查清单。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript、vitest（jsdom）、Pinia、vue-flow、原生 canvas（标注合成）、`@lnkpi/shared` 的 `SidebarAttachment` 契约。

**Spec:** `docs/superpowers/specs/2026-10-25-mobile-node-lifecycle-design.md`（规范真相源，876 行）——执行者须同时读它与 `docs/adr/0013-mobile-node-interaction-mode-and-carriers.md`（决策真相源）。
**原始评审稿（归档）：** `docs/superpowers/specs/2026-10-25-mobile-node-lifecycle-review-draft.md`（只作决策追溯，实施不依据）。

---

## Global Constraints

以下约束**逐条来自规格**，每个任务的隐含要求都包含本节。

- **G-1 移动端 tap 永不进编辑器**：空节点 / generating / error(无旧产物) 的 tap = 无 op + 轻提示「长按编辑 / 长按撰写」；pending / confirmed 的 tap = 查看。（规格 §5.1）
- **G-2 长按是唯一管理入口**：所有节点管理操作只从长按动作 sheet 进；本体不铺胶囊按钮、不铺锚按钮。（规格 §4.4 第 3 点、§4.6）
- **G-3 全屏层必须可退**：查看器与编辑 sheet 同时具备「右上 X」与「下滑关闭」；退出即停（视频 `pause()`、朗读停止）。（规格 §4.1 P3）
- **G-4 模式① 移动端编辑器无参数控件、无「生成」钮**：源码级断言 `MobileNodeEditorSheet.vue` 不含 `DockStudioRouter`。（规格 §4.2 J1/K1、§10.2 G-7/G-8）
- **G-5 标注只有一支笔**：只做手指自由圈选；产出「带标记的整图 + 一句文字」；不做区域裁切、不引入坐标契约、不做多工具栏。（规格 §4.3 L1）
- **G-6 标注产物是整图不是裁切图**：合成底图的尺寸必须等于底图尺寸。（规格 §10.2 G-9）
- **G-7 传送一律经锚**：标注回传按钮必须用 `assets/icons/anchor-locate.png`；不得新造图标。（规格 §4.5 P6/M1）
- **G-8 回传必须看得见落地**：切回对话页 + composer 出现芯片 + （失败时）明确 toast，三者至少其一；视频无 CORS 时**只带文字**并明说降级，不静默丢图。（规格 §4.5 可见性铁律、§10.2 G-11/G-12）
- **G-9 零新契约、零服务端改动**：标注引用复用 `SidebarAttachment` 现有字段（`mediaType` / `url` / `text` / `sourceNodeId` / `label` / `sourceKind`）；`packages/shared` 与 `apps/server` **不改一行**。（规格 §5.4、§7）
- **G-10 blob URL 不可入引用**：合成图必须先上传（`useMediaUpload.fileToPersistedPayload`）才写入 `pendingAttachments`；引用芯片需「上传中」态。（规格 §4.3 技术点 2）
- **G-11 破坏性操作**：删除 = 置底 + 红色 + **二次确认**；未确认不得删节点。（规格 §4.4、§10.2 G-5）
- **G-12 状态门控**：generating 态长按**不出现**「引用 / 副本 / 资产库 / 保存到本地」。（规格 §5.1、§6.4）
- **G-13 音频永不进查看器**：`MobileNodeViewer` 的 `type` 不含 `audio`；音频的查看走磁贴内联。（规格 §6.2）
- **G-14 不造假**：不造进度百分比（只给「N 个生成中 · 耗时」）；波形取不到真实 peaks 时保持占位；视频取不到帧时诚实降级。（规格 §5.1、§4.3）
- **G-15 设计令牌**：只消费 `apps/web/src/styles/design-tokens.css` 的 `--lnk-*` 令牌；**禁** `--neo-*`、禁裸 hex / 裸 rgba。（仓库既有纪律）
- **G-16 PC 零 diff**：本计划所有改动**只动移动端路径**（`components/mobile/**` + `composables/mobile*` + `pages/CanvasPage.vue` 的移动端分支）；PC 组件与 `apps/server` 不改。例外：`apps/web/src/components/agent/AgentSidebarRefChip.vue` 的缩略图预览是 PC/移动端共用组件 ⇒ 改动必须**只加不破**（PC 现有快照测试必须仍绿）。

**测试纪律（仓库既有，逐任务适用）：**

```bash
# 本机 vitest 必须用 nvm node 24（默认 node 20 会在 jsdom 依赖链 ERR_REQUIRE_ESM）
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run <path> --maxWorkers=1 --no-file-parallelism
# 类型检查对齐 CI（apps/web build = vue-tsc -b，非 --noEmit -p）
cd apps/web && npx vue-tsc -b
# ⚠️ 后台长跑 vitest 会占满整机 ⇒ 连 git commit 都被 SIGTERM(137) 且不报错 ⇒ 跑测试期间禁并发发命令
# ⚠️ 日志无 "EXIT=" 行 = 进程被杀（143/137），不是测试失败
cmd > /tmp/x.log 2>&1; echo EXIT=$?
```

---

## Review Focus

规格是愿景文档：它说了软件**必须**做什么，但没说每个输入都覆盖到了。以下五类输入/情形最可能咬到真实用户——每条都在其归属任务里有对应测试钉住。

1. **有旧产物但生成失败（`status:'error'` + 有 url）**：用户此时最想看的是旧产物，tap 必须进查看器而不是「无 op」；长按也必须给全集（不是受限集）——因为产物已存在，「保存到本地 / 存入资产库」是合法的。→ Task 1（`resolveMobileNodeTapIntent` 门控）+ Task 4（动作 sheet 门控）。
2. **`pending_confirm` 节点上长按**：这是 agent 刚提议、用户还没确认的节点。此时「删除」是否该二次确认、「编辑」是否该进轻量编辑器（而非 dock）？判定：`pending` 走**全集**但删除需确认、编辑进轻量编辑器。→ Task 4 + Task 6。
3. **视频节点在跨域源上标注**：`<video>` 无 CORS 头 ⇒ `drawImage` 污染 canvas ⇒ `toBlob` 抛 `SecurityError`。若不显式降级，用户会看到"点了没反应"或整条链路崩。→ Task 7（降级路径 + 明确 toast）。
4. **上传失败 / 弱网**：合成图必须先上传才能进引用（契约拒 blob）。用户点「⚓ 带回对话」后若网络慢，**不能**出现"点了没反应"，也不能提前把 blob 塞进 composer（服务端会拒）。→ Task 7（上传中态 + 失败 toast + blob 不入引用）。
5. **多选态下点已选中的节点**：应**取消选中**而不是"无反应"或"重新选中"；且多选态下长按**不得**弹单节点动作 sheet（否则退回单节点语境，破坏 selection mode 的心智）。→ Task 5。

> 另有一条**实现期易踩**的（非用户输入）：改 `MobileNodeEditorSheet` 的契约会打破既有测试断言（`DockStudioRouter` 的 `generate` emit 透传 / R4-T2 断链修复用例）⇒ Task 6 必须**同步改**那些断言，且 PR 描述要标注「本 PR 会影响 `MobileNodeEditorSheet` 相关测试」（规格 §11 R-1）。

---

## 文件结构映射

| 文件 | 职责 | 任务 |
|---|---|---|
| `apps/web/src/composables/mobileNodeOpenPolicy.ts` | 节点 → tap 意图（**引入状态门控**，D1/D3） | 1 |
| `apps/web/src/composables/mobileNodeOpenPolicy.test.ts` | 门控真值表 | 1 |
| `apps/web/src/components/mobile/MobileNodeTile.vue` | 节点本体（空瓦片 CTA 文案） | 1 |
| `apps/web/src/components/mobile/MobileNodeViewer.vue` | 全屏查看器（X + 下滑 + 停播；删 audio 死分支） | 2 |
| `apps/web/src/components/mobile/MobileNodeViewer.test.ts` | 退出通道断言 | 2 |
| `apps/web/src/components/mobile/MobileNodeActionSheet.vue` | 长按动作 sheet（新增三项 + 状态门控） | 4 |
| `apps/web/src/components/mobile/MobileNodeActionSheet.test.ts` | 操作集 + 门控断言 | 4 |
| `apps/web/src/pages/CanvasPage.vue` | 页面层分发（删除确认 / 新增三个动作 / 编辑器接线） | 3, 4, 6, 8 |
| `apps/web/src/components/mobile/MobileNodeEditorSheet.vue` | **重写**：轻量「提示词 + 意见」编辑器（不挂 `DockStudioRouter`） | 6 |
| `apps/web/src/components/mobile/MobileNodeEditorSheet.test.ts` | 契约断言（无 dock / 无生成钮 / 参数只读） | 6 |
| `apps/web/src/composables/mobileNodeActionPolicy.ts` | **新增**：节点状态 → 可用操作集（纯函数，sheet 与页面层共用） | 4 |
| `apps/web/src/composables/mobileNodeActionPolicy.test.ts` | 门控真值表 | 4 |
| `apps/web/src/composables/mobileAnnotateIntent.ts` | **新增**：节点类型 → 标注底图来源（纯函数） | 7 |
| `apps/web/src/composables/mobileAnnotateIntent.test.ts` | 底图来源真值表 | 7 |
| `apps/web/src/components/mobile/annotate/composeAnnotatedImage.ts` | **新增**：底图 + 标记 → PNG blob（纯函数） | 7 |
| `apps/web/src/components/mobile/annotate/composeAnnotatedImage.test.ts` | 合成纯函数断言 | 7 |
| `apps/web/src/components/mobile/MobileNodeAnnotateSheet.vue` | **新增**：标注浮层（意见输入 + ⚓ 带回对话 + 上传中态） | 7 |
| `apps/web/src/components/mobile/MobileNodeAnnotateSheet.test.ts` | 回传链路断言 | 7 |
| `apps/web/src/components/mobile/MobileMultiSelectBar.vue` | 已选后的底部批量条（**补**「全选 / 取消」+ 选择模式信号） | 5 |
| `apps/web/src/components/mobile/MobileMultiSelectBar.test.ts` | 选择模式断言 | 5 |
| `apps/web/src/components/agent/AgentSidebarRefChip.vue` | 标注图芯片缩略图预览（PC/移动端共用，只加不破） | 8 |
| `apps/web/src/components/canvas/annotateModel.ts` | **复用不改**：只取其「像素叠加」能力 | 7 |

---

## Task 1: tap 门控落状态（D1 / D3）

**Files:**
- Modify: `apps/web/src/composables/mobileNodeOpenPolicy.ts`
- Modify: `apps/web/src/composables/mobileNodeOpenPolicy.test.ts`
- Modify: `apps/web/src/components/mobile/MobileNodeTile.vue`

**Interfaces:**
- Consumes: `resolveMobileNodeState(node)` from `@/composables/mobileNodeState`（返回 `'empty' | 'generating' | 'pending' | 'confirmed' | 'error'`）
- Produces: `resolveMobileNodeTapIntent(node)` 返回值扩为 `'viewer' | 'editor' | 'inline' | 'none'`。**`none` = 无 op + 轻提示**（新增枚举值，调用方须处理）。

- [ ] **Step 1: 写失败测试**

改 `apps/web/src/composables/mobileNodeOpenPolicy.test.ts`（追加到既有 `describe` 内）：

```ts
import { describe, it, expect } from 'vitest'
import { resolveMobileNodeTapIntent } from './mobileNodeOpenPolicy'

describe('resolveMobileNodeTapIntent（状态门控 · D1/D3）', () => {
  it('empty 节点 tap = none（不���编辑器）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: {} })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: {} })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'image', data: null })).toBe('none')
  })

  it('generating tap = none（不重复入口，壳层状态栏已有）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'generating' } })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'fallback_pending' } })).toBe('none')
  })

  it('pending tap = viewer（确认前必须能先看）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'pending_confirm' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { status: 'pending_confirm' } })).toBe('viewer')
  })

  it('confirmed tap = viewer', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '你好' } })).toBe('viewer')
  })

  it('error 无旧产物 = none；有旧产物 = viewer（Review Focus #1）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'error' } })).toBe('none')
    expect(
      resolveMobileNodeTapIntent({ type: 'image', data: { status: 'error', url: 'https://x/a.png' } }),
    ).toBe('viewer')
  })

  it('音频永远 inline（不进查看器、不进编辑器）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('inline')
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: { status: 'pending_confirm' } })).toBe('inline')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/composables/mobileNodeOpenPolicy.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t1.log 2>&1; echo EXIT=$?; tail -25 /tmp/t1.log
```

Expected: FAIL —— `'none'` 不在枚举里，且 empty 节点当前返回 `'editor'`。

- [ ] **Step 3: 最小实现**

改 `apps/web/src/composables/mobileNodeOpenPolicy.ts`（整体替换 `MobileNodeTapIntent` 与 `resolveMobileNodeTapIntent`，**保留文件头注释**并追加状态门控说明）：

```ts
import { resolveMobileNodeState } from '@/composables/mobileNodeState'

/**
 * viewer = 全屏查看器；editor = 编辑 sheet；inline = 磁贴内联处理（音频播放）；
 * none = 无 op + 轻提示（引导长按）。
 *
 * ⭐ 状态门控（2026-10-25 规格 §5.1，缺陷 D1/D3）：本函数此前只看 type+data，
 * 把「空节点」路由到 editor ⇒ 用户单击就进编辑器，违背 P1「单击 = 查看」。
 * 判据顺序（**不可交换**）：
 *   1) 音频 → inline（永远不进查看器/编辑器）
 *   2) 状态优先：generating → none；error 且无旧产物 → none
 *   3) 有产物（pending / confirmed / error+旧产物）→ viewer
 *   4) 其余（empty）→ none
 */
export type MobileNodeTapIntent = 'viewer' | 'editor' | 'inline' | 'none'

export function resolveMobileNodeTapIntent(node: {
  type: string
  data?: Record<string, unknown> | null
}): MobileNodeTapIntent {
  const data = node.data ?? {}
  if (node.type === 'audio') return 'inline'

  const state = resolveMobileNodeState({ type: node.type, data })

  // 生成中：壳层状态栏已给「耗时 · 取消」，tap 不重复入口
  if (state === 'generating') return 'none'

  // 失败且无旧产物：无内容可看 ⇒ 无 op + 引导
  if (state === 'error') {
    const hasOld = node.type === 'text'
      ? Boolean(String(data.content ?? '').trim())
      : Boolean(String(data.url ?? '').trim())
    return hasOld ? 'viewer' : 'none'
  }

  // pending / confirmed：先看产出
  if (state === 'pending' || state === 'confirmed') return 'viewer'

  // empty：无产物 ⇒ 无 op + 轻提示「长按编辑 / 长按撰写」
  return 'none'
}
```

同步改 `apps/web/src/components/mobile/MobileNodeTile.vue`：
- 空瓦片 CTA 文案 `「点按生成 / 点按撰写」` ⇒ `「长按编辑 / 长按撰写」`（改 `emptyCtaLabel` 计算处）。
- `onTileClick` / `onTileOpen` 分支：`'none'` ⇒ 弹轻 toast（1.5s 自动消失，提示「长按编辑 / 长按撰写」），**不**开 viewer、**不**开 editor。

> ⚠️ 消费方不止一处：`NodeRenderer.vue` 的 `onTileOpen` 也调本函数 ⇒ 同步处理 `'none'` 分支，否则 TS 会因枚举扩值而报错（`vue-tsc -b` 阶段会卡住）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/composables/mobileNodeOpenPolicy.test.ts src/components/mobile/NodeRenderer.policy.test.ts src/components/mobile/MobileNodeTile.placeholder.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t1b.log 2>&1; echo EXIT=$?; tail -20 /tmp/t1b.log
cd apps/web && npx vue-tsc -b > /tmp/t1c.log 2>&1; echo TSC_EXIT=$?; tail -15 /tmp/t1c.log
```

Expected: 全部 PASS；`vue-tsc -b` EXIT=0（若报 `TS6133` 未使用变量 ⇒ 有测试里的派生变量变孤儿，清掉）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/composables/mobileNodeOpenPolicy.ts apps/web/src/composables/mobileNodeOpenPolicy.test.ts apps/web/src/components/mobile/MobileNodeTile.vue apps/web/src/components/canvas/NodeRenderer.vue
git commit -m "fix(mobile): tap 门控落状态——空/生成中/失败无旧产物不再进编辑器 (D1/D3)"
```

---

## Task 2: 查看器退出通道与音频死分支（D2）

**Files:**
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.test.ts`

**Interfaces:**
- Consumes: 无（组件自持状态）
- Produces: `MobileNodeViewer` 的 props `type` 收窄为 `'image' | 'video' | 'text'`（**删掉 `audio`**）；新增 emit `close`（已有）不变。内部暴露 `data-testid="mobile-viewer-close"`（X 按钮）与 `data-testid="mobile-viewer"`（根容器，供下滑手势断言）。

- [ ] **Step 1: 写失败测试**

改 `apps/web/src/components/mobile/MobileNodeViewer.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeViewer from './MobileNodeViewer.vue'

describe('MobileNodeViewer（退出通道 · D2）', () => {
  it('右上角有 X 按钮（44px 触控目标）并 emit close', async () => {
    const wrapper = mount(MobileNodeViewer, {
      props: { type: 'image', data: { url: 'https://x/a.png' } },
    })
    const btn = wrapper.get('[data-testid="mobile-viewer-close"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('无 audio 类型分支（音频永不进查看器）', () => {
    const wrapper = mount(MobileNodeViewer, {
      props: { type: 'image', data: { url: 'https://x/a.png' } },
    })
    expect(wrapper.find('video').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/MobileNodeViewer.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t2.log 2>&1; echo EXIT=$?; tail -20 /tmp/t2.log
```

Expected: FAIL —— `mobile-viewer-close` 不存在（当前只有左上 `‹`）。

- [ ] **Step 3: 最小实现**

改 `apps/web/src/components/mobile/MobileNodeViewer.vue`：

1. props 的 `type` 改为 `'image' | 'video' | 'text'`。
2. 删掉左上 `‹` 按钮（`.viewer-back`），改为**右上角 X**：

```vue
<button
  class="viewer-close"
  type="button"
  aria-label="关闭"
  data-testid="mobile-viewer-close"
  @click="emit('close')"
>
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
  </svg>
</button>
```

3. 根容器加 `data-testid="mobile-viewer"`，并加**下滑关闭**（`touchstart` 记 Y、`touchmove` 记位移、`touchend` 位移 > 100px ⇒ `emit('close')`）。
4. 视频退出即停：`<video ref="videoRef" @ended="..." >`，在 `emit('close')` 前 `videoRef.value?.pause()`；`close` 走一个统一函数 `requestClose()`。
5. 样式：`.viewer-close` 用 `position:absolute; top: calc(env(safe-area-inset-top) + 8px); right: 8px;`，尺寸 `var(--lnk-touch-target)`，色 `var(--lnk-text-primary)`（**只用 `--lnk-*` 令牌**，禁 `--neo-*`）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/MobileNodeViewer.test.ts src/components/mobile/MobileNodeViewer.fit.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t2b.log 2>&1; echo EXIT=$?; tail -20 /tmp/t2b.log
cd apps/web && npx vue-tsc -b > /tmp/t2c.log 2>&1; echo TSC_EXIT=$?
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/mobile/MobileNodeViewer.vue apps/web/src/components/mobile/MobileNodeViewer.test.ts
git commit -m "fix(mobile): 查看器加右上 X + 下滑关闭 + 退出即停；删音频死分支 (D2)"
```

---

## Task 3: 删除二次确认（D5）

**Files:**
- Modify: `apps/web/src/pages/CanvasPage.vue`
- Test: `apps/web/src/pages/CanvasPage.mobileDeleteConfirm.test.ts`（**新增**，静态源码契约形态，参照同目录既有 `CanvasPage.mobile*.test.ts` 写法）

**Interfaces:**
- Consumes: `ElMessageBox`（element-plus，项目既有确认弹窗用法）或既有 `ProposeConfirmOverlay` 通道 —— **实施时先 grep 仓库既有二次确认写法**（`grep -rn "ElMessageBox" apps/web/src | head`），沿用既有范式，**不新造弹窗组件**。
- Produces: `removeSingleNode(nodeId)` 的调用点从动作分发直达改为「先确认再删」。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/pages/CanvasPage.mobileDeleteConfirm.test.ts`（静态契约形态，参照同目录既有测试）：

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, 'CanvasPage.vue'), 'utf-8')

describe('删除二次确认（D5）', () => {
  it('移动端删除动作必须先确认，不得直达 removeSingleNode', () => {
    const dispatch = SRC.slice(SRC.indexOf('function handleMobileNodeAction'))
    const deleteCase = dispatch.slice(0, dispatch.indexOf('case ', 10))
    expect(deleteCase).toMatch(/confirm/i)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/pages/CanvasPage.mobileDeleteConfirm.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t3.log 2>&1; echo EXIT=$?; tail -15 /tmp/t3.log
```

Expected: FAIL —— `case 'delete'` 分支当前直接 `removeSingleNode(nodeId)`。

- [ ] **Step 3: 最小实现**

在 `apps/web/src/pages/CanvasPage.vue` 的 `handleMobileNodeAction` 中，把：

```ts
    case 'delete':
      removeSingleNode(nodeId)
      break
```

改为**先确认**（沿用仓库既有二次确认范式；下例以 `ElMessageBox` 为例，实施时以 grep 到的既有范式为准）：

```ts
    case 'delete':
      // D5：删除是破坏性操作 ⇒ 二次确认（规格 §4.4 破坏性置底+红色+二次确认）
      void confirmThen(() => {
        removeSingleNode(nodeId)
        closeMobileNodeAction()
      })
      break
```

其中 `confirmThen` 是本次新增的本地辅助（`ElMessageBox.confirm` 的薄封装，取消时**不**执行回调、不关 sheet——用户按 P3 语义留在原层）。若仓库既有 `ProposeConfirmOverlay` 通道更适合，则改为走它。

> ⚠️ 注意 `closeMobileNodeAction()` 在 `handleMobileNodeAction` 末尾统一调用 ⇒ 走异步确认时**不能**在末尾提前关掉 sheet，否则确认框会挂在已关闭的 sheet 上。上面代码把关闭动作放进回调里，并在末尾用 `return` 跳过统一关闭。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/pages/CanvasPage.mobileDeleteConfirm.test.ts src/pages/CanvasPage.mobileWalkthroughRound2.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t3b.log 2>&1; echo EXIT=$?; tail -20 /tmp/t3b.log
cd apps/web && npx vue-tsc -b > /tmp/t3c.log 2>&1; echo TSC_EXIT=$?
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/CanvasPage.vue apps/web/src/pages/CanvasPage.mobileDeleteConfirm.test.ts
git commit -m "fix(mobile): 删除节点走二次确认 (D5)"
```

---

## Task 4: 动作 sheet 操作集补全 + 状态门控（D6 / D7）

**Files:**
- Create: `apps/web/src/composables/mobileNodeActionPolicy.ts`
- Create: `apps/web/src/composables/mobileNodeActionPolicy.test.ts`
- Modify: `apps/web/src/components/mobile/MobileNodeActionSheet.vue`
- Modify: `apps/web/src/components/mobile/MobileNodeActionSheet.test.ts`
- Modify: `apps/web/src/pages/CanvasPage.vue`

**Interfaces:**
- Consumes: `resolveMobileNodeState(node)` from `@/composables/mobileNodeState`
- Produces:
  ```ts
  export type MobileNodeActionKey =
    | 'rename' | 'reference' | 'duplicate' | 'duplicate-upstream'
    | 'save-asset' | 'save-local' | 'multi-select' | 'edit' | 'delete'

  export function resolveMobileNodeActions(node: {
    id: string
    type: string
    data?: Record<string, unknown> | null
  }): MobileNodeActionKey[]
  ```
  - **顺序固定**（规格 §4.4 频率分层）：`edit` 置顶（高频主操作）→ 中频平铺 → `delete` 置底。
  - **门控**（规格 §5.1 / G-12）：`generating` 态**不返回** `reference` / `duplicate` / `duplicate-upstream` / `save-asset` / `save-local`；`empty` 态**不返回** `duplicate-upstream` / `save-asset` / `save-local`（无产物）；`delete` 在 `generating` 态**不返回**（G-11 + 规格 §6.4「默认禁止」）。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/composables/mobileNodeActionPolicy.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { resolveMobileNodeActions } from './mobileNodeActionPolicy'

describe('resolveMobileNodeActions（操作集 + 状态门控）', () => {
  it('confirmed 节点 = 全集，且 edit 置顶、delete 置底', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: { url: 'https://x/a.png' } })
    expect(keys[0]).toBe('edit')
    expect(keys[keys.length - 1]).toBe('delete')
    expect(keys).toContain('reference')
    expect(keys).toContain('duplicate')
    expect(keys).toContain('duplicate-upstream')
    expect(keys).toContain('save-asset')
    expect(keys).toContain('save-local')
  })

  it('generating 态：禁引用/副本/资产库/本地/删除（G-12）', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: { status: 'generating' } })
    expect(keys).not.toContain('reference')
    expect(keys).not.toContain('duplicate')
    expect(keys).not.toContain('duplicate-upstream')
    expect(keys).not.toContain('save-asset')
    expect(keys).not.toContain('save-local')
    expect(keys).not.toContain('delete')
    expect(keys).toContain('rename')
    expect(keys).toContain('multi-select')
  })

  it('empty 节点：无产物 ⇒ 禁副本含上游/资产库/本地', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: {} })
    expect(keys).not.toContain('duplicate-upstream')
    expect(keys).not.toContain('save-asset')
    expect(keys).not.toContain('save-local')
    expect(keys).toContain('edit')
  })

  it('pending 节点：走全集（用户要能改词/看引用）', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: { status: 'pending_confirm' } })
    expect(keys).toContain('edit')
    expect(keys).toContain('reference')
    expect(keys).toContain('delete')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/composables/mobileNodeActionPolicy.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t4.log 2>&1; echo EXIT=$?; tail -15 /tmp/t4.log
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

新建 `apps/web/src/composables/mobileNodeActionPolicy.ts`：

```ts
import { resolveMobileNodeState } from '@/composables/mobileNodeState'

export type MobileNodeActionKey =
  | 'edit'
  | 'rename'
  | 'reference'
  | 'duplicate'
  | 'duplicate-upstream'
  | 'save-asset'
  | 'save-local'
  | 'multi-select'
  | 'delete'

/**
 * 移动端长按动作 sheet 的可用操作集（规格 §5.1 总门控表 + §4.4 频率分层）。
 *
 * ⭐ 单一真源：sheet 的渲染与页面层的分发都消费这一个函数，
 *   不各写一遍（否则门控会漂移）。
 *
 * 顺序即 UI 顺序：edit 置顶（高频主操作）→ 中频平铺 → delete 置底（破坏性）。
 */
export function resolveMobileNodeActions(node: {
  id: string
  type: string
  data?: Record<string, unknown> | null
}): MobileNodeActionKey[] {
  const state = resolveMobileNodeState({ type: node.type, data: node.data })
  const hasContent = state === 'confirmed' || state === 'pending' || state === 'error'

  const keys: MobileNodeActionKey[] = ['edit']
  keys.push('rename')
  if (hasContent) {
    keys.push('reference', 'duplicate', 'duplicate-upstream', 'save-asset', 'save-local')
  }
  keys.push('multi-select')
  if (state !== 'generating') keys.push('delete')
  return keys
}
```

改 `apps/web/src/components/mobile/MobileNodeActionSheet.vue`：
- 删除硬编码的 `actions` computed，改为消费 `resolveMobileNodeActions(props.node)`。
- `multi-select` 的文案仍按 `props.node.multiSelectActive` / `multiSelectSelected` 变（保留既有 `multiSelectLabel`）。
- 每个 key 映射到中文标签 + `danger`：`edit`→'编辑'、`rename`→'重命名'、`reference`→'引用'、`duplicate`→'副本'、`duplicate-upstream`→'副本（含上游）'、`save-asset`→'存入资产库'、`save-local`→'保存到本地'、`multi-select`→`multiSelectLabel`、`delete`→'删除'（danger）。

改 `apps/web/src/pages/CanvasPage.vue` 的 `handleMobileNodeAction`，补三个新 case（复用 PC 既有能力，**先 grep 既有实现**：`grep -n "save-asset\|save-local\|duplicate-upstream" apps/web/src/pages/CanvasPage.vue`）：

```ts
    case 'duplicate-upstream':
      handleDuplicateSelection(nodeId, 'upstream')
      break
    case 'save-asset':
      handleSaveNodeToAssetLibrary(nodeId)
      break
    case 'save-local':
      handleSaveNodeToLocal(nodeId)
      break
```

> 若 PC 侧对应函数的真实名字不同（很可能），**以 grep 结果为准**并在本步的 commit message 里记录实际接线；不要臆造函数名。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/composables/mobileNodeActionPolicy.test.ts src/components/mobile/MobileNodeActionSheet.test.ts src/components/mobile/MobileNodeActionSheet.r4.test.ts src/components/mobile/MobileNodeActionSheet.multiSelect.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t4b.log 2>&1; echo EXIT=$?; tail -25 /tmp/t4b.log
cd apps/web && npx vue-tsc -b > /tmp/t4c.log 2>&1; echo TSC_EXIT=$?
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/composables/mobileNodeActionPolicy.ts apps/web/src/composables/mobileNodeActionPolicy.test.ts apps/web/src/components/mobile/MobileNodeActionSheet.vue apps/web/src/components/mobile/MobileNodeActionSheet.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "feat(mobile): 长按动作集补三项（副本含上游/存入资产库/保存到本地）+ 状态门控 (D6/D7)"
```

---

## Task 5: 多选选择模式视觉 + 轻点即选（D4 / H1）

**Files:**
- Modify: `apps/web/src/components/mobile/MobileMultiSelectBar.vue`（**真实文件名**；它是「已选后的底部批量条」，**已有**「完成」钮 + 「更多」sheet（删除/引用/副本）—— 本任务只**补「全选 / 取消」两个入口**与选择模式信号）
- Modify: `apps/web/src/components/mobile/MobileMultiSelectBar.test.ts`
- Modify: `apps/web/src/components/mobile/MobileNodeTile.vue`
- Modify: `apps/web/src/components/mobile/MobileNodeTile.test.ts`
- Modify: `apps/web/src/pages/CanvasPage.vue`

**Interfaces:**
- Consumes: `resolveMobileNodeState`（间接，通过页面层）
- Produces:
  - `MobileNodeTile` 新增 prop `selectionMode?: boolean`（默认 false）、`selected?: boolean`（默认 false）；新增 emit `toggle-select: [id: string]`。
  - `MobileMultiSelectBar` 新增 prop `selectionMode?: boolean`（多选**模式**已激活的信号——注意与「已选 N」不同：模式可开着而当前选区为 0）；新增 emit `select-all: []`、`cancel-select: []`。
  - 页面层在多选态激活时**向所有瓦片下发** `selectionMode=true`。

> ⚠️ **实施前必读**：`MobileMultiSelectBar.vue` 现有 props = `{ count, selectionBatch?, canUngroup?, groupColorKey? }`，emits 含 `done`（完成）/ `delete` / `addAgentRef` / `duplicate` / `duplicateUpstream` / … ⇒ **不要重复造**这些；本任务只加 `select-all` / `cancel-select` 两个 emit 与 `selectionMode` prop。

- [ ] **Step 1: 写失败测试**

改 `apps/web/src/components/mobile/MobileMultiSelectBar.test.ts`（追加到既有 `describe`）：

```ts
it('选择模式：底部动作条含「全选 / 取消 / 完成」', () => {
  const wrapper = mount(MobileMultiSelectBar, {
    props: { count: 2, selectionMode: true } as any,
  })
  const html = wrapper.html()
  expect(html).toContain('全选')
  expect(html).toContain('取消')
  expect(html).toContain('完成')
})
```

另在 `apps/web/src/components/mobile/MobileNodeTile.test.ts` 追加：

```ts
it('选择模式下显示圆形选择指示器', () => {
  const wrapper = mount(MobileNodeTile, {
    props: { id: 'n1', type: 'image', data: { url: 'https://x/a.png' }, selectionMode: true } as any,
  })
  expect(wrapper.find('[data-testid="mobile-node-select-indicator"]').exists()).toBe(true)
})

it('选择模式下 tap 切换选中（不打开查看器）', async () => {
  const wrapper = mount(MobileNodeTile, {
    props: { id: 'n1', type: 'image', data: { url: 'https://x/a.png' }, selectionMode: true } as any,
  })
  await wrapper.get('[data-testid="mobile-node-tile"]').trigger('click')
  expect(wrapper.emitted('toggle-select')).toBeTruthy()
  expect(wrapper.emitted('open-viewer')).toBeFalsy()
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/MobileMultiSelectBar.test.ts src/components/mobile/MobileNodeTile.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t5.log 2>&1; echo EXIT=$?; tail -20 /tmp/t5.log
```

Expected: FAIL —— `selectionMode` prop 不存在。

- [ ] **Step 3: 最小实现**

1. `MobileNodeTile.vue`：新增 props `selectionMode?: boolean`（默认 false）、`selected?: boolean`（默认 false）。模板内、`v-if="selectionMode"` 时渲染一枚圆形指示器：

```vue
<span
  v-if="selectionMode"
  class="mobile-node-select-indicator"
  :class="{ 'is-selected': selected }"
  data-testid="mobile-node-select-indicator"
  aria-hidden="true"
/>
```

样式：16px 圆、`border: 2px solid var(--lnk-text-primary)`；`.is-selected` 时 `background: var(--lnk-accent)` + `border-color: var(--lnk-accent)`。

2. `MobileNodeTile.vue` 的点击处理：**`selectionMode` 为真时，tap 只 emit `toggle-select`，不打开查看器**（G-2 / Review Focus #5）。已选中的节点再点 ⇒ **取消选中**（不是「无反应」、不是「重复选中」）—— 语义由页面层的 `enterMultiSelectMode` 既有累加逻辑保证，瓦片只负责 emit。

3. `MobileMultiSelectBar.vue`：新增 prop `selectionMode?: boolean`；当 `selectionMode` 为真时，在既有动作区**补两个按钮**：
   - 「全选」⇒ `emit('select-all')`
   - 「取消」⇒ `emit('cancel-select')`（退出选择模式）

   既有「完成」钮（`data-testid="mobile-multi-select-done"`）**保留不动** ⇒ 退出路径两条（取消 / 完成），语义都是「退出模式」。

4. `pages/CanvasPage.vue`：
   - 多选态激活时把 `selectionMode` 下发给所有瓦片（`:selection-mode="mobileMultiSelectActive"`、`:selected="multiSelectedIds.includes(node.id)"`）。
   - 瓦片 `toggle-select` ⇒ 走 `enterMultiSelectMode` 的既有累加语义，**不开 viewer**（D4）。
   - 多选态下**长按不弹单节点动作 sheet**（同义切换）。
   - `select-all` ⇒ 选中当前画布全部节点；`cancel-select` ⇒ 退出多选态。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/MobileMultiSelectBar.test.ts src/components/mobile/MobileNodeTile.test.ts src/components/mobile/MobileNodeTile.gesture.test.ts src/components/mobile/MobileNodeActionSheet.multiSelect.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t5b.log 2>&1; echo EXIT=$?; tail -25 /tmp/t5b.log
cd apps/web && npx vue-tsc -b > /tmp/t5c.log 2>&1; echo TSC_EXIT=$?
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/mobile/MobileMultiSelectBar.vue apps/web/src/components/mobile/MobileMultiSelectBar.test.ts apps/web/src/components/mobile/MobileNodeTile.vue apps/web/src/components/mobile/MobileNodeTile.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "feat(mobile): 多选选择模式——全局圆圈 + 轻点即选 + 全选/取消 (D4/H1)"
```

## Task 6: 轻量编辑器替换 PC studio dock（D8 / J1 / K1）★核心

**Files:**
- Modify: `apps/web/src/components/mobile/MobileNodeEditorSheet.vue`（**重写**）
- Modify: `apps/web/src/components/mobile/MobileNodeEditorSheet.test.ts`
- Modify: `apps/web/src/components/mobile/MobileNodeEditorSheet.walkthrough.test.ts`
- Modify: `apps/web/src/components/mobile/MobileNodeEditorSheet.r4.test.ts`
- Modify: `apps/web/src/pages/CanvasPage.vue`

**Interfaces:**
- Consumes: `resolveMobileNodeState`；既有 `patchNodeData` / `persistUserEdit`（页面层提供）
- Produces:
  ```ts
  // MobileNodeEditorSheet.vue 的 props（收窄）
  defineProps<{
    node: EditableFlowNode
    refs?: NodeRef[]
    mentions?: MentionOption[]
    generating?: boolean
  }>()
  // emits（替换旧的 generate / removeRef）
  const emit = defineEmits<{
    close: []
    patch: [patch: Record<string, unknown>]
    /** 模式①：把「改后提示词 + 意见」交给 agent（不是本地生成） */
    send-to-agent: [payload: { prompt: string; opinion: string }]
  }>()
  ```

  **关键**：`upstream` prop 与 `generate` / `removeRef` emit **一并移除**（PC dock 专用）；`removeRef` 能力降级为**编辑器的引用 chips 区**里由页面层处理（若不需要可先不做，但**不得**保留 `generate` emit）。

- [ ] **Step 1: 写失败测试**

改 `apps/web/src/components/mobile/MobileNodeEditorSheet.test.ts`（**重写**，形态=静态源码契约，参照同目录 `MobileNodeEditorSheet.r4.test.ts` 的 `readFileSync` 风格）：

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, 'MobileNodeEditorSheet.vue'), 'utf-8')

describe('MobileNodeEditorSheet 轻量编辑器（D8 / J1 / K1）', () => {
  it('⛔ 不再复用 PC studio dock（G-4）', () => {
    expect(SRC).not.toContain('DockStudioRouter')
    expect(SRC).not.toContain('dock-studio')
  })

  it('⛔ 不出现「生成」按钮（生成权归 agent）', () => {
    expect(SRC).not.toMatch(/生成/)
  })

  it('有「发给 agent 修改」出口', () => {
    expect(SRC).toContain('发给 agent 修改')
  })

  it('有提示词编辑区与意见输入区', () => {
    expect(SRC).toContain('提示词')
    expect(SRC).toContain('意见')
  })

  it('参数区只读（不出现参数选择器）', () => {
    expect(SRC).not.toContain('ModelSelector')
    expect(SRC).not.toContain('ImageParamsSelector')
    expect(SRC).not.toContain('VideoSettingsSelector')
    expect(SRC).not.toContain('AudioVoiceSettingsSelector')
  })

  it('emit send-to-agent（而非 generate）', () => {
    expect(SRC).toContain('send-to-agent')
    expect(SRC).not.toContain("'generate'")
  })
})
```

> ⚠️ `expect(SRC).not.toMatch(/生成/)` 会被「不生成」这类文案误伤 ⇒ 实现时**不要**在任何可见文案里出现「生成」二字（改用「发给 agent 修改」）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/MobileNodeEditorSheet.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t6.log 2>&1; echo EXIT=$?; tail -20 /tmp/t6.log
```

Expected: FAIL —— 源码里仍有 `DockStudioRouter`。

- [ ] **Step 3: 最小实现（重写组件）**

重写 `apps/web/src/components/mobile/MobileNodeEditorSheet.vue` 为轻量编辑器（结构照此，样式只用 `--lnk-*` 令牌）：

```vue
<script setup lang="vue">
import { computed, ref } from 'vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import type { NodeRef } from '@/composables/useNodeRefs'

/**
 * 移动端轻量编辑器（2026-10-25 规格 §4.2 J1/K1，缺陷 D8）。
 *
 * ⭐ 为什么不再挂 PC 的 `DockStudioRouter`：
 *   模式①（agent 驱动）下生成权归 agent —— propose 时服务端已写死
 *   模型/比例/分辨率（`proposeGeneration`），用户再调 ⇒ 两套参数语义打架；
 *   且 PC dock ≈4800 行、窄屏参数选择器已实证弹不开。
 *   ⇒ 本组件只做「改词 + 提意见」，提交出口是「发给 agent 修改」。
 */
const props = withDefaults(
  defineProps<{
    node: EditableFlowNode
    refs?: NodeRef[]
    mentions?: MentionOption[]
    generating?: boolean
  }>(),
  { refs: () => [], mentions: () => [], generating: false },
)

const emit = defineEmits<{
  close: []
  patch: [patch: Record<string, unknown>]
  send-to-agent: [payload: { prompt: string; opinion: string }]
}>()

const prompt = ref(String((props.node.data as Record<string, unknown>)?.prompt ?? ''))
const opinion = ref('')

/** 参数只读摘要（agent 定的，用户不可改） */
const paramsSummary = computed(() => {
  const d = (props.node.data ?? {}) as Record<string, unknown>
  return [
    typeof d.imageModel === 'string' ? d.imageModel : '',
    typeof d.imageAspect === 'string' ? d.imageAspect : '',
    typeof d.imageResolution === 'string' ? d.imageResolution : '',
  ].filter(Boolean).join(' · ')
})

function submit() {
  const nextPrompt = prompt.value.trim()
  if (nextPrompt) emit('patch', { prompt: nextPrompt })
  emit('send-to-agent', { prompt: nextPrompt, opinion: opinion.value.trim() })
}
</script>

<template>
  <div class="mobile-editor-sheet" role="dialog" aria-modal="true" aria-label="编辑节点">
    <div class="mobile-editor-head">
      <span class="mobile-editor-title">编辑</span>
      <button
        class="sheet-close" type="button" aria-label="关闭"
        data-testid="mobile-editor-close" @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="mobile-editor-body">
      <label class="mobile-editor-label" for="mobile-editor-prompt">提示词</label>
      <textarea
        id="mobile-editor-prompt" v-model="prompt"
        class="mobile-editor-prompt" data-testid="mobile-editor-prompt"
        placeholder="要改的话，改这里"
      />

      <p v-if="paramsSummary" class="mobile-editor-params" data-testid="mobile-editor-params">
        {{ paramsSummary }}
      </p>

      <label class="mobile-editor-label" for="mobile-editor-opinion">意见</label>
      <textarea
        id="mobile-editor-opinion" v-model="opinion"
        class="mobile-editor-opinion" data-testid="mobile-editor-opinion"
        placeholder="你想让 agent 怎么改？"
      />
    </div>

    <div class="mobile-editor-foot">
      <button
        class="mobile-editor-send" type="button"
        data-testid="mobile-editor-send" @click="submit"
      >
        发给 agent 修改
      </button>
    </div>
  </div>
</template>
```

> ⚠️ 样式段：把原有的 `.mobile-editor-sheet` / `.sheet-close` 保留（X 按钮样式 #578 已建立），**删掉**整段 `.mobile-editor-sheet :deep(.neo-popover)` 与 `.mobile-editor-body` 上对 PC popover 的打补丁（那是给 dock 用的，dock 不再挂 ⇒ 补丁无用）。新增的 textarea / 按钮样式一律用 `--lnk-*` 令牌。

改 `apps/web/src/pages/CanvasPage.vue`：
- `mobileEditor` computed：**删掉** `upstream` 字段（不再需要 `resolveUpstreamContext`）。
- `handleMobileNodeGenerate` **改名** `handleMobileSendToAgent(payload)`：不再本地提交生成，而是**把改后提示词 + 意见回传给 agent**（走既有 agent 通道：把节点引用 + 意见文本写进 `useSidebarAttachments` 的 `pendingAttachments`，并切回对话页 `mobileAppTab.value = 'chat'`）。
  - **实施前先 grep 既有 agent 通道**：`grep -n "pendingAttachments\|addFromPayload\|mobileAppTab.value = 'chat'" apps/web/src/pages/CanvasPage.vue apps/web/src/components/agent/AgentSideRail.vue` ⇒ 复用既有引用写入通道，**不新造**。
- `MobileCanvasShell.vue` 的 `mobileEditor` prop 与 `MobileNodeEditorSheet` 的接线：删掉 `:upstream` 传参。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/MobileNodeEditorSheet.test.ts src/components/mobile/MobileNodeEditorSheet.r4.test.ts src/components/mobile/MobileNodeEditorSheet.walkthrough.test.ts src/components/mobile/MobileNodeEditorSheet.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t6b.log 2>&1; echo EXIT=$?; tail -30 /tmp/t6b.log
cd apps/web && npx vue-tsc -b > /tmp/t6c.log 2>&1; echo TSC_EXIT=$?
```

> ⚠️ **Review Focus 的实现期风险**：`MobileNodeEditorSheet.r4.test.ts` 断言的是「透传 `removeRef`」与「`DockStudioRouter` 的 `generate` 透传」——这两条**必须随契约一起改**（不是删测试，而是改成断言新的 `send-to-agent` 契约）。改不动就说明契约没想清楚，**停下来问，不要改测试让它绿**。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/mobile/MobileNodeEditorSheet.vue apps/web/src/components/mobile/MobileNodeEditorSheet.test.ts apps/web/src/components/mobile/MobileNodeEditorSheet.r4.test.ts apps/web/src/components/mobile/MobileNodeEditorSheet.walkthrough.test.ts apps/web/src/components/mobile/MobileCanvasShell.vue apps/web/src/pages/CanvasPage.vue
git commit -m "refactor(mobile): 编辑器改轻量「提示词+意见」，参数只读，提交走「发给 agent 修改」 (D8/J1/K1)"
```

---

## Task 7: 标注层——手指圈选 + 带标记整图 + 锚回传（L1 / M1）★核心

**Files:**
- Create: `apps/web/src/composables/mobileAnnotateIntent.ts`
- Create: `apps/web/src/composables/mobileAnnotateIntent.test.ts`
- Create: `apps/web/src/components/mobile/annotate/composeAnnotatedImage.ts`
- Create: `apps/web/src/components/mobile/annotate/composeAnnotatedImage.test.ts`
- Create: `apps/web/src/components/mobile/MobileNodeAnnotateSheet.vue`
- Create: `apps/web/src/components/mobile/MobileNodeAnnotateSheet.test.ts`
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`（加标注态入口 + 标注层）
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.test.ts`
- Modify: `apps/web/src/pages/CanvasPage.vue`（接线）

**Interfaces:**
- Consumes:
  - `sameOriginApiMediaUrl` from `@/services/media-url`
  - `fileToPersistedPayload` from `@/composables/useMediaUpload`
  - `useSidebarAttachments` from `@/composables/useSidebarAttachments`（`addFromPayload`）
  - `peaks` from `@/composables/useNodeWaveform`（音频底图）
- Produces:
  ```ts
  // mobileAnnotateIntent.ts
  export type AnnotateBaseSource = 'image' | 'video-frame' | 'waveform' | 'text'
  export function resolveAnnotateIntent(node: { type: string; data?: ... }): AnnotateBaseSource

  // composeAnnotatedImage.ts
  export interface AnnotateMark { points: Array<{ x: number; y: number }> }
  export function composeAnnotatedImage(
    base: CanvasImageSource,
    baseWidth: number,
    baseHeight: number,
    marks: AnnotateMark[],
  ): HTMLCanvasElement   // 纯函数：底图 + 标记 → 已绘制好的 canvas（调用方 toBlob）
  ```

  ⚠️ **纯函数边界**：`composeAnnotatedImage` **不自行加载图片**（加载是调用方的事，且加载需同源化）——这样它可在 node 环境被单测覆盖（用 `OffscreenCanvas` 或注入 canvas 工厂）。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/composables/mobileAnnotateIntent.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { resolveAnnotateIntent } from './mobileAnnotateIntent'

describe('resolveAnnotateIntent（标注底图来源）', () => {
  it('图片 = image；视频 = video-frame；音频 = waveform；文本 = text', () => {
    expect(resolveAnnotateIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('image')
    expect(resolveAnnotateIntent({ type: 'video', data: { url: 'https://x/a.mp4' } })).toBe('video-frame')
    expect(resolveAnnotateIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('waveform')
    expect(resolveAnnotateIntent({ type: 'text', data: { content: '你好' } })).toBe('text')
  })
})
```

新建 `apps/web/src/components/mobile/annotate/composeAnnotatedImage.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { composeAnnotatedImage } from './composeAnnotatedImage'

describe('composeAnnotatedImage（整图 + 标记）', () => {
  it('输出尺寸 = 底图尺寸（整图，不是裁切，G-6）', () => {
    const c = composeAnnotatedImage(null, 800, 600, [])
    expect(c.width).toBe(800)
    expect(c.height).toBe(600)
  })

  it('有标记时仍在同一张底图上绘制（不裁切）', () => {
    const c = composeAnnotatedImage(null, 800, 600, [
      { points: [{ x: 10, y: 10 }, { x: 100, y: 100 }] },
    ])
    expect(c.width).toBe(800)
    expect(c.height).toBe(600)
  })

  it('空底图尺寸非法时抛错（不静默出空白图）', () => {
    expect(() => composeAnnotatedImage(null, 0, 0, [])).toThrow()
  })
})
```

新建 `apps/web/src/components/mobile/MobileNodeAnnotateSheet.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeAnnotateSheet from './MobileNodeAnnotateSheet.vue'

describe('MobileNodeAnnotateSheet（标注浮层 · M1）', () => {
  it('有意见输入 + 「⚓ 带回对话」主按钮', () => {
    const wrapper = mount(MobileNodeAnnotateSheet, {
      props: { nodeId: 'n1', nodeTitle: '夜景', uploading: false, degraded: false } as any,
    })
    expect(wrapper.find('[data-testid="mobile-annotate-opinion"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-annotate-send"]').exists()).toBe(true)
  })

  it('上传中：按钮禁用且显示「上传中」', () => {
    const wrapper = mount(MobileNodeAnnotateSheet, {
      props: { nodeId: 'n1', nodeTitle: '夜景', uploading: true, degraded: false } as any,
    })
    const btn = wrapper.get('[data-testid="mobile-annotate-send"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(wrapper.html()).toContain('上传中')
  })

  it('降级（视频无 CORS）：明说「只带文字」', () => {
    const wrapper = mount(MobileNodeAnnotateSheet, {
      props: { nodeId: 'n1', nodeTitle: '夜景', uploading: false, degraded: true } as any,
    })
    expect(wrapper.html()).toContain('只带文字')
  })

  it('上传失败：给出可行动的错误文案（Review Focus #4）', () => {
    const wrapper = mount(MobileNodeAnnotateSheet, {
      props: { nodeId: 'n1', nodeTitle: '夜景', uploading: false, degraded: false, error: '上传失败，请重试' } as any,
    })
    expect(wrapper.html()).toContain('上传失败')
    expect(wrapper.find('[data-testid="mobile-annotate-send"]').attributes('disabled')).toBeDefined()
  })
})
```

> ⚠️ **Review Focus #4 的另一半（blob 不入引用）**必须在**页面层**钉住 ⇒ 见下面 Step 3 的「同节点两次标注都能进 composer」测试（`addFromPayload` 会按 `url` / `sourceNodeId` 去重 ⇒ 同一节点连续两次标注会被吞掉第二次 ⇒ 必须让每次标注的 `sourceNodeId` 唯一）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/composables/mobileAnnotateIntent.test.ts src/components/mobile/annotate/composeAnnotatedImage.test.ts src/components/mobile/MobileNodeAnnotateSheet.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t7.log 2>&1; echo EXIT=$?; tail -20 /tmp/t7.log
```

Expected: FAIL —— 三个模块都不存在。

- [ ] **Step 3: 最小实现**

1. `mobileAnnotateIntent.ts`：

```ts
export type AnnotateBaseSource = 'image' | 'video-frame' | 'waveform' | 'text'

/**
 * 节点类型 → 标注底图来源（规格 §4.3 四类节点统一为「一张图 + 一句话」）。
 * ⭐ 音频的底图是**波形图**（不是「拖时间段」）——统一成一张图，才有一支笔。
 */
export function resolveAnnotateIntent(node: {
  type: string
  data?: Record<string, unknown> | null
}): AnnotateBaseSource {
  switch (node.type) {
    case 'video': return 'video-frame'
    case 'audio': return 'waveform'
    case 'text': return 'text'
    default: return 'image'
  }
}
```

2. `composeAnnotatedImage.ts`：

```ts
export interface AnnotateMark { points: Array<{ x: number; y: number }> }

export function composeAnnotatedImage(
  base: CanvasImageSource | null,
  baseWidth: number,
  baseHeight: number,
  marks: AnnotateMark[],
): HTMLCanvasElement {
  if (!(baseWidth > 0) || !(baseHeight > 0)) throw new Error('底图尺寸非法')
  const canvas = document.createElement('canvas')
  canvas.width = baseWidth
  canvas.height = baseHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d 不可用')
  if (base) ctx.drawImage(base as CanvasImageSource, 0, 0, baseWidth, baseHeight)
  // 标记：半透明醒目色画笔（视觉锚点，agent 靠它定位）
  ctx.lineWidth = Math.max(4, Math.round(Math.min(baseWidth, baseHeight) / 120))
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(255, 64, 64, 0.92)'
  ctx.fillStyle = 'rgba(255, 64, 64, 0.18)'
  for (const mark of marks) {
    if (!mark.points.length) continue
    ctx.beginPath()
    ctx.moveTo(mark.points[0]!.x, mark.points[0]!.y)
    for (const p of mark.points.slice(1)) ctx.lineTo(p.x, p.y)
    if (mark.points.length === 1) {
      ctx.arc(mark.points[0]!.x, mark.points[0]!.y, ctx.lineWidth, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.stroke()
    }
  }
  return canvas
}
```

3. `MobileNodeAnnotateSheet.vue`：底部浮层（`position:fixed; bottom:0; z-index:92`（> viewer 的 90）），含：
   - 意见 textarea（`data-testid="mobile-annotate-opinion"`）
   - 主按钮「⚓ 带回对话」（`data-testid="mobile-annotate-send"`），图标用 `assets/icons/anchor-locate.png`（**CSS mask + currentColor**，与 `AgentSideRail.vue:6925-6932` 同款写法 ⇒ 满足 G-7）
   - `uploading` 时按钮禁用 + 文案「上传中…」
   - `degraded` 时显示一行说明「本条只带文字，未附截图」
   - emit `send: [payload: { opinion: string; imageBlob?: Blob; degraded: boolean }]` 与 `close: []`

4. `MobileNodeViewer.vue` 加标注态：
   - 底部一个「圈选」按钮（`data-testid="mobile-viewer-annotate"`）⇒ 点击进入标注态（`annotating = true`）
   - 标注态：单指 `touchstart/move/end` 收集点 ⇒ 画布上实时画笔迹（用 `<canvas>` 覆盖层）；**单指不再滚动/缩放**（`touch-action: none`）
   - 松手 ⇒ 打开 `MobileNodeAnnotateSheet`
   - 视频：先 `pause()` 再取当前帧（`videoRef.value` 画到 canvas；⚠️ `crossOrigin` 无 CORS 头 ⇒ `toBlob` 抛 `SecurityError` ⇒ **catch 后走 degraded 分支**）
   - 图片：底图须**同源化**（`sameOriginApiMediaUrl`）后再 `drawImage`
   - 音频：不进查看器 ⇒ 音频的标注入口在**磁贴**上（若本期不做磁贴入口，则音频标注本期**不做**，并在 §12 登记为后续包）

5. `pages/CanvasPage.vue` 接线：标注浮层的 `send` 回调 ⇒
   - 有 blob：`fileToPersistedPayload(new File([blob], 'annotate.png', { type: 'image/png' }))` ⇒ 得持久 URL
   - `useSidebarAttachments().addFromPayload({ id: randomId(), mediaType: 'image', sourceKind: 'canvasNode', label: nodeTitle, url, text: opinion, sourceNodeId: nodeId })`
   - `mobileAppTab.value = 'chat'`（切回对话页）
   - degraded（无 blob）：只加 `mediaType:'text'` 的引用（`text: opinion`），并 toast「本条只带文字，未附截图」

> ⚠️ **`addFromPayload` 的去重语义**：`useSidebarAttachments.addFromPayload` 会按 `url` 或 `sourceNodeId` 去重 ⇒ 同一节点**连续两次**标注会被吞掉第二次。⇒ 本实现必须给每次标注生成**不同的 `sourceNodeId`**（如 `${nodeId}#annotate-${n}`）或不同的 `url`（上传后天然不同）。**实施时先读 `useSidebarAttachments.ts:81-88` 确认，并写一条测试钉住"同节点两次标注都能进 composer"。**

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/composables/mobileAnnotateIntent.test.ts src/components/mobile/annotate/composeAnnotatedImage.test.ts src/components/mobile/MobileNodeAnnotateSheet.test.ts src/components/mobile/MobileNodeViewer.test.ts src/composables/useSidebarAttachments.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t7b.log 2>&1; echo EXIT=$?; tail -30 /tmp/t7b.log
cd apps/web && npx vue-tsc -b > /tmp/t7c.log 2>&1; echo TSC_EXIT=$?
```

> ⭐ **必须新增一条页面层测试钉住「同节点两次标注都能进 composer」**（`useSidebarAttachments.addFromPayload` 会按 `url` **或** `sourceNodeId` 去重 ⇒ 若两次标注用同一个 `sourceNodeId`，第二次会被**静默丢弃**）。建议写在 `apps/web/src/pages/CanvasPage.mobileAnnotateRef.test.ts`（静态契约形态），断言实现里存在「每次标注生成唯一 `sourceNodeId`」的逻辑（如 `${nodeId}#annotate-${counter}`）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/composables/mobileAnnotateIntent.ts apps/web/src/composables/mobileAnnotateIntent.test.ts apps/web/src/components/mobile/annotate/composeAnnotatedImage.ts apps/web/src/components/mobile/annotate/composeAnnotatedImage.test.ts apps/web/src/components/mobile/MobileNodeAnnotateSheet.vue apps/web/src/components/mobile/MobileNodeAnnotateSheet.test.ts apps/web/src/components/mobile/MobileNodeViewer.vue apps/web/src/components/mobile/MobileNodeViewer.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "feat(mobile): 标注层——手指自由圈选 + 带标记整图 + ⚓ 带回对话 (L1/M1)"
```

---

## Task 8: 引用芯片预览 + 行为级守卫（M3 固化）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSidebarRefChip.vue`（**只加不破**，PC/移动端共用）
- Create: `apps/web/src/components/mobile/mobileNodeInteraction.guards.test.ts`（**新增**：§10.2 的 12 条守卫集中化）

**Interfaces:**
- Consumes: 无
- Produces: 无新导出（纯守卫测试文件）

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/components/mobile/mobileNodeInteraction.guards.test.ts`（静态源码契约形态，参照仓库既有 `*.guard.test.ts` 写法）：

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, p), 'utf-8')
const policy = read('../composables/mobileNodeOpenPolicy.ts')
const viewer = read('./MobileNodeViewer.vue')
const editor = read('./MobileNodeEditorSheet.vue')
const policy2 = read('../composables/mobileNodeActionPolicy.ts')
const annotate = read('./MobileNodeAnnotateSheet.vue')

describe('移动端节点交互 · 行为级守卫（规格 §10.2 G-1..G-12）', () => {
  it('G-1 空节点 tap 不进编辑器（策略含 none 且 empty → none）', () => {
    expect(policy).toContain("'none'")
    expect(policy).toMatch(/state === 'generating'\)\s*return 'none'/)
  })

  it('G-2 长按是唯一管理入口：本体不铺锚/胶囊按钮', () => {
    expect(read('./MobileNodeTile.vue')).not.toContain('CanvasRefTargetIcon')
  })

  it('G-3 查看器同时有 X 与下滑关闭', () => {
    expect(viewer).toContain('mobile-viewer-close')
    expect(viewer).toMatch(/touchstart|touchmove/)
  })

  it('G-4 移动端编辑器不挂 PC studio dock，且无「生成」钮', () => {
    expect(editor).not.toContain('DockStudioRouter')
    expect(editor).not.toMatch(/生成/)
  })

  it('G-6/G-12 状态门控在策略层（generating 禁产物类操作）', () => {
    expect(policy2).toMatch(/state !== 'generating'/)
  })

  it('G-7 标注回传用 anchor-locate 品牌资产', () => {
    expect(annotate).toContain('anchor-locate.png')
  })

  it('G-13 音频不进查看器', () => {
    expect(viewer).not.toContain("'audio'")
  })
})
```

> ⚠️ 这些是**源码级**守卫（静态契约），是本仓库既有形态（如 `home-profile-p3.guard.test.ts`）。它们防的是「有人把 dock 又挂回来」这类回归，**不能**替代行为测试。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/mobileNodeInteraction.guards.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t8.log 2>&1; echo EXIT=$?; tail -25 /tmp/t8.log
```

Expected: FAIL —— 至少 G-2（瓦片无锚，当前可能已通过）、G-4 / G-7 视 Task 6/7 是否完成而定。**若某条已通过则该条不算失败**——只要有一条红即可。

- [ ] **Step 3: 最小实现**

1. `AgentSidebarRefChip.vue`：加**标注图**的缩略图预览分支——当 `refItem.mediaType === 'image'` 且 `refItem.text` 非空时，hover 预览区同时显示图 + 意见文本。**只加不破**：不动既有 PC 路径的渲染条件、不动既有 `data-testid`（PC 有既有快照测试）。
2. 若守卫测试有红项 ⇒ 回到对应任务补齐（**不要**改守卫让它绿）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/components/mobile/mobileNodeInteraction.guards.test.ts src/components/agent/AgentSidebarRefChip.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/t8b.log 2>&1; echo EXIT=$?; tail -25 /tmp/t8b.log
cd apps/web && npx vue-tsc -b > /tmp/t8c.log 2>&1; echo TSC_EXIT=$?
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/agent/AgentSidebarRefChip.vue apps/web/src/components/mobile/mobileNodeInteraction.guards.test.ts
git commit -m "test(mobile): 节点交互行为级守卫 12 条 + 引用芯片标注图预览"
```

---

## 交付与验收

**每个任务完成的标准**：该任务的 5 个 Step 全绿 + `vue-tsc -b` EXIT=0 + 本任务的测试单独跑通过 + 已 commit。

**整体完成的标准**：

```bash
# 全量前端测试（分块跑，避免占满整机）
cd apps/web && for chunk in "src/composables/mobile*.test.ts" "src/components/mobile/*.test.ts" "src/pages/CanvasPage.mobile*.test.ts"; do
  /Users/4seven/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run $chunk --maxWorkers=1 --no-file-parallelism > /tmp/all.log 2>&1
  echo "EXIT=$? $chunk"; grep -E "Tests |Test Files" /tmp/all.log | tail -2
done
cd apps/web && npx vue-tsc -b > /tmp/tsc.log 2>&1; echo TSC_EXIT=$?
```

**真机走查**：按规格 §10.3 的 21 项清单（W-1 … W-21）逐项勾选，**W-21 是源码断言**（移动端编辑器无 dock），其余需真机。

**PR 注意事项（规格 §11 R-1）**：
- PR 描述必须写明：**本 PR 会影响 `MobileNodeEditorSheet` 相关既有测试**（`DockStudioRouter` 的 `generate` 透传 / R4-T2 断链修复用例）—— 合并 master 后需同步他人 mock。
- PR 的 CI 跑 merge commit ⇒ 本地查不出「改了契约后他人 mock 撞车」⇒ 合并后立即跑一次全量。

**回滚**：Task 1–5 各自独立可回滚（改动面小、互不耦合）；Task 6 是**最大风险点**（改契约 + 改既有测试）⇒ 建议**单独成 PR**，与 Task 7 分开（Task 7 依赖 Task 6 的 `send-to-agent` 通道，但可先合 Task 6 再合 Task 7）。
