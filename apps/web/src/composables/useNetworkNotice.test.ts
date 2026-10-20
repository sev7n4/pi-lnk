import { describe, expect, it } from 'vitest'
import { planNetworkNotice } from '@/composables/useNetworkNotice'

describe('planNetworkNotice', () => {
  it('在线→离线：推常驻黄色断网卡', () => {
    expect(planNetworkNotice(true, false, null)).toEqual([
      {
        id: 'network-offline',
        tone: 'warning',
        title: '网络连接已断开',
        message: '生成进度已自动保存，网络恢复后将自动继续。',
        ttl: 0,
      },
    ])
  })
  it('离线→在线 且服务健康：推绿色成功卡（ttl 5000）', () => {
    const out = planNetworkNotice(false, true, true)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'network-recovered', tone: 'success', ttl: 5000 })
  })
  it('离线→在线 但服务不可达：推黄色降级卡（常驻）', () => {
    const out = planNetworkNotice(false, true, false)
    expect(out[0]).toMatchObject({ id: 'network-recovered', tone: 'warning', ttl: 0 })
  })
  it('离线→在线 且探测失败（null）：按降级处理，不误报成功', () => {
    const out = planNetworkNotice(false, true, null)
    expect(out[0]).toMatchObject({ tone: 'warning' })
    expect(out[0].tone).not.toBe('success')
  })
  it('始终在线 / 无变化：不刷屏', () => {
    expect(planNetworkNotice(true, true, true)).toEqual([])
    expect(planNetworkNotice(false, false, null)).toEqual([])
  })
})
