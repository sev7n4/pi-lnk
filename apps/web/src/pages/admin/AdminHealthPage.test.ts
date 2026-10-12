import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminHealthPage from './AdminHealthPage.vue'
import { AdminApiError } from '@/services/admin-api'

const { modelHealth, latestProbeRuns } = vi.hoisted(() => ({
  modelHealth: vi.fn(),
  latestProbeRuns: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    modelHealth: (...a: unknown[]) => modelHealth(...a),
    latestProbeRuns: (...a: unknown[]) => latestProbeRuns(...a),
  },
  AdminApiError: class extends Error {},
}))

const healthRow = {
  model: 'm-1',
  channelId: 'platform',
  windowHours: 24,
  total: 10,
  completed: 9,
  failed: 1,
  fallbackPending: 0,
  refunded: 0,
  successRate: 0.9,
  errorCodeCounts: { upstream_500: 1 },
  balance402Count: 0,
}

function mountPage() {
  return mount(AdminHealthPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminHealthPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('渲染健康行 + 告警 + 探活 run（ghosts/missing 计数）', async () => {
    modelHealth.mockResolvedValue({
      generatedAt: '2026-10-11T05:00:00.000Z',
      rows: [healthRow],
      alerts: [{ rule: 'degraded', model: 'm-1', channelId: 'platform', windowHours: 24, total: 10, successRate: 0.9 }],
    })
    latestProbeRuns.mockResolvedValue({
      runs: [
        { id: 'p1', ranAt: '2026-10-11T04:00:00.000Z', upstream: 'agnes_hub', httpStatus: 200, modelCount: 5, ghosts: ['g-1'], missing: [], error: null, reason: null },
      ],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('m-1')
    expect(w.text()).toContain('90%')
    expect(w.text()).toContain('degraded')
    expect(w.text()).toContain('agnes_hub')
    expect(w.text()).toContain('ghost 1')
  })

  it('windowHours 切换 → 重新请求带参数', async () => {
    modelHealth.mockResolvedValue({ generatedAt: '', rows: [], alerts: [] })
    latestProbeRuns.mockResolvedValue({ runs: [] })
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { reload: () => Promise<void> }).reload()
    expect(modelHealth).toHaveBeenLastCalledWith(24)
  })

  it('无数据初态 → 空表不报错', async () => {
    modelHealth.mockResolvedValue({ generatedAt: '', rows: [], alerts: [] })
    latestProbeRuns.mockResolvedValue({ runs: [] })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('暂无数据')
  })

  it('加载失败透出错误文案', async () => {
    modelHealth.mockRejectedValue(new AdminApiError('上游探活服务不可用', 503))
    latestProbeRuns.mockResolvedValue({ runs: [] })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('上游探活服务不可用')
    expect(w.text()).not.toContain('m-1')
  })

  it('ghost/missing 清单文本：有清单拼接顿号，空清单显示 —', () => {
    const w = mountPage()
    const vm = w.vm as unknown as {
      ghostText: (r: { ghosts: string[] }) => string
      missingText: (r: { missing: string[] }) => string
    }
    expect(vm.ghostText({ ghosts: ['g-1', 'g-2'] })).toBe('g-1、g-2')
    expect(vm.missingText({ missing: [] })).toBe('—')
  })

  it('ghost/missing 展开行标签语义与后端对账口径一致（2026-10-12 修复：此前写反）', async () => {
    modelHealth.mockResolvedValue({ generatedAt: '', rows: [], alerts: [] })
    // 展开行标签只随探活 run 表格渲染（runs 为空显示「暂无数据」），必须给一条 run。
    latestProbeRuns.mockResolvedValue({
      runs: [
        { id: 'p1', ranAt: '2026-10-11T04:00:00.000Z', upstream: 'agnes_hub', httpStatus: 200, modelCount: 5, ghosts: [], missing: [], error: null, reason: null },
      ],
    })
    const w = mountPage()
    await flushPromises()
    // el-table 展开行内容点击展开后才渲染：先点展开图标再断言。
    const expandIcon = w.find('.el-table__expand-icon')
    expect(expandIcon.exists()).toBe(true)
    await expandIcon.trigger('click')
    await flushPromises()
    // 后端语义（upstreamReconciliation.ts）：ghost = 目录有、上游 /models 没报（候选下架）；
    // missing = 上游有、目录没有（候选上架）。文案必须与之一致，防止运营误读。
    expect(w.text()).toContain('ghost（目录有、上游 /models 没报 → 候选下架')
    expect(w.text()).toContain('missing（上游有、目录没有 → 候选上架）')
  })
})
