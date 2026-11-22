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
 * 2026-11-23 UI 迭代（图标化）：
 * · 该次级动作与同排「参数微调 / 取消」同构 ⇒ 一律 icon-only，
 *   长文字按钮会把提议卡撑宽、把决策行撑脏 ⇒ 改为与 composer 工具行**同一枚图形**（盾牌+闪电）。
 * · 文案退到 title / aria-label（可访问性不降级，但视觉上零文字占位）。
 * · 已授权态不再「禁用」（禁用无法收回）⇒ 同一枚图标成为 toggle：已授权时点击 = 收回授权。
 */

const { updatePreferences, success, error, message } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(() => ({ close: vi.fn() })),
}))

vi.mock('@/services/provider-api', () => ({
  providerApi: { updatePreferences },
}))

vi.mock('element-plus', () => {
  // ElMessage 既要能当函数调用（undoable toast），也要有 success/error 静态方法
  const ElMessage = message as unknown as {
    (opts: unknown): { close: () => void }
    success: typeof success
    error: typeof error
  }
  ElMessage.success = success
  ElMessage.error = error
  return { ElMessage }
})

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

describe('AgentTurnTimeline — 授权后续自动生成（2026-11-23 图标化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAutoApproveForTest()
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = null
  })

  it('pending_confirm：出现授权入口，且是 icon-only（同构于参数微调/取消），无长文字占位', () => {
    const w = mountCard()
    const btn = w.find('[data-test="authorize-auto"]')
    expect(btn.exists()).toBe(true)
    // 与同排次级动作同构：icon-btn
    expect(btn.classes()).toContain('icon-btn')
    // 视觉上零文字（文案退到 title / aria-label）
    expect(btn.text()).not.toContain('授权后续自动生成')
    expect(btn.text().trim()).toBe('')
    // 图形存在（盾牌 + 闪电）
    expect(btn.find('.auto-approve-glyph').exists()).toBe(true)
    // 可访问性文案仍在
    expect(btn.attributes('aria-label')).toContain('授权后续自动生成')
    expect(btn.attributes('title')).toContain('下次生效')
    w.unmount()
  })

  it('未授权态：图标为线框（无 is-on）——一眼可读出「未开启」', () => {
    const w = mountCard()
    expect(w.find('[data-test="authorize-auto"] .auto-approve-glyph').classes()).not.toContain('is-on')
    w.unmount()
  })

  it('点击授权入口 ⇒ 写账号级偏好 autoApproveGenerations=auto（本次确认流程不变）', async () => {
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

  it('已授权态：图标变实心（is-on），同一枚图标点一下 = 收回授权（写 manual）', async () => {
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = {
      platformChannel: null as never,
      channels: [],
      preferences: { autoApproveGenerations: 'auto' } as never,
      webdav: null as never,
      catalog: [],
    }
    updatePreferences.mockResolvedValue({ autoApproveGenerations: 'manual' })
    const w = mountCard()

    const glyph = w.find('[data-test="authorize-auto"] .auto-approve-glyph')
    expect(glyph.classes()).toContain('is-on')
    // 已授权态不再 disabled（禁用就收不回授权了）
    expect(w.find('[data-test="authorize-auto"]').attributes('disabled')).toBeUndefined()

    await w.find('[data-test="authorize-auto"]').trigger('click')
    expect(updatePreferences).toHaveBeenCalledWith({ autoApproveGenerations: 'manual' })
    w.unmount()
  })

  it('终态卡片不出现快捷项（决策面已收起）', () => {
    const w = mountCard([proposalPart({ status: 'confirmed' })])
    expect(w.find('[data-test="authorize-auto"]').exists()).toBe(false)
    w.unmount()
  })
})
