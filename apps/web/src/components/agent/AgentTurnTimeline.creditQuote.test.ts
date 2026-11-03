import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'
import type { ProposalCanvasNode } from '@/composables/useProposalNodeData'

/**
 * 契约测试（v2 单一真相源修复）：SSE 对话流里的提议生成卡与产物卡的积分 pill
 * 必须显示价目表权威值（quote 端点与计费同源同表）——
 * 生产事故：卡片兜底走旧常量显 10，账单实扣 33。
 * 改价只改管理后台价目表：本测试 mock quote 返回值模拟价目表变化，卡片值必须跟随。
 */

vi.mock('@/services/pricing-api', () => ({
  fetchPriceQuote: vi.fn().mockResolvedValue({
    credits: 33,
    ruleVersion: 'v2-launch',
    degraded: false,
  }),
}))

type ArtifactPart = Extract<TimelinePart, { kind: 'artifact' }>
type ProposalPart = Extract<TimelinePart, { kind: 'proposal' }>

const node: ProposalCanvasNode = {
  id: 'n1',
  type: 'image',
  data: {
    label: '蓝色老虎',
    prompt: '写实蓝色老虎',
    imageModel: 'realism-v2',
    imageAspect: '1:1',
    imageResolution: '1K',
    imageCount: 1,
  },
}

function artifactPart(over: Partial<ArtifactPart> = {}): TimelinePart {
  return {
    kind: 'artifact',
    id: 'artifact:n1',
    nodeId: 'n1',
    nodeType: 'image',
    title: '蓝色老虎',
    status: 'done',
    url: 'https://cdn/a.png',
    startedAt: Date.now(),
    ...over,
  } as TimelinePart
}

function proposalPart(over: Partial<ProposalPart> = {}): TimelinePart {
  return {
    kind: 'proposal',
    toolName: 'propose_generation',
    nodeId: 'n1',
    title: '提议生成',
    status: 'pending_confirm',
    callId: 'call-1',
    startedAt: Date.now(),
    ...over,
  } as TimelinePart
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

describe('AgentTurnTimeline 卡片积分 = 价目表权威值（展示==计费）', () => {
  it('artifact done 卡「消耗」pill 显示 quote 值 33（非旧常量 10）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [artifactPart()], canvasNodes: [node] },
    })
    await flush()
    await w.vm.$nextTick()
    expect(w.text()).toContain('消耗 33 积分')
    expect(w.text()).not.toContain('消耗 10 积分')
  })

  it('proposal pending 卡「消耗」chip 同源显 33（2026-11-04 去「预计」字眼，琥珀强调）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [proposalPart()], canvasNodes: [node] },
    })
    await flush()
    await w.vm.$nextTick()
    expect(w.text()).toContain('消耗 33 积分')
    expect(w.text()).not.toContain('预计')
  })
})
