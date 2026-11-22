import { describe, expect, it } from 'vitest'
import {
  USER_AUTO_ELIGIBLE_MEDIA,
  parseApprovalMode,
  parseMediaWhitelist,
  resolveAutoApproveTier,
} from './generation-approval'

/**
 * 授权自动生成（规格 2026-11-22-generation-auto-approve-gate-design §3.2 / §8）：
 * 审批分级纯函数契约——锁**规则本体**（不是接线），三层合取与归因均可证伪。
 */
describe('resolveAutoApproveTier（生成审批分级 · 规则本体）', () => {
  it('缺省 env（tiered + 白名单 text）⇒ 仅 text 自动，image/video/audio 人工', () => {
    expect(resolveAutoApproveTier({ mediaType: 'text' })).toEqual({
      auto: true,
      reason: 'tier_whitelist',
    })
    for (const mediaType of ['image', 'audio']) {
      expect(resolveAutoApproveTier({ mediaType, userPref: 'manual' })).toEqual({
        auto: false,
        reason: 'user_manual',
      })
    }
    expect(resolveAutoApproveTier({ mediaType: 'video', userPref: 'manual' })).toEqual({
      auto: false,
      reason: 'media_not_eligible',
    })
  })

  it('用户已授权 ⇒ image/audio 自动（video 仍人工：成本放大只对系统开放）', () => {
    expect(resolveAutoApproveTier({ mediaType: 'image', userPref: 'auto' })).toEqual({
      auto: true,
      reason: 'user_auto',
    })
    expect(resolveAutoApproveTier({ mediaType: 'audio', userPref: 'auto' })).toEqual({
      auto: true,
      reason: 'user_auto',
    })
    expect(resolveAutoApproveTier({ mediaType: 'video', userPref: 'auto' })).toEqual({
      auto: false,
      reason: 'media_not_eligible',
    })
  })

  it('用户可授权介质集合 = image + audio（text/video 不得混入）', () => {
    expect([...USER_AUTO_ELIGIBLE_MEDIA]).toEqual(['image', 'audio'])
  })

  it('系统强制人工（full_manual）覆盖用户授权', () => {
    expect(
      resolveAutoApproveTier({ mediaType: 'image', mode: 'full_manual', userPref: 'auto' }),
    ).toEqual({ auto: false, reason: 'system_forced_manual' })
    expect(
      resolveAutoApproveTier({ mediaType: 'text', mode: 'full_manual', userPref: 'auto' }),
    ).toEqual({ auto: false, reason: 'system_forced_manual' })
  })

  it('系统 auto_all ⇒ 全介质自动（即便用户未授权）', () => {
    for (const mediaType of ['text', 'image', 'video', 'audio']) {
      expect(
        resolveAutoApproveTier({ mediaType, mode: 'auto_all', userPref: 'manual' }),
      ).toEqual({ auto: true, reason: 'system_auto_all' })
    }
  })

  it('白名单置空（部署级全人工回滚）⇒ 用户授权不越权：text 人工、image/audio 仍按用户偏好', () => {
    expect(
      resolveAutoApproveTier({ mediaType: 'text', whitelistRaw: '', userPref: 'auto' }),
    ).toEqual({ auto: false, reason: 'media_not_eligible' })
    expect(
      resolveAutoApproveTier({ mediaType: 'image', whitelistRaw: '', userPref: 'auto' }),
    ).toEqual({ auto: true, reason: 'user_auto' })
  })

  it('用户偏好未加载 ⇒ user_pref_unknown（调用方据此决定是否读 DB）', () => {
    expect(resolveAutoApproveTier({ mediaType: 'image' })).toEqual({
      auto: false,
      reason: 'user_pref_unknown',
    })
    expect(resolveAutoApproveTier({ mediaType: 'image', userPref: 'manual' })).toEqual({
      auto: false,
      reason: 'user_manual',
    })
  })

  it('未知模式退化为 tiered（兼容缺省，不误伤现状）', () => {
    expect(parseApprovalMode('nonsense')).toBe('tiered')
    expect(parseApprovalMode(undefined)).toBe('tiered')
    expect(parseApprovalMode(' AUTO_ALL ')).toBe('auto_all')
  })

  it('白名单解析：空串⇒空表，缺省⇒text', () => {
    expect(parseMediaWhitelist('')).toEqual([])
    expect(parseMediaWhitelist(' text , image ')).toEqual(['text', 'image'])
    expect(parseMediaWhitelist(undefined)).toEqual([])
  })
})
