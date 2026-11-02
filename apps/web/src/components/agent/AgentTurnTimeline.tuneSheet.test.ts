import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import { openProposeTuneSheet, closeProposeTuneSheet } from './proposeWaitActions'
import type { TimelinePart } from './turnTimeline'
import type { ProposalCanvasNode } from '@/composables/useProposalNodeData'

/**
 * R-C 接线（2026-11-02 卡片 UX 优化）：ProposeTuneSheet 挂载在 AgentTurnTimeline
 * parts 循环外——「调整」入口（proposal 卡）→ openProposeTuneSheet → Sheet 显隐；
 * Sheet「保存并确认」→ 组件 confirmProposal emit 上行（SideRail confirmProposeWait，
 * 单执行入口不变量）；「在画布精修」→ focusNode emit（画布 dock 写路径）。
 * Teleport stub 模式沿用仓库惯例（MobileNodeEditorSheet.test.ts 同款）。
 */

type ProposalPart = Extract<TimelinePart, { kind: 'proposal' }>

const seedNode: ProposalCanvasNode = {
  id: 'n1',
  type: 'image',
  data: { label: '产品主图', imageModel: 'realism-v2', imageAspect: '1:1', imageResolution: '1K', imageCount: 1 },
}

function proposalPart(): TimelinePart {
  return {
    kind: 'proposal',
    id: 'proposal:call-1',
    toolName: 'propose_generation',
    nodeId: 'n1',
    title: '提议生成',
    status: 'pending_confirm',
    callId: 'call-1',
    startedAt: Date.now(),
  } satisfies ProposalPart
}

function mountTimeline() {
  return mount(AgentTurnTimeline, {
    props: { parts: [proposalPart()], canvasNodes: [seedNode] },
    global: { stubs: { teleport: true } },
  })
}

afterEach(() => {
  closeProposeTuneSheet()
})

describe('R-C — ProposeTuneSheet 经 AgentTurnTimeline 接线', () => {
  it('openProposeTuneSheet 后 Sheet 在 timeline 内出现（refine-dock 逃生钮可达）', async () => {
    const w = mountTimeline()
    expect(w.find('[data-test="refine-dock"]').exists()).toBe(false)
    openProposeTuneSheet('n1')
    await nextTick()
    expect(w.find('[data-test="refine-dock"]').exists()).toBe(true)
  })

  it('Sheet「在画布精修」→ emit focusNode（画布 dock 写路径入口）', async () => {
    const w = mountTimeline()
    openProposeTuneSheet('n1')
    await nextTick()
    await w.find('[data-test="refine-dock"]').trigger('click')
    expect(w.emitted('focusNode')?.at(-1)).toEqual(['n1'])
  })

  it('Sheet「保存并确认」→ emit confirmProposal（经既有上行到 SideRail）', async () => {
    const w = mountTimeline()
    openProposeTuneSheet('n1')
    await nextTick()
    // 注意：proposal 卡主钮同名 data-test="confirm"，取最后一个（Sheet 内）
    const sheetConfirm = w.findAll('[data-test="confirm"]').at(-1)!
    await sheetConfirm.trigger('click')
    expect(w.emitted('confirmProposal')?.at(-1)).toEqual(['n1'])
  })

  it('Sheet 关闭（update:open=false）→ 内容随 v-if 卸载', async () => {
    const w = mountTimeline()
    openProposeTuneSheet('n1')
    await nextTick()
    await w.find('[data-testid="m-sheet-close"]').trigger('click')
    await nextTick()
    expect(w.find('[data-test="refine-dock"]').exists()).toBe(false)
  })
})
