# 提议生成卡片 UX 优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把对话内「提议生成卡片」从只读通知重制为「对话决策中枢（proposal 卡）+ 画布执行面（artifact 卡增强）」——紧凑 proposal 卡（≈150px）+ 参数微调 Sheet，承载模型常驻（中性）、积分透明（A-now `estimateImageCredits(count,resolution)`，忽略 model）、长提示词折叠、取消/停止、定位弱链接、品牌三联叙事（跨双卡），零 wire 变更。

**Architecture:** 纯前端读取——对话卡经 `ProposalPart.nodeId` 从 `canvasEditor` store 解析画布节点 `data`（`prompt`/`label`/`params`/缩略/`creditCost`），不新增下发字段；确认/取消经 `AgentTurnTimeline` emit `confirmProposal`/`cancelProposal`，由 `AgentSideRail` 接手既有 `confirmProposeWait(nodeId)` / `cancelProposeForNode(nodeId, {note?})`（组件 `defineExpose` 方法）；停止生成经 `cancelGeneration(id)`（inject `CANVAS_NODE_CANCEL_KEY`）；重旋钮收进复用 `MobileSheet.vue` 的 `ProposeTuneSheet`。

**Tech Stack:** Vue 3 `<script setup>` + Pinia（`canvasEditor` store）+ Vitest + `design-tokens.css`（`--lnk-*` 仅）。无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-propose-card-ux-optimization-design.md`（v2.1）+ 参照 `docs/superpowers/specs/2026-11-02-propose-card-ux-optimization-mockup.html`

## Global Constraints

- 令牌只许 `--lnk-*`，**禁止 `--neo-*`**（spec §13.2）；深/浅双主题必须成立。
- 改组件后必跑 `vue-tsc -b`；改令牌相关样式跑 `design-token`/`text-token-guard`/`theme-usage`/`dead-styles` 四守卫。
- Vitest 用 **nvm node24 + `--maxWorkers=1 --no-file-parallelism`**，分批 ≤12 文件（4 核/8G，并发会假红/137）。
- 参数微调 Sheet **必须复用 `MobileSheet.vue`**，用 `v-if="open"` 控制显隐 + `:title` prop + `@close` emit，**绝不给 `<MobileSheet>` 传 `:open`**（它无此 prop）；禁第二套 sheet 皮肤。`ProposeTuneSheet` 自身可保留 `open`/`nodeId` prop 用于驱动 `v-if`。
- `prefers-reduced-motion` 必须支持；触控 ≥44px；图标内联 SVG（24 网格、stroke:2、圆角笔画），零第三方图标库。
- 零 wire 变更：Nest / pi-runtime 不动；`ProposalPart` / `ArtifactPart` 类型不变。
- 标题取节点 `title`/`label`（非提示词）；提示词只作 1 行预览。
- **积分 A-now：`estimateImageCredits(count, resolution?)`（来自 `@/constants/credits`），忽略 model**。严禁前端编造 model→积分映射；模型 chip 中性。C-later 服务端 `creditCost` 优先。
- **`CANVAS_NODE_CANCEL_KEY` 来自 `@/composables/canvasNodeActions.ts:24`**（注入键 `Symbol('canvasNodeCancel')`），`cancelGeneration` 经此注入（由 `CanvasPage.vue:5315` provide）。测试 `provide` 时用该键——**勿从 `useNodeGeneration.ts` 导入**（那里无此键）。
- **状态类方案（生产真值）**：proposal 卡根类 `state-pending_confirm`/`state-confirmed`/`state-declined`/`state-expired`；artifact 卡根类 `state-running`/`state-done`/`state-failed`。**mockup 的 `state-pending/generating/completed/declined` 是 5 态单卡示意，生产为 7 态双卡**——三联链 CSS 必须按「Cross-Check Reconciliation」表实现全部 7 态，不能直接照搬 mockup 的选择器（mockup 只亮了 4 态）。
- **触控 44px**：图标钮/主钮触控目标用 `--lnk-touch-target`(44px)，满足守卫；mockup 桌面默认用 `--lnk-control-md`(40px)，落地时改 44px。

## Review Focus

（spec 隐含但单测难覆盖、最可能咬人的输入/失败模式——每条已落到对应任务的测试）

1. **节点未同步到前端 store（`nodeId` 解析失败）**：降级为仅显节点名 + 「在画布查看」静默链接，不崩、不抛 → Task 2 测试断言 null 降级。
2. **SSE 断流**：对话卡不得显「生成失败」；`running` 状态仅由服务端 `tool_result` 翻面 → Task 2b 测试断言断流不触发 failed/declined 渲染。
3. **深/浅主题下锚 glyph 反相失效**：glyph 走 `mask`/`currentColor`，不写死色值 → Task 2 测试断言 glyph 用 `currentColor` 且 `color` 取自 `--lnk-*`。
4. **长提示词撑爆卡片**：卡片恒 1 行 ellipsis；完整文本仅进 Sheet/画布 → Task 2 测试断言卡片高度有界、提示词容器 `text-overflow:ellipsis` 单行。
5. **张数默认 1 不显、>1 才 chip 且积分联动（仅分辨率×张数）**：`imageCount===1` 时元信息无张数 chip；切到 >1 时 chip 出现且 `estimateImageCredits` 重算（model 不变时数字不变）→ Task 3 测试断言张数条件显示 + 积分随分辨率×张数联动。

---

### Cross-Check Reconciliation（plan ↔ mockup ↔ spec · 本轮审视补齐）

> 三份交付物已互洽，但存在 4 处会让实现走偏的「示意 vs 生产真值」错位，必须在此对齐后再开工。

**R-A · 状态→锚位映射（品牌滑动轨道，最易踩坑）**

品牌三联叙事从「三段圆点分点亮」升级为「**锚滑动轨道**」：卡片下方一条 `对话(左端)──锚(进度拇指)──画布(右端)` 轨道，锚图标（品牌 glyph）作为进度拇指，其水平位置由卡片根 `state-*` 类经 CSS 变量 `--p`（0→1）驱动，无需逐态手写点亮逻辑。

| 生产真值（双卡 7 态） | mockup 示意 | 锚位 `--p` | 轨道表现 | 引领 glyph |
|---|---|---|---|---|
| proposal `pending_confirm` | `state-pending` | `0` | 锚停对话端（未离对话） | 锚 glyph（currentColor） |
| proposal `confirmed` | （mockup 无独立卡） | `.18` | 锚离对话端起锚 | 锚 glyph |
| proposal `declined` | `state-declined` | `0` + dim(.5) | 锚留对话端、未扣减 | 锚 glyph 静音 |
| proposal `expired` | `state-expired` | `0` + dim(.5) | 锚留对话端、未扣减 | 锚 glyph 静音 |
| artifact `running` | `state-generating` | `.55` | 锚沿轨道滑行向画布 + 墨滴 trail | 锚 glyph |
| artifact `done` | `state-completed` | `1` | 锚落定画布端；画布图标变绿(success) + drop 动画 | 锚 glyph(绿) |
| artifact `failed` | `state-failed` | `.5` | 锚卡中途 + shake(红) | 锚 glyph(红) |

*实现要点：卡片根 `state-*` 类用生产真值；**锚位仅由 `.state-* .trilink-rail { --p: ... }` 一组 CSS 规则驱动**（mockup 已给出完整规则，可直接复用）。`end-canvas` 在 `done` 转 success 绿、`generating` 转 secondary；`declined/expired` 整轨 `opacity:.5`；`failed` 锚 thumb 转 danger 红 + shake。reduced-motion 下锚瞬移（`transition:none`）、保留 `role="img"` 文字标签。*

**R-B · 参数微调 Sheet 在 A-now 为「预览 + 估算」，不写回节点**

生产侧**没有** web 端写回节点 params 的函数（已 grep 确认 `apps/web/src` 无 `set_prefill_generation_params` 之类）。故：
- Sheet 以 `resolveProposalNodeData` 初始化 model/比例/分辨率/张数/风格/提示词，**仅本地预览 + 实时积分估算**；
- 「保存并确认」直接 emit `confirmProposal`（沿用节点既有 params），**A-now 不写回**；
- 真正改参数走「**在画布精修**」逃生钮 → 开 dock（既有写路径，符合 spec §5 不变式 2）。**该钮当前模板缺失，必须补**（见 Task 3）。

**R-C · `ProposeTuneSheet` 必须被挂载**

新建组件若无父级渲染则永不出现。由 `AgentTurnTimeline.vue` 在 parts 循环外渲染 `<ProposeTuneSheet :open="tuneSheetOpen" :node-id="tuneNodeId" @update:open="..." @confirm-proposal="(id)=>$emit('confirmProposal',id)">`，`tuneSheetOpen`/`tuneNodeId` 来自 `proposeWaitActions.ts`（见 Task 3 Step 4 + Task 4）。

**R-D · 测试必须 seed store，否则解析器返回 null**

`resolveProposalNodeData` 依赖 `canvasEditor` store。Task 2/3 的 mount 测试**必须 `setActivePinia` + 注入节点 n1**（与 Task 1 同款 `injectNode`），否则断言「节点名/模型/积分」全部落空。Task 2/3 测试已据此重写。

---

### Task 1: `useProposalNodeData` 解析 composable（TDD）

**Files:**
- Create: `apps/web/src/composables/useProposalNodeData.ts`
- Create: `apps/web/src/composables/useProposalNodeData.test.ts`

**Interfaces:**
- Consumes: `useCanvasEditor()` store（节点 `data`：`prompt`/`label`/`params`/`creditCost?`）；`estimateImageCredits` 来自 `@/constants/credits`（:28），签名 `estimateImageCredits(count = 1, resolution?)`。
- Produces: `resolveProposalNodeData(nodeId: string): ProposalNodeData | null`，其中
  `ProposalNodeData = { nodeId: string; title: string; prompt: string; modelId: string; aspectRatio: string; imageResolution: string; imageCount: number; style: string; creditCost: number; creditFromServer: boolean; thumbnail?: string; nodeType: string }`

- [ ] **Step 1: 核实真实数据形状（读，不写）**
  读 `apps/web/src/stores/canvasEditor.ts`（节点访问器与**真实 setter 名**——如 `upsertNodeForTest`/`addNode`/`setNode`，以 Step 5 测试能注入为准）、`apps/web/src/components/canvas/NodePendingPrompt.vue`（确认 `data.prompt`/`data.label` 字段名）、`apps/web/src/constants/credits.ts`（`estimateImageCredits` 实参格式）；参数键按 `nodeType`（image/video/audio）取（`imageResolution`/`imageCount`/`aspectRatio`/`style`/`modelId`）。
- [ ] **Step 2: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasEditor } from '@/stores/canvasEditor'
import { resolveProposalNodeData } from './useProposalNodeData'

// executor: 用 Step1 核实的真实 store setter 替换 upsertNodeForTest
const injectNode = (store: any, n: any) => (store as any).upsertNodeForTest?.(n) ?? (store as any).addNode?.(n) ?? (store as any).setNode?.(n)

describe('resolveProposalNodeData', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('解析 image 节点返回完整数据（标题取节点名）', () => {
    const store = useCanvasEditor()
    injectNode(store, {
      id: 'n1', type: 'image',
      data: { label: '产品主图', prompt: '极简电竞耳机主图',
        params: { modelId: 'realism-v2', aspectRatio: '1:1',
          imageResolution: '1024x1024', imageCount: 1, style: '写实' } },
    })
    const r = resolveProposalNodeData('n1')
    expect(r).not.toBeNull()
    expect(r!.title).toBe('产品主图')
    expect(r!.prompt).toBe('极简电竞耳机主图')
    expect(r!.modelId).toBe('realism-v2')
    expect(r!.imageCount).toBe(1)
    expect(r!.creditCost).toBeGreaterThan(0) // A-now：estimateImageCredits(count,res)
    expect(r!.creditFromServer).toBe(false)
  })

  it('节点不存在时降级返回 null', () => {
    expect(resolveProposalNodeData('ghost')).toBeNull()
  })

  it('imageCount 倍数联动积分（仅 count×resolution，与 model 无关）', () => {
    const store = useCanvasEditor()
    injectNode(store, { id: 'n2', type: 'image',
      data: { label: 'x', prompt: 'p', params: { modelId: 'realism-v2', aspectRatio: '1:1', imageResolution: '1024x1024', imageCount: 1, style: '写实' } } })
    const one = resolveProposalNodeData('n2')!.creditCost
    injectNode(store, { id: 'n4', type: 'image',
      data: { label: 'x', prompt: 'p', params: { modelId: 'realism-v2', aspectRatio: '1:1', imageResolution: '1024x1024', imageCount: 4, style: '写实' } } })
    const four = resolveProposalNodeData('n4')!.creditCost
    expect(four).toBe(one * 4)
  })

  it('服务端下发 creditCost 优先（C-later 接管位）', () => {
    const store = useCanvasEditor()
    injectNode(store, { id: 'n5', type: 'image',
      data: { label: 'x', prompt: 'p', creditCost: 99,
        params: { modelId: 'realism-v2', aspectRatio: '1:1', imageResolution: '1024x1024', imageCount: 1, style: '写实' } } })
    const r = resolveProposalNodeData('n5')!
    expect(r.creditCost).toBe(99)
    expect(r.creditFromServer).toBe(true)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/composables/useProposalNodeData.test.ts`
  Expected: FAIL（`resolveProposalNodeData` 未定义）
- [ ] **Step 4: 写最小实现**

```ts
import { useCanvasEditor } from '@/stores/canvasEditor'
import { estimateImageCredits } from '@/constants/credits' // A-now 唯一前端积分真源（忽略 model）

export interface ProposalNodeData {
  nodeId: string; title: string; prompt: string
  modelId: string; aspectRatio: string; imageResolution: string
  imageCount: number; style: string; creditCost: number
  creditFromServer: boolean; thumbnail?: string; nodeType: string
}

const PARAM_KEYS: Record<string, string[]> = {
  image: ['modelId', 'aspectRatio', 'imageResolution', 'imageCount', 'style'],
  video: ['modelId', 'aspectRatio', 'duration', 'style'],
  audio: ['modelId', 'duration', 'style'],
}

export function resolveProposalNodeData(nodeId: string): ProposalNodeData | null {
  const store = useCanvasEditor()
  const node = (store as any).getNode?.(nodeId) ?? (store as any).nodesById?.[nodeId]
  if (!node) return null
  const d = node.data ?? {}
  const keys = PARAM_KEYS[node.type] ?? PARAM_KEYS.image
  const params: Record<string, unknown> = {}
  for (const k of keys) if (d.params?.[k] !== undefined) params[k] = d.params[k]
  const imageCount = Number(params.imageCount ?? 1)
  const imageResolution = String(params.imageResolution ?? '')
  // A-now：本地估算（忽略 model）；C-later：服务端权威 creditCost 优先
  const serverCredit = typeof d.creditCost === 'number' ? d.creditCost : undefined
  const creditCost = serverCredit ?? estimateImageCredits(imageCount, imageResolution || undefined)
  return {
    nodeId,
    title: d.label ?? d.title ?? '提议生成',
    prompt: d.prompt ?? '',
    modelId: String(params.modelId ?? ''),
    aspectRatio: String(params.aspectRatio ?? ''),
    imageResolution,
    imageCount,
    style: String(params.style ?? ''),
    creditCost,
    creditFromServer: serverCredit !== undefined,
    thumbnail: d.thumbnail,
    nodeType: node.type,
  }
}
```

- [ ] **Step 5: 运行测试确认通过**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/composables/useProposalNodeData.test.ts`
  Expected: PASS（4/4）
- [ ] **Step 6: 提交**
  ```bash
  git add apps/web/src/composables/useProposalNodeData.ts apps/web/src/composables/useProposalNodeData.test.ts
  git commit -m "feat(agent): add useProposalNodeData resolver for proposal card"
  ```

---

### Task 2: 重制 `AgentTurnTimeline.vue` 的 proposal part（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue:363-404`
- Create: `apps/web/src/components/agent/AgentTurnTimeline.proposal.test.ts`

**Interfaces:**
- Consumes: `resolveProposalNodeData(nodeId)`（Task 1）；既有 `AgentTurnTimeline` emit `confirmProposal`/`cancelProposal`/`focusNode`（:42-43, :119）；既有 `proposeWaitActions` 的 `openProposeTuneSheet`（Task 3）。
- Produces: 渲染紧凑 proposal 卡（根类 `state-pending_confirm`/`state-confirmed`/`state-declined`/`state-expired`）+ 锚 glyph（emit `focusNode`）+ 三联链（proposal 段：对话✓·锚✓）+ `落锚生成`(emit confirmProposal)/`调整`(openProposeTuneSheet)/`取消`(emit cancelProposal) + `在画布查看节点` 弱链接（emit focusNode）；**proposal 卡只有 pending_confirm 可操作，无 generating/completed**（那些在 artifact 卡）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasEditor } from '@/stores/canvasEditor'
import AgentTurnTimeline from './AgentTurnTimeline.vue'

// 与 Task1 同款注入器（Step1 核实 store setter 名）
const injectNode = (store: any, n: any) =>
  (store as any).upsertNodeForTest?.(n) ?? (store as any).addNode?.(n) ?? (store as any).setNode?.(n)

function proposalPart(id: string, over: Record<string, unknown> = {}) {
  return { kind: 'proposal', id: `proposal:${id}`, nodeId: id, status: 'pending_confirm', ...over }
}

// R-D：解析器依赖 canvasEditor store，必须先 seed 节点 n1
beforeEach(() => {
  setActivePinia(createPinia())
  injectNode(useCanvasEditor(), {
    id: 'n1', type: 'image',
    data: { label: '产品主图', prompt: '极简电竞耳机主图',
      params: { modelId: 'realism-v2', aspectRatio: '1:1', imageResolution: '1024x1024', imageCount: 1, style: '写实' } },
  })
})

describe('proposal part 紧凑卡', () => {
  it('标题取节点名而非提示词，元信息含模型·比例·积分', () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('n1')] } })
    const card = w.find('[data-test="proposal-card"]')
    expect(card.text()).toContain('产品主图')
    expect(card.text()).not.toContain('极简电竞耳机主图')
    expect(card.text()).toMatch(/realism-v2/)
    expect(card.text()).toMatch(/1:1/)
    expect(card.text()).toMatch(/预计\s*\d+\s*积分/)
  })

  it('无自相矛盾文案', () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('n1')] } })
    expect(w.text()).not.toContain('等待你在画布上确认生成')
  })

  it('主操作三件套 + 定位弱链接齐全（emit 而非直接调 action）', async () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('n1')] } })
    await w.find('[data-test="confirm"]').trigger('click')
    await w.find('[data-test="cancel"]').trigger('click')
    await w.find('[data-test="locate-link"]').trigger('click') // 弱链接（区别于 header glyph）
    expect(w.emitted('confirmProposal')?.[0]).toEqual(['n1'])
    expect(w.emitted('cancelProposal')?.[0]).toEqual(['n1'])
    expect(w.emitted('focusNode')?.[0]).toEqual(['n1'])
  })

  it('header 锚 glyph 点击也 emit focusNode', async () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('n1')] } })
    await w.find('[data-test="locate-glyph"]').trigger('click')
    expect(w.emitted('focusNode')?.[0]).toEqual(['n1'])
  })

  it('提示词容器恒单行（single-line 类）', () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('n1', { prompt: 'x'.repeat(500) })] } })
    expect(w.find('[data-test="prompt-preview"]').classes()).toContain('single-line')
  })

  it('nodeId 解析失败降级不崩', () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('ghost')] } })
    expect(w.find('[data-test="proposal-card"]').exists()).toBe(true)
    expect(w.text()).toContain('在画布查看')
  })

  it('品牌锚 glyph 用 currentColor 且随主题反相', () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('n1')] } })
    const glyph = w.find('[data-test="anchor-glyph"]')
    expect(glyph.attributes('style') ?? '').toContain('currentColor')
  })

  it('终态 confirmed/declined/expired：操作禁用 + 未扣减删除线 + 仍可定位', () => {
    for (const st of ['confirmed', 'declined', 'expired'] as const) {
      const w = mount(AgentTurnTimeline, { props: { parts: [proposalPart('n1', { status: st })] } })
      expect(w.find('[data-test="confirm"]').exists()).toBe(false)
      expect(w.find('[data-test="cancel"]').exists()).toBe(false)
      if (st !== 'confirmed') expect(w.text()).toContain('未扣减')
      expect(w.find('[data-test="locate-link"]').exists()).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/components/agent/AgentTurnTimeline.proposal.test.ts`
  Expected: FAIL
- [ ] **Step 3: 实现模板与脚本**（替换 `:363-404` 整段；令牌全 `--lnk-*`，锚 glyph 用 `anchor-generate.png` + `mask`/`currentColor`；根类用真实 `part.status` → `state-pending_confirm`/`state-confirmed`/`state-declined`/`state-expired`；按 R-A 表实现**锚滑动轨道**：`.trilink-rail` + `.state-* .trilink-rail{--p}` 一组规则，复用 mockup 的 CSS）

```vue
<div class="proposal-card" :class="`state-${part.status ?? 'pending_confirm'}`" data-test="proposal-card">
  <header class="pc-head">
    <button class="lead" title="在画布中查看此节点" data-test="locate-glyph" @click="$emit('focusNode', nodeId)">
      <img class="anchor-glyph" data-test="anchor-glyph" :src="anchorGenerate" alt="" />
    </button>
    <div class="ttl">
      <div class="eyebrow">画布节点</div>
      <div class="name">{{ data?.title ?? '提议生成' }}</div>
    </div>
  </header>

  <div class="trilink-rail" role="img" aria-label="品牌链条：对话 → 锚（滑动）→ 画布">
    <span class="end end-conv" aria-hidden="true"><!-- 对话 icon --></span>
    <span class="track"><span class="trail"></span><span class="thumb" aria-hidden="true"><!-- 锚 glyph：anchor-generate.png via mask/currentColor；A-now 用内联 SVG 占位 --></span></span>
    <span class="end end-canvas" aria-hidden="true"><!-- 画布 icon --></span>
  </div>

  <div class="meta" v-if="data">
    <span class="chip model">{{ data.modelId }}</span>
    <span class="chip">{{ data.aspectRatio }}</span>
    <span class="chip credit" v-if="data.creditCost">预计 {{ data.creditCost }} 积分</span>
    <span class="chip" v-if="data.imageCount > 1">{{ data.imageCount }} 张</span>
  </div>

  <p class="prompt-preview single-line" data-test="prompt-preview">{{ data?.prompt }}</p>

  <div class="actions" v-if="part.status === 'pending_confirm'">
    <button class="btn btn-primary" data-test="confirm" @click="$emit('confirmProposal', nodeId)">落锚生成</button>
    <button class="icon-btn" data-test="tune" title="参数微调" @click="openTune(nodeId)"><!-- slider svg --></button>
    <button class="icon-btn" data-test="cancel" title="取消" @click="$emit('cancelProposal', nodeId)"><!-- xmark svg --></button>
  </div>

  <!-- 终态折叠行（confirmed/declined/expired）：操作禁用；declined/expired 显「未扣减」删除线 -->
  <div class="genrow" v-else>
    <span class="status-pill" :class="endStateClass(part.status)">{{ endStateLabel(part.status) }}</span>
    <span v-if="part.status !== 'confirmed'" class="status-pill credit struck">未扣减</span>
  </div>

  <a class="locate" data-test="locate-link" @click="$emit('focusNode', nodeId)">在画布查看节点</a>
</div>
```

脚本：`computed data = resolveProposalNodeData(props.part.nodeId)`；`openTune` → `openProposeTuneSheet`（Task 3）；`confirmProposal`/`cancelProposal`/`focusNode` 由组件 `defineEmits` 透传（**不在此直接调 action**，接线在 `AgentSideRail`）。

- [ ] **Step 4: 运行测试确认通过**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/components/agent/AgentTurnTimeline.proposal.test.ts`
  Expected: PASS（6/6）
- [ ] **Step 5: 提交**
  ```bash
  git add apps/web/src/components/agent/AgentTurnTimeline.vue apps/web/src/components/agent/AgentTurnTimeline.proposal.test.ts
  git commit -m "feat(agent): rework proposal card as compact decision hub with brand anchor"
  ```

---

### Task 2b: 增强 `AgentTurnTimeline.vue` 的 artifact part（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue`（artifact part 段 `:307-332`）
- Create: `apps/web/src/components/agent/AgentTurnTimeline.artifact.test.ts`

**Interfaces:**
- Consumes: 既有 artifact 渲染（:13 已接）；`cancelGeneration`（inject `CANVAS_NODE_CANCEL_KEY`，见 `useNodeGeneration.ts:408` / `CanvasPage.vue:5315`）；既有 `retryNode` emit（:122）；`focusNode` emit（:119）。
- Produces: `running` → 墨滴进度 + **停止生成**(调用 inject 的 `cancelGeneration(nodeId)`) + 在画布查看(emit focusNode) + 「预扣 N 积分」；`done` → **查看结果↗**(emit focusNode 到结果节点) + 消耗 N 积分 + 品牌画布段点亮(`state-done`)；`failed` → 重试(emit retryNode) + 未扣减删除线。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import { CANVAS_NODE_CANCEL_KEY } from '@/composables/canvasNodeActions' // Symbol 注入键（非 useNodeGeneration）

function artifactPart(id: string, over: Record<string, unknown> = {}) {
  return { kind: 'artifact', id: `artifact:${id}`, nodeId: id, status: 'running', title: '产品主图', ...over }
}

describe('artifact part 增强', () => {
  it('running 显 停止生成，点击调 inject 的 cancelGeneration', async () => {
    const cancelGeneration = vi.fn()
    const w = mount(AgentTurnTimeline, {
      props: { parts: [artifactPart('n1')] },
      global: { provide: { [CANVAS_NODE_CANCEL_KEY as symbol]: cancelGeneration } },
    })
    await w.find('[data-test="stop"]').trigger('click')
    expect(cancelGeneration).toHaveBeenCalledWith('n1')
  })

  it('done 显 查看结果↗ 回链 + 消耗积分', () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [artifactPart('n1', { status: 'done', url: 'x' })] } })
    expect(w.find('[data-test="view-result"]').exists()).toBe(true)
    expect(w.text()).toMatch(/消耗\s*\d+\s*积分/)
  })

  it('failed 显 重试(emit retryNode) + 未扣减', async () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [artifactPart('n1', { status: 'failed' })] } })
    await w.find('[data-test="retry"]').trigger('click')
    expect(w.emitted('retryNode')?.[0]).toEqual(['n1'])
    expect(w.text()).toContain('未扣减')
  })

  it('SSE 断流不误报失败', () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [artifactPart('n1', { status: 'running', sseDropped: true })] } })
    expect(w.text()).not.toContain('生成失败')
  })
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现 artifact 段**（按 R-A 表锚位映射 + 以下要点）→ Step 4: 运行通过 → Step 5: 提交**
  - 根类 `state-running`/`state-done`/`state-failed`；锚滑动轨道由 `.state-* .trilink-rail{--p}` 驱动：`running`=`.55` 滑行 + 墨滴 trail、`done`=`1` 落定画布(`end-canvas` 转 success 绿 + drop 动画)、`failed`=`.5` 卡中途 + shake(红)。
  - **引领 glyph 随态变**：`running`=锚 glyph 转 energy 色（或 spinner）；`done`=✓ 对勾 glyph（success）；`failed`=⚠ alert glyph（error）。
  - `running`：墨滴进度（`.inkfill>i` 锚滴伪元素）+ **停止生成**(icon-btn `data-test="stop"` → `cancelGeneration(nodeId)`，经 `CANVAS_NODE_CANCEL_KEY` inject) + **预扣 N 积分** pill（`data.creditCost` 或估算，半透明 `credit-soft`）+ 在画布查看(`emit focusNode`)。
  - `done`：**查看结果 ↗**(`data-test="view-result"`，emit `focusNode` 到结果节点) + 消耗 N 积分 + 品牌画布段点亮。
  - `failed`：错误文案 + **重试**(↻ icon，`data-test="retry"`，emit `retryNode`) + 「未扣减」删除线。

---

### Task 3: `ProposeTuneSheet.vue` + `openProposeTuneSheet`（TDD）

**Files:**
- Create: `apps/web/src/components/agent/ProposeTuneSheet.vue`
- Modify: `apps/web/src/components/agent/proposeWaitActions.ts`（新增 `openProposeTuneSheet`）
- Create: `apps/web/src/components/agent/ProposeTuneSheet.test.ts`

**Interfaces:**
- Consumes: `resolveProposalNodeData(nodeId)`（Task 1）；`MobileSheet.vue`（**无 `open` prop，用 `v-if` 控制显隐**，`title`/`subtitle?`/`maxHeight?` + `close` emit）。
- Produces: `openProposeTuneSheet(nodeId: string): void`（置 `tuneSheetOpen`/`tuneNodeId` ref）；Sheet 内 `保存并确认` emit `confirmProposal`；积分随**分辨率×张数**实时联动（**A-now 与 model 无关**）。
  - **R-B（预览-only，A-now 不写回节点）**：Sheet 仅以 `resolveProposalNodeData` 初始化并本地预览/估算；「保存并确认」直接 emit `confirmProposal`（沿用节点既有 params）。真正改参数走「**在画布精修**」逃生钮 → 开 dock（既有写路径，符合 spec §5 不变式 2）。**必须含「在画布精修」钮**（模板此前缺失）。

- [ ] **Step 1: 核实 `MobileSheet` API（读）**
  读 `apps/web/src/components/mobile/MobileSheet.vue`：props 仅 `title`/`subtitle?`/`maxHeight?`，emit 仅 `close`。**本组件用 `<MobileSheet v-if="open" :title="..." @close="...">` 复用，不自造 teleport**（MobileSheet 已 Teleport body）。
- [ ] **Step 2: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasEditor } from '@/stores/canvasEditor'
import ProposeTuneSheet from './ProposeTuneSheet.vue'

const injectNode = (store: any, n: any) =>
  (store as any).upsertNodeForTest?.(n) ?? (store as any).addNode?.(n) ?? (store as any).setNode?.(n)

beforeEach(() => {
  setActivePinia(createPinia())
  injectNode(useCanvasEditor(), {
    id: 'n1', type: 'image',
    data: { label: '产品主图', prompt: '极简电竞耳机主图',
      params: { modelId: 'realism-v2', aspectRatio: '1:1', imageResolution: '1024x1024', imageCount: 1, style: '写实' } },
  })
})
const extractCredit = (t: string) => Number((t.match(/消耗\s*(\d+)/) ?? [,'0'])[1])

describe('ProposeTuneSheet', () => {
  it('渲染模型/比例/分辨率/张数/风格 且默认张数=1 不显 chip', () => {
    const w = mount(ProposeTuneSheet, { props: { open: true, nodeId: 'n1' } })
    expect(w.text()).toContain('realism-v2')
    expect(w.text()).toContain('1:1')
    expect(w.text()).toContain('1024x1024')
    expect(w.text()).not.toContain('1 张')
    expect(w.find('[data-test="refine-dock"]').exists()).toBe(true) // R-B 逃生钮
  })

  it('切到 4 张时张数 chip 出现且积分随 count 联动（model 不变数字不变）', async () => {
    const w = mount(ProposeTuneSheet, { props: { open: true, nodeId: 'n1' } })
    const before = extractCredit(w.text())
    await w.find('[data-test="count-4"]').trigger('click')
    const after = extractCredit(w.text())
    expect(after).toBe(before * 4)
    expect(w.text()).toContain('4 张')
  })

  it('openProposeTuneSheet 置 open=true 并载入 nodeId', () => {
    const { openProposeTuneSheet, tuneSheetOpen, tuneNodeId } = await import('./proposeWaitActions')
    openProposeTuneSheet('n1')
    expect(tuneSheetOpen.value).toBe(true)
    expect(tuneNodeId.value).toBe('n1')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/components/agent/ProposeTuneSheet.test.ts`
  Expected: FAIL
- [ ] **Step 4: 实现**

```vue
<script setup lang="ts">
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import { ref, computed } from 'vue'
import { resolveProposalNodeData } from '@/composables/useProposalNodeData'
import { estimateImageCredits } from '@/constants/credits'
const props = defineProps<{ open: boolean; nodeId: string }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void; (e: 'confirmProposal', id: string): void; (e: 'refine-dock', id: string): void }>()
const data = computed(() => resolveProposalNodeData(props.nodeId))
const count = ref(data.value?.imageCount ?? 1)
// A-now：积分仅随分辨率×张数；model 维度留 C-later
const credit = computed(() => estimateImageCredits(count.value, data.value?.imageResolution || undefined))
</script>
<template>
  <MobileSheet v-if="open" :title="'参数微调'" @close="emit('update:open', false)">
    <!-- 模型 iOS 列表单选（中性，标注「积分暂不含模型维度」） / 比例分段(16:9/1:1/3:4/9:16) / 分辨率·尺寸(标准1024/高清1536/超清2048) / 风格(写实/扁平/水彩/胶片)：均带 data-test -->
    <div class="field"><label>张数（默认 1 不显于卡面）</label>
      <div class="seg-ctl">
        <button data-test="count-1" :class="{ on: count === 1 }" @click="count = 1">1 张</button>
        <button data-test="count-2" :class="{ on: count === 2 }" @click="count = 2">2 张</button>
        <button data-test="count-4" :class="{ on: count === 4 }" @click="count = 4">4 张</button>
      </div>
    </div>
    <p class="credit-live">本次预计消耗 {{ credit }} 积分</p>
    <details><summary>编辑提示词</summary><textarea>{{ data?.prompt }}</textarea></details>
    <div class="sheet-foot">
      <button class="btn btn-ghost" data-test="refine-dock" @click="emit('refine-dock', nodeId)">在画布精修</button>
      <button class="btn btn-primary" @click="emit('confirmProposal', nodeId)">保存并确认</button>
    </div>
  </MobileSheet>
</template>
```

> **R-C 挂载点（必做）**：在 `AgentTurnTimeline.vue` parts 循环**外**渲染 `<ProposeTuneSheet :open="tuneSheetOpen" :node-id="tuneNodeId" @update:open="tuneSheetOpen = $event" @confirm-proposal="(id)=>$emit('confirmProposal', id)" @refine-dock="(id)=>$emit('focusNode', id)" />`，`tuneSheetOpen`/`tuneNodeId` 从 `proposeWaitActions.ts` 引入。这样 Sheet 的「保存并确认」经既有 `confirmProposal` emit 上行到 `AgentSideRail`；「在画布精修」经 `focusNode` 把用户带向画布 dock（R-B 写路径）。

`proposeWaitActions.ts` 新增：

```ts
import { ref } from 'vue'
export const tuneSheetOpen = ref(false)
export const tuneNodeId = ref<string | null>(null)
export function openProposeTuneSheet(nodeId: string) {
  tuneNodeId.value = nodeId
  tuneSheetOpen.value = true
}
```

- [ ] **Step 5: 运行测试确认通过**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/components/agent/ProposeTuneSheet.test.ts`
  Expected: PASS
- [ ] **Step 6: 提交**
  ```bash
  git add apps/web/src/components/agent/ProposeTuneSheet.vue apps/web/src/components/agent/proposeWaitActions.ts apps/web/src/components/agent/ProposeTuneSheet.test.ts
  git commit -m "feat(agent): add ProposeTuneSheet reusing MobileSheet with live credit"
  ```

---

### Task 4: 接线确认/取消/停止 到既有实现（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue`（Task 2/2b 已引入 emit）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（确认现有 `@confirm-proposal`→`confirmProposeWait` / `@cancel-proposal`→`cancelProposeForNode` 接线，若缺失则补）
- Create: `apps/web/src/components/agent/AgentTurnTimeline.wiring.test.ts`

**Interfaces:**
- Consumes: 既有 `AgentSideRail.confirmProposeWait(nodeId)`（:1223）/ `cancelProposeForNode(nodeId, {note?})`（:1185），`defineExpose`；`cancelGeneration`（inject `CANVAS_NODE_CANCEL_KEY`）。
- Produces: `AgentTurnTimeline` 的 `confirmProposal`/`cancelProposal`/`focusNode`/`retryNode` emit 被 `AgentSideRail` 正确接手；artifact 停止 → `cancelGeneration`。**无新语义、无 `actions` 模块**。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import { CANVAS_NODE_CANCEL_KEY } from '@/composables/canvasNodeActions' // Symbol 注入键

describe('proposal/artifact 接线', () => {
  it('AgentTurnTimeline 确认 emit confirmProposal（不自行调 action）', async () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [{ kind: 'proposal', id: 'p1', nodeId: 'n1', status: 'pending_confirm' }] } })
    await w.find('[data-test="confirm"]').trigger('click')
    expect(w.emitted('confirmProposal')?.[0]).toEqual(['n1'])
  })
  it('取消 emit cancelProposal', async () => {
    const w = mount(AgentTurnTimeline, { props: { parts: [{ kind: 'proposal', id: 'p1', nodeId: 'n1', status: 'pending_confirm' }] } })
    await w.find('[data-test="cancel"]').trigger('click')
    expect(w.emitted('cancelProposal')?.[0]).toEqual(['n1'])
  })
  it('artifact 停止 emit 经 inject 调用 cancelGeneration', async () => {
    const cancelGeneration = vi.fn()
    const w = mount(AgentTurnTimeline, {
      props: { parts: [{ kind: 'artifact', id: 'a1', nodeId: 'n1', status: 'running' }] },
      global: { provide: { [CANVAS_NODE_CANCEL_KEY]: cancelGeneration } },
    })
    await w.find('[data-test="stop"]').trigger('click')
    expect(cancelGeneration).toHaveBeenCalledWith('n1')
  })
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现**（AgentSideRail 中确认/补全 `@confirm-proposal="confirmProposeWait"` / `@cancel-proposal="(id)=>cancelProposeForNode(id)"`；artifact 停止在 Task 2b 已完成 inject 调用；**ProposeTuneSheet 经 R-C 挂载点转发的 `confirmProposal`/`focusNode` 也落入同一套 AgentSideRail 接线**）→ Step 4: 运行通过 → Step 5: 提交（同 Task 2 文件，独立提交更清晰）

> ⚠️ **严禁** `vi.spyOn(actions, 'confirmProposeWait')` / `actions.decline` / `actions.abortGeneration`——前者无 `actions` 模块，后两者命名不存在（真实为 `confirmProposeWait`/`cancelProposeForNode`/`cancelGeneration`）。

---

### Task 5: 质量闸门 + Frontend Design Optimizer 打磨

**Files:** 无新增；可能微调 `AgentTurnTimeline.vue` / `ProposeTuneSheet.vue` 样式。

- [ ] **Step 1: 跑四令牌守卫**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/styles/design-token.test.ts apps/web/src/styles/theme-usage.test.ts apps/web/src/styles/text-token-guard.test.ts apps/web/src/styles/dead-styles.test.ts`
  Expected: 全绿；若有 `--neo-*` 或缺失成对令牌，改回 `--lnk-*`。
- [ ] **Step 2: 类型闸门**
  Run: `pnpm -r --filter @lnkpi/web exec vue-tsc -b`
  Expected: 无类型错误。
- [ ] **Step 3: 全量单测**
  Run: `nvm use 24 && pnpm vitest run apps/web/src/components/agent apps/web/src/composables`
  Expected: 全绿。
- [ ] **Step 4: 加载 Frontend Design Optimizer 做 polish pass**
  调用 `frontend-design-optimizer`：对照 mockup 核查 8 维度，重点——对比度（credit/accent 文字）、focus-visible 环、reduced-motion（Sheet 滑入/墨滴进度降级）、触控 44px（图标钮/主钮用 `--lnk-touch-target`，非 mockup 的 40px）、深/浅 token 成立、锚 glyph 反相、**锚滑动轨道 7 态锚位**（R-A 表：`--p` 由 `.state-*` 驱动，mockup 已给完整规则，复用即可）。产出修改直接落组件。
- [ ] **Step 5: 复跑 Step1–3 确认仍绿，提交打磨**
  ```bash
  git add -A apps/web/src/components/agent apps/web/src/composables
  git commit -m "style(agent): polish proposal card per design-token guards + a11y"
  ```

---

### Task 6（可选，需 Settings→Agent→Browser control 开启）: 真机截图对照

- [ ] **Step 1:** 起 dev server，`workbuddy-browser-use` 打开对话页，触发一次 propose_generation。
- [ ] **Step 2:** 截图 proposal(pending/confirmed/declined/expired) + artifact(running/done/failed) + 深/浅 + 移动端 Sheet，与 `mockup.html` 逐像素 diff。
- [ ] **Step 3:** 不达标项回到 Task 5 修。

---

## Self-Review（写毕自检 · 已按生产最新代码复核）

**1. Spec 覆盖：** §1 四目标→Task2(proposal)/2b(artifact)/3(Sheet)/4(接线)；§2.2→Task2/2b/3；§2.5 品牌跨双卡→Task2(proposal 段)+2b(artifact 画布段)；§3 R1–R10→Task1(解析)/2(proposal)/2b(artifact)/3(Sheet/积分/张数)/4(动作)；§4 状态机(双图)+按钮审计→Task2/2b/4；§7 文件清单 #1/#1'/#1b/#2/#3/#4/#5/#5'→Task1/2/2b/3/4；§8 验收 A1–A14→测试映射齐全；§9 风险→Review Focus 已落测试。✅
**2. 占位符扫描：** 无 TBD/TODO；每个代码步均有实际片段；`estimateImageCredits`/`MobileSheet` API/`store setter` 标为 Step1 读核实（属允许的实现前核实）。✅
**3. 类型一致性：** `resolveProposalNodeData`/`ProposalNodeData` 在 Task1 定义，Task2/3 复用；`openProposeTuneSheet` 在 Task3 定义，Task2 调用；emit `confirmProposal`/`cancelProposal`/`focusNode`/`retryNode` 贯穿 Task2/2b/4；`confirmProposeWait`/`cancelProposeForNode`/`cancelGeneration` 为既有实现（非 `actions` 模块）。✅
**4. Review Focus：** 5 条全部已映射到 Task2/2b/3 测试（降级 null / SSE 不误报 / glyph currentColor / 单行预览 / 张数联动）。✅
**5. 接口真实性（本轮重点复核，已修正旧版错误）：**
   - ✅ 积分：`estimateImageCredits(count, resolution?)` 来自 `@/constants/credits`（非 `@/services/pricing` 幻影）；`creditCost` 服务端优先、本地兜底。
   - ✅ MobileSheet：用 `v-if="open"` + `:title` + `@close`，**不**传 `:open` prop。
   - ✅ 动作名：`confirmProposeWait`/`cancelProposeForNode`（AgentSideRail 实例方法）/ `cancelGeneration`（inject）；无 `actions.decline`/`abortGeneration`。
   - ✅ 接线：proposal/artifact 经 **emit** 由 AgentSideRail 接手，测试用 `emitted(...)` 断言，非 `vi.spyOn(actions,...)`。
   - ✅ `CANVAS_NODE_CANCEL_KEY` 来自 `@/composables/canvasNodeActions`（Symbol），测试 `provide` 已修正（非 `useNodeGeneration`）。

**6. 本轮审视补齐（Cross-Check Reconciliation，已落计划）：**
   - ✅ **状态类错位**：mockup 5 态单卡 ↔ 生产 7 态双卡；品牌叙事升级为「锚滑动轨道」，新增 R-A 表（状态→锚位 `--p` 映射），锚位由 `.state-* .trilink-rail{--p}` 一组 CSS 驱动，mockup 已给完整规则，落地直接复用。
   - ✅ **测试 seed store**：Task 2/3 测试已补 `setActivePinia` + `injectNode(n1)`，否则解析器返 null 致断言落空（R-D）。
   - ✅ **`data-test` 碰撞**：header glyph(`locate-glyph`) 与弱链接(`locate-link`) 已拆分，测试改用 `locate-link`。
   - ✅ **Sheet 预览-only + 逃生钮**：R-B 明确 A-now 不写回节点；模板补「在画布精修」(`refine-dock`) 钮并 emit 至 dock 写路径。
   - ✅ **`ProposeTuneSheet` 挂载点**：R-C 明确在 `AgentTurnTimeline` 渲染并转发 `confirmProposal`/`focusNode`，否则 Sheet 永不出现。
   - ✅ **终态覆盖**：Task 2 新增 confirmed/declined/expired 渲染 + 禁用/未扣减断言。
   - ✅ **44px 触控**：图标钮/主钮改用 `--lnk-touch-target`（mockup 桌面 40px 不达标）。
   - ✅ 状态枚举：proposal 用 `pending_confirm`（非 `pending`），无 `generating`；`running/done/failed` 属 artifact part（已拆为 Task 2b）。

---

## 实施完成 Ledger（2026-11-02 收官）

**分支** `feat/propose-card-ux-optimization`（BASE `7eb85708`）。全部 16 笔提交，51/51 组件测试绿 + vue-tsc 0 错。

### 相对计划的裁决修订（偏离记录）

| 计划原文 | 实际落地 | 裁决依据 |
|---|---|---|
| R-B：Sheet 张数 preview-only，确认按节点原参数执行 | **全部真写回**：`CANVAS_NODE_PATCH_KEY` 契约放宽 `void \| Promise<boolean>`，CanvasPage `patchNodeMediaById` 升级 `await persistUserEditAsync`，确认=脏检查→await 落库→成功才 `confirmProposal` | 用户拍板「对话提议卡=首次生成的参数调整面」；preview-only 存在预览≠实际扣费的诚实性陷阱 |
| 张数为 Sheet 唯一可调项 | **四字段全接**：模型（catalog 归一 ref）/比例/分辨率（ImageParamsSelector 静态枚举）/提示词（清空≠修改） | 图片侧静态枚举现成（「比例无静态合法值表」判断仅对视频侧成立） |
| 视觉：标准多彩 | **极简（iOS 式）+ 品牌徽章（双层雕刻）定稿回写组件**，对比切换器退役 | 用户两轮评审拍板；语义色单点纪律 |
| 双卡：confirmed 提议卡 + artifact 执行卡全尺寸并存 | **执行卡在场时提议卡塌缩单行凭据**（✓已落锚+标题+画布回链） | 用户实测「为什么有两张卡」读作渲染事故；纯呈现层收敛 |
| 定位入口：locate-glyph + locate-link + CanvasLocateButton 多入口 | **每卡一个**：proposal 卡=页脚 tether（`<a>`→`<button>` 保键盘可达）；artifact 卡=CanvasLocateButton | 同一 `focusNode` emit 三个皮肤属迭代堆积 |
| 生成卡：墨滴进度条 | **墨滴条退役**，锚轨=唯一进度载体（不定态流光+作业脉冲） | 双滑轨冗余 |
| ——（计划未覆盖） | **模态感知**：video/audio 提议卡半接（模型+提示词写回，字段随模态分流），videoSettings/audioKind 只读真值；capability 全接记 C-later | propose_generation 覆盖三模态，图片硬编存在字段错配（video 节点误写 imageModel） |

### 提交清单

`2ffca806` Task2 数据纯函数 → `bb977295`/`45ddd832`/`e4af02e0` Task2 卡片 → `fa558de1`/`36c4d7a8` Task2b artifact → `817a9421` Task3 Sheet → `3c4c6e3d` 截图审查修复 → `47bfdefd` 图标重绘 → `1d603245` 徽章双层雕刻 → `563b6663` 墨滴退役 → `5b64ca3a` 双卡折叠 → `e2e8334e` 极简定稿 → `3f425714` 定位收敛 → `8638674a` 张数真写回 → `6aba40e5` 四字段全接 → `08c91cdc` 模态感知 → docs（本次）。

### 生产复测清单（S1–S7，7 状态矩阵）

| # | 状态 | 服务端可验证 | 需人工 UI |
|---|---|---|---|
| S1 | proposal pending_confirm | 卡渲染+参数真值（节点数据比对） | ✓ 卡片交互 |
| S2 | proposal confirmed→running（折叠凭据+单轨） | PATCH 写回后节点 imageCount/aspect/resolution/prompt 落库 | ✓ |
| S3 | artifact running（单轨流光+停止） | 生成记录 running、无重复进度 | ✓ |
| S4 | artifact done（绿锚+消耗积分） | 生成记录 done、积分扣减 | ✓ |
| S5 | artifact failed（红锚+未扣减+重试） | 记录 failed、积分退回 | ✓ |
| S6 | proposal declined/expired（熄灯凭据+未扣减） | 无生成记录、无扣费 | ✓ |
| S7 | video/audio 提议（模态感知） | 写回字段名=videoModel/audioModel | ✓ |
