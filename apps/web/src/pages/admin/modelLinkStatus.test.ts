import { describe, expect, it } from 'vitest'
import { linkStatusOf, LINK_LEVEL_TEXT_CLASS, type AdminCatalogLinkOps } from './modelLinkStatus'

/**
 * 链路状态灯判定（2026-10-12 目录页增强）：灯色语义必须与探活对账口径一致
 * （upstreamReconciliation.ts / upstream-probe-logic.ts），防止运营误读。
 */

const ops = (over: Partial<AdminCatalogLinkOps>): AdminCatalogLinkOps => ({
  upstream: 'agnes_hub',
  baseUrl: 'https://apihub.agnes-ai.cn/v1',
  availability: 'unknown',
  completed24h: 0,
  balance40224h: 0,
  ...over,
})

describe('linkStatusOf', () => {
  it('软删行 → 灰「已下架」', () => {
    expect(linkStatusOf(ops({ availability: 'unavailable' }), true)).toMatchObject({ level: 'gray', label: '已下架' })
  })

  it('ops 缺失（服务端降级/旧响应）→ 灰「未知」', () => {
    expect(linkStatusOf(null, false)).toMatchObject({ level: 'gray', label: '未知' })
    expect(linkStatusOf(undefined, false)).toMatchObject({ level: 'gray', label: '未知' })
  })

  it('availability=unavailable → 红「不可用」（探活双条件判定，候选下架）', () => {
    const s = linkStatusOf(ops({ availability: 'unavailable' }), false)
    expect(s).toMatchObject({ level: 'red', label: '不可用' })
    expect(s.tooltip).toContain('建议下架')
  })

  it('402 欠费 → 黄「欠费」（红优先级更高：unavailable + 402 同时命中取红，tooltip 补欠费）', () => {
    expect(linkStatusOf(ops({ balance40224h: 3 }), false)).toMatchObject({ level: 'yellow', label: '欠费' })
    const red = linkStatusOf(ops({ availability: 'unavailable', balance40224h: 3 }), false)
    expect(red.level).toBe('red')
    expect(red.tooltip).toContain('欠费')
  })

  it('探活 available → 绿「正常」；unknown + 有真实成功流量 → 绿（流量背书）', () => {
    expect(linkStatusOf(ops({ availability: 'available' }), false)).toMatchObject({ level: 'green', label: '正常' })
    expect(linkStatusOf(ops({ completed24h: 2 }), false)).toMatchObject({ level: 'green', label: '正常' })
  })

  it('unknown 且零流量 → 灰「未知」（新上架/冷模型）', () => {
    expect(linkStatusOf(ops({}), false)).toMatchObject({ level: 'gray', label: '未知' })
    expect(linkStatusOf(ops({ availability: null }), false).level).toBe('gray')
  })

  it('灯色类映射齐全（design token 语义类，无新增 hex）', () => {
    expect(LINK_LEVEL_TEXT_CLASS).toEqual({
      red: 'text-danger',
      yellow: 'text-warning',
      green: 'text-success',
      gray: 'text-fg-3',
    })
  })
})
