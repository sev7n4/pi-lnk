import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'
import type { ProposalCanvasNode } from '@/composables/useProposalNodeData'
import { useProviderBootstrap } from '@/composables/useProviderBootstrap'
import { __resetAutoApproveForTest } from '@/composables/useAutoApproveGeneration'

/**
 * 场景内快捷项：授权后续自动生成（规格 2026-11-22-generation-auto-approve-gate-design §4）。
 *
 * 契约：
 * 1. proposal 卡出现「授权后续自动生成」次级项（PC 唯一场景入口，画布确认面已退场）；
 * 2. 点击写**账号级偏好**（providerApi.updatePreferences），不改本次确认流程；
 * 3. 三动作（落锚生成/调整/取消）**不受影响**；
 * 4. 已授权态按钮禁用且文案变「已授权」（避免重复授权）。
 */

const { updatePreferences, success } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/services/provider-api', () => ({
  providerApi: { updatePreferences },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success, error: vi.fn(), info: vi.fn() },
}))

type ProposalPart = Extract<TimelinePart, { kind: 'proposal' }>

const seedNode: ProposalCanvasNode = {
  id: 'n1',
  type: 'image',
  data: {
    label: '产品主图',
    prompt: '极简电竞耳机主图',
    imageModel: 'realism-v2',
    imageAspect: '1:1',
    imageResolution: '1K',
    imageCount: 1,
  },
}

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

function mountCard(parts: TimelinePart[] = [proposalPart()]) {
  return mount(AgentTurnTimeline, {
    props: { parts, canvasNodes: [seedNode] },
  })
}

describe('AgentTurnTimeline — 授权后续自动生成（2026-11-22 规格 §4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAutoApproveForTest()
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = null
  })

  it('pending_confirm：出现「授权后续自动生成」次级项', () => {
    const w = mountCard()
    const btn = w.find('[data-test="authorize-auto"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('授权后续自动生成')
    w.unmount()
  })

  it('点击快捷项 ⇒ 写账号级偏好 autoApproveGenerations=auto（本次确认流程不变）', async () => {
    updatePreferences.mockResolvedValue({ autoApproveGenerations: 'auto' })
    const w = mountCard()

    await w.find('[data-test="authorize-auto"]').trigger('click')

    expect(updatePreferences).toHaveBeenCalledWith({ autoApproveGenerations: 'auto' })
    // 本次仍需确认：三动作一个不少
    expect(w.find('[data-test="confirm"]').exists()).toBe(true)
    expect(w.find('[data-test="tune"]').exists()).toBe(true)
    expect(w.find('[data-test="cancel"]').exists()).toBe(true)
    w.unmount()
  })

  it('终态卡片不出现快捷项（决策面已收起）', () => {
    const w = mountCard([proposalPart({ status: 'confirmed' })])
    expect(w.find('[data-test="authorize-auto"]').exists()).toBe(false)
    w.unmount()
  })
})
