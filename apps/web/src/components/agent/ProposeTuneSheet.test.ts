import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ProposeTuneSheet from './ProposeTuneSheet.vue'
import { openProposeTuneSheet, tuneSheetOpen, tuneNodeId } from './proposeWaitActions'
import { CANVAS_NODE_PATCH_KEY } from '@/composables/canvasNodeActions'
import type { ProposalCanvasNode } from '@/composables/useProposalNodeData'

/**
 * 参数微调 Sheet（2026-11-02 卡片 UX 优化 · R9）。
 *
 * ledger R1/R2 修正：节点数据经 `canvasNodes` prop 传入，**不用 Pinia /
 * canvasEditor store**（精修编辑器 store，不含画布节点）。字段为扁平 data
 * （实证 useNodeGeneration），非嵌套 params。
 * Teleport：沿用仓库既有模式 `stubs: { teleport: true }`（MobileNodeEditorSheet 同款），
 * 内容留在组件树内，`w.find` 可达。
 * 职责边界（2026-11-02 PM 裁决两轮修订）：Sheet = 首次生成参数调整面，
 * 模型/比例/分辨率/提示词/张数五项**真写回**——确认前经 CANVAS_NODE_PATCH_KEY
 * 落库，成功才 emit confirmProposal；失败不确认并报错。风格仍只读走画布精修。
 */

const seedNode: ProposalCanvasNode = {
  id: 'n1',
  type: 'image',
  data: {
    label: '产品主图',
    prompt: '极简电竞耳机主图',
    imageModel: 'navo-pro', // catalog 真实条目（resolveGenerationModel 可归一）
    imageAspect: '1:1',
    imageResolution: '2K',
    imageCount: 1,
    style: '写实',
  },
}

/** 视频提议节点（videoSettings 内面，实证 VideoDockPanel / CanonicalVideoSettings）。 */
const videoNode: ProposalCanvasNode = {
  id: 'v1',
  type: 'video',
  data: {
    label: '产品短片',
    prompt: '暮光公路飞驰',
    videoModel: 'agnes-video-v2.0',
    videoSettings: { duration: 5, aspectRatio: '16:9', resolution: '1080p', crop: '16:9' },
  },
}

/** 音频提议节点（audioKind 语义实证 studioModelCatalog：'voice'）。 */
const audioNode: ProposalCanvasNode = {
  id: 'a1',
  type: 'audio',
  data: {
    label: '产品旁白',
    prompt: '低沉男声旁白',
    audioModel: 'seed-audio-1.0',
    audioKind: 'voice',
  },
}

function mountSheet(
  over: {
    open?: boolean
    nodeId?: string | null
    canvasNodes?: ProposalCanvasNode[]
    patchNode?: (nodeId: string, patch: Record<string, unknown>) => void | Promise<boolean>
  } = {},
) {
  const provide: Record<symbol, unknown> = {}
  if (over.patchNode !== undefined) provide[CANVAS_NODE_PATCH_KEY as symbol] = over.patchNode
  return mount(ProposeTuneSheet, {
    props: {
      open: over.open ?? true,
      nodeId: over.nodeId ?? 'n1',
      canvasNodes: over.canvasNodes ?? [seedNode],
    },
    global: { stubs: { teleport: true }, provide },
  })
}

const extractCredit = (t: string) => Number((t.match(/消耗\s*(\d+)/) ?? [, '0'])[1])

describe('ProposeTuneSheet', () => {
  it('四字段装配：模型/比例下拉有值、分辨率 2K 选中、风格只读、张数=1 不显 chip + 逃生钮', () => {
    const w = mountSheet()
    const modelSel = w.find('[data-test="sel-model"]')
    expect(modelSel.exists()).toBe(true)
    expect((modelSel.element as HTMLSelectElement).value).not.toBe('')
    const aspectSel = w.find('[data-test="sel-aspect"]')
    expect((aspectSel.element as HTMLSelectElement).value).toBe('1:1')
    expect(w.find('[data-test="res-2K"]').classes()).toContain('on')
    expect(w.text()).toContain('写实')
    expect(w.text()).not.toContain('1 张')
    expect(w.find('[data-test="refine-dock"]').exists()).toBe(true)
  })

  it('切到 4 张：张数 chip 出现且积分随 count 联动（2K 档 15/张）', async () => {
    const w = mountSheet()
    const before = extractCredit(w.text())
    expect(before).toBe(15) // 1 张 × 2K（shared 单一真源：1K=10 / 2K=15 / 4K=20 每张）
    await w.find('[data-test="count-4"]').trigger('click')
    const after = extractCredit(w.text())
    expect(after).toBe(before * 4)
    expect(w.text()).toContain('4 张')
    // 脏态按钮文案：明示「保存修改并确认」（诚实性：用户知道会写回）
    expect(w.find('[data-test="confirm"]').text()).toContain('保存修改并确认')
  })

  it('改分辨率：积分即时换档（2K→4K=20/张），且单独构成 dirty', async () => {
    const w = mountSheet()
    await w.find('[data-test="res-4K"]').trigger('click')
    expect(extractCredit(w.text())).toBe(20)
    expect(w.find('[data-test="confirm"]').text()).toContain('保存修改并确认')
  })

  it('改比例+分辨率+提示词：patch 仅含差异字段，成功才确认', async () => {
    const patchNode = vi.fn(async () => true)
    const w = mountSheet({ patchNode })
    await w.find('[data-test="sel-aspect"]').setValue('16:9')
    await w.find('[data-test="res-4K"]').trigger('click')
    await w.find('[data-test="prompt-input"]').setValue('暮光海岸公路上的红色跑车')
    await w.find('[data-test="confirm"]').trigger('click')
    expect(patchNode).toHaveBeenCalledWith('n1', {
      imageAspect: '16:9',
      imageResolution: '4K',
      prompt: '暮光海岸公路上的红色跑车',
    })
    expect(w.emitted('confirmProposal')).toEqual([['n1']])
  })

  it('改模型：patch.imageModel 写归一 ref（与 ImageDockPanel 写回同形，杜绝编码态≠比较态）', async () => {
    const patchNode = vi.fn(async () => true)
    const w = mountSheet({ patchNode })
    const sel = w.find('[data-test="sel-model"]')
    const current = (sel.element as HTMLSelectElement).value
    const other = sel.findAll('option').map((o) => o.element.value).find((v) => v !== current)
    expect(other, 'catalog 应有 ≥2 个图片模型候选').toBeTruthy()
    await sel.setValue(other as string)
    await w.find('[data-test="confirm"]').trigger('click')
    expect(patchNode).toHaveBeenCalledWith('n1', { imageModel: other })
    expect(w.emitted('confirmProposal')).toEqual([['n1']])
  })

  it('清空提示词不视为修改（空 prompt 必然生成失败，写回无意义）：快路径直确认', async () => {
    const patchNode = vi.fn(async () => true)
    const w = mountSheet({ patchNode })
    await w.find('[data-test="prompt-input"]').setValue('   ')
    await w.find('[data-test="confirm"]').trigger('click')
    expect(patchNode).not.toHaveBeenCalled()
    expect(w.emitted('confirmProposal')).toEqual([['n1']])
  })

  // —— 模态感知（2026-11-02 音视频半接裁决） ——

  it('video 提议：模型下拉来自 video 清单、比例/分辨率/时长只读真值、无张数与风格行', () => {
    const w = mountSheet({ nodeId: 'v1', canvasNodes: [videoNode] })
    const sel = w.find('[data-test="sel-model"]')
    expect(sel.exists()).toBe(true)
    // videoModel 归一后应落在 video 清单内（而非 image 清单回落）
    const values = sel.findAll('option').map((o) => o.element.value)
    expect(values).toContain((sel.element as HTMLSelectElement).value)
    expect(w.find('[data-test="ro-video-aspect"]').text()).toBe('16:9')
    expect(w.find('[data-test="ro-video-resolution"]').text()).toBe('1080p')
    expect(w.find('[data-test="ro-video-duration"]').text()).toBe('5s')
    expect(w.find('[data-test="count-1"]').exists()).toBe(false)
    expect(w.find('[data-test="field-style"]').exists()).toBe(false)
    expect(w.find('[data-test="sel-aspect"]').exists()).toBe(false)
    // 积分=时长档（≤10s=30）
    expect(extractCredit(w.text())).toBe(30)
  })

  it('video 写回字段分流：改模型+提示词 → patch {videoModel, prompt}，不再误写 imageModel（错配回归）', async () => {
    const patchNode = vi.fn(async () => true)
    const w = mountSheet({ nodeId: 'v1', canvasNodes: [videoNode], patchNode })
    const sel = w.find('[data-test="sel-model"]')
    const current = (sel.element as HTMLSelectElement).value
    const other = sel.findAll('option').map((o) => o.element.value).find((v) => v !== current)
    expect(other, 'catalog 应有 ≥2 个视频模型候选').toBeTruthy()
    await sel.setValue(other as string)
    await w.find('[data-test="prompt-input"]').setValue('海岸公路日落航拍')
    await w.find('[data-test="confirm"]').trigger('click')
    expect(patchNode).toHaveBeenCalledWith('v1', { videoModel: other, prompt: '海岸公路日落航拍' })
    expect(w.emitted('confirmProposal')).toEqual([['v1']])
  })

  it('audio 提议：模型下拉 audio 清单、类型只读、无比例/分辨率/积分行；写回 audioModel', async () => {
    const patchNode = vi.fn(async () => true)
    const w = mountSheet({ nodeId: 'a1', canvasNodes: [audioNode], patchNode })
    expect(w.find('[data-test="ro-audio-kind"]').text()).toBe('voice')
    expect(w.find('[data-test="sel-aspect"]').exists()).toBe(false)
    expect(w.find('[data-test="credit-live"]').exists()).toBe(false)
    const sel = w.find('[data-test="sel-model"]')
    const current = (sel.element as HTMLSelectElement).value
    const other = sel.findAll('option').map((o) => o.element.value).find((v) => v !== current)
    await sel.setValue(other as string)
    await w.find('[data-test="confirm"]').trigger('click')
    expect(patchNode).toHaveBeenCalledWith('a1', { audioModel: other })
    expect(w.emitted('confirmProposal')).toEqual([['a1']])
  })

  it('无改动确认：快路径直接 emit confirmProposal，不调 patch 通道', async () => {
    const patchNode = vi.fn(async () => true)
    const w = mountSheet({ patchNode })
    await w.find('[data-test="confirm"]').trigger('click')
    expect(w.emitted('confirmProposal')).toEqual([['n1']])
    expect(patchNode).not.toHaveBeenCalled()
  })

  it('真写回（PM 裁决 2026-11-02）：改张数确认 → 先 patch {imageCount} 落库，成功才 emit confirmProposal', async () => {
    const patchNode = vi.fn(async () => true)
    const w = mountSheet({ patchNode })
    await w.find('[data-test="count-4"]').trigger('click')
    await w.find('[data-test="confirm"]').trigger('click')
    expect(patchNode).toHaveBeenCalledWith('n1', { imageCount: 4 })
    expect(w.emitted('confirmProposal')).toEqual([['n1']])
  })

  it('写回失败：不 emit confirmProposal，显式报错（诚实性：预览=实际）', async () => {
    const patchNode = vi.fn(async () => false)
    const w = mountSheet({ patchNode })
    await w.find('[data-test="count-2"]').trigger('click')
    await w.find('[data-test="confirm"]').trigger('click')
    expect(patchNode).toHaveBeenCalledOnce()
    expect(w.emitted('confirmProposal')).toBeUndefined()
    expect(w.find('[data-test="confirm-error"]').exists()).toBe(true)
    expect(w.text()).toContain('参数保存失败')
  })

  it('patch 通道抛异常：等同失败，不 emit 确认', async () => {
    const patchNode = vi.fn(async () => {
      throw new Error('network')
    })
    const w = mountSheet({ patchNode })
    await w.find('[data-test="count-2"]').trigger('click')
    await w.find('[data-test="confirm"]').trigger('click')
    expect(w.emitted('confirmProposal')).toBeUndefined()
    expect(w.find('[data-test="confirm-error"]').exists()).toBe(true)
  })

  it('无 patch 通道（旧宿主/独立渲染）且有改动：不静默丢弃——报「通道未就绪」不确认', async () => {
    const w = mountSheet() // 不提供 patchNode
    await w.find('[data-test="count-2"]').trigger('click')
    await w.find('[data-test="confirm"]').trigger('click')
    expect(w.emitted('confirmProposal')).toBeUndefined()
    expect(w.text()).toContain('画布通道未就绪')
  })

  it('「在画布精修」emit refine-dock（R-C 接线映射 focusNode → 画布 dock 写路径）', async () => {
    const w = mountSheet()
    await w.find('[data-test="refine-dock"]').trigger('click')
    expect(w.emitted('refine-dock')).toEqual([['n1']])
  })

  it('MobileSheet close → emit update:open(false)', async () => {
    const w = mountSheet()
    await w.find('[data-testid="m-sheet-close"]').trigger('click')
    expect(w.emitted('update:open')?.[0]).toEqual([false])
  })

  it('open=false 不渲染任何 sheet 内容', () => {
    const w = mountSheet({ open: false })
    expect(w.find('[data-test="refine-dock"]').exists()).toBe(false)
  })

  it('nodeId 解析失败降级不崩：字段显占位、确认仍可用（与对话卡降级一致）、逃生钮在', () => {
    const w = mountSheet({ nodeId: 'ghost' })
    // ghost 有 nodeId（节点缺失只是数据降级），确认不因此禁用——与对话卡行为一致
    expect(w.find('[data-test="confirm"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test="refine-dock"]').exists()).toBe(true)
    expect(w.text()).toContain('在画布精修')
  })

  it('openProposeTuneSheet 置 open=true 并载入 nodeId（模块级 ref，供 R-C 挂载）', () => {
    openProposeTuneSheet('n9')
    expect(tuneSheetOpen.value).toBe(true)
    expect(tuneNodeId.value).toBe('n9')
    tuneSheetOpen.value = false
    tuneNodeId.value = null
  })
})
