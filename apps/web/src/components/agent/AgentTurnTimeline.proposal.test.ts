import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

/**
 * 根治规格（2026-10-28）：「提议生成」决策点收敛进对话流内联 proposal part。
 *
 * 背景（Q1 漂移）：propose 的 pending_confirm 态此前由**对话流外浮卡**
 * （.agent-system-layer 内 propose-wait-hint）表达——决策点脱离对话时序，
 * 用户在流里看不到「卡在哪一步」。根治后决策点 = 时间线内联卡（本组件渲染），
 * 与画布节点浮层、底部状态行同读一份 proposal part（单一真相）。
 *
 * 断言落在 DOM 出口（标题/按钮/事件），不碰源码字符串。
 */

type ProposalPart = Extract<TimelinePart, { kind: 'proposal' }>

function proposalPart(overrides: Partial<ProposalPart> = {}): TimelinePart {
  return {
    kind: 'proposal',
    id: 'proposal:call-1',
    toolName: 'propose_generation',
    nodeId: 'n1',
    title: '提议生成',
    status: 'pending_confirm',
    callId: 'call-1',
    startedAt: Date.now(),
    ...overrides,
  }
}

describe('AgentTurnTimeline — proposal 内联卡（等待态单一真相）', () => {
  it('pending_confirm：内联卡带「确认生成 / 取消」按钮（决策点在对话流内）', () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [proposalPart()] },
    })
    const text = w.text()
    expect(text).toContain('提议生成')
    expect(text).toContain('待确认')
    expect(text).toContain('等待你在画布上确认生成')
    const buttons = w.findAll('button').map((b) => b.text())
    expect(buttons).toContain('确认生成')
    expect(buttons).toContain('取消')
    // 定位入口：nodeId 在 ⇒ 可在画布中定位
    expect(w.find('button[title="在画布中定位"]').exists()).toBe(true)
  })

  it('confirmed：按钮全部收起，徽标翻「已确认」（终态只读，不残留可操作入口）', () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [proposalPart({ status: 'confirmed' })] },
    })
    expect(w.text()).toContain('已确认')
    const buttons = w.findAll('button').map((b) => b.text())
    expect(buttons).not.toContain('确认生成')
    expect(buttons).not.toContain('取消')
  })

  it('点「确认生成」⇒ emit confirmProposal(nodeId)（复用 POST /answers 确认契约）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [proposalPart()] },
    })
    await w.findAll('button').find((b) => b.text() === '确认生成')!.trigger('click')
    expect(w.emitted('confirmProposal')).toEqual([['n1']])
  })

  it('点「取消」⇒ emit cancelProposal(nodeId)（同源同语义，不再走浮卡）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [proposalPart()] },
    })
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(w.emitted('cancelProposal')).toEqual([['n1']])
  })

  it('无 nodeId 的 proposal（异常形态）：不渲染定位按钮、点击不 emit（防误确认）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [proposalPart({ nodeId: undefined })] },
    })
    expect(w.find('button[title="在画布中定位"]').exists()).toBe(false)
    const confirm = w.findAll('button').find((b) => b.text() === '确认生成')
    if (confirm) await confirm.trigger('click')
    expect(w.emitted('confirmProposal')).toBeUndefined()
  })
})
