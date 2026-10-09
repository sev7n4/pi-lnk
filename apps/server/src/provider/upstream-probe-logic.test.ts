import { describe, expect, it } from 'vitest'
import {
  bumpConsecutiveFailures,
  planAvailabilityWrites,
  UNAVAILABLE_FAILURE_THRESHOLD,
  type ModelEntryLike,
  type ProbeHealthByModel,
} from './upstream-probe-logic'

const LEGACY_MODELS: ModelEntryLike[] = [
  // 旧格式：无 availability 字段（A5 fixture）
  { name: 'agnes-text-v1', capability: 'text' },
  { name: 'agnes-image-v2', capability: 'image' },
]

/** 四条目全态 fixture：覆盖 ghost / matched / 无关 三种本轮 diff 位置 × 三种存量 availability。 */
const FULL_MODELS: ModelEntryLike[] = [
  { name: 'ghost-legacy', capability: 'text' },
  { name: 'ghost-gray', capability: 'text', availability: 'unavailable' },
  { name: 'ghost-recovered', capability: 'video', availability: 'unavailable' },
  { name: 'other-upstream-entry', capability: 'image', availability: 'available' },
  { name: 'healthy-text', capability: 'text', availability: 'available' },
]

describe('planAvailabilityWrites（A1 三态转换矩阵）', () => {
  it('ghost + 连败3 + 零成功 ⇒ 灰显 unavailable（含旧格式条目可升级写入）', () => {
    const plan = planAvailabilityWrites(
      LEGACY_MODELS,
      { ghosts: ['agnes-text-v1'], missing: [], matched: ['agnes-image-v2'] },
      { 'agnes-text-v1': { consecutiveFailures: 3, recentSuccesses: 0 } },
    )
    expect(plan.find((e) => e.name === 'agnes-text-v1')).toEqual({
      name: 'agnes-text-v1',
      capability: 'text',
      availability: 'unavailable',
    })
  })

  it('ghost + 连败不足3 ⇒ 原值不变 + logged（抖动防护）', () => {
    const plan = planAvailabilityWrites(
      FULL_MODELS,
      { ghosts: ['ghost-gray'], matched: [], missing: [] },
      { 'ghost-gray': { consecutiveFailures: 2, recentSuccesses: 0 } },
    )
    expect(plan.find((e) => e.name === 'ghost-gray')).toEqual({
      name: 'ghost-gray',
      capability: 'text',
      availability: 'unavailable',
      logged: true,
    })
  })

  it('Ruling A 两例：连败3 + 近24h有成功 ⇒ 绝不灰显（/models 缺失 ≠ 不可用）', () => {
    const health: ProbeHealthByModel = {
      'ghost-legacy': { consecutiveFailures: 3, recentSuccesses: 5 },
      'ghost-gray': { consecutiveFailures: 7, recentSuccesses: 1 },
    }
    const plan = planAvailabilityWrites(
      FULL_MODELS,
      { ghosts: ['ghost-legacy', 'ghost-gray'], matched: [], missing: [] },
      health,
    )
    // 旧格式条目：健康背书压制灰显，保持 unknown 并打 logged
    expect(plan.find((e) => e.name === 'ghost-legacy')).toEqual({
      name: 'ghost-legacy',
      capability: 'text',
      availability: 'unknown',
      logged: true,
    })
    // 已灰显条目：不因健康背书解除（恢复唯一通路是探活通过），但也绝不加深
    expect(plan.find((e) => e.name === 'ghost-gray')).toEqual({
      name: 'ghost-gray',
      capability: 'text',
      availability: 'unavailable',
      logged: true,
    })
  })

  it('Ruling A 两例：连败3 + 近24h零成功 ⇒ 灰显', () => {
    const plan = planAvailabilityWrites(
      FULL_MODELS,
      { ghosts: ['ghost-legacy', 'ghost-gray'], matched: [], missing: [] },
      {
        'ghost-legacy': { consecutiveFailures: 3, recentSuccesses: 0 },
        'ghost-gray': { consecutiveFailures: 5, recentSuccesses: 0 },
      },
    )
    expect(
      plan
        .filter((e) => e.name.startsWith('ghost-'))
        .every((e) => e.availability === 'unavailable' && e.logged === undefined),
    ).toBe(true)
  })

  it('阈值恰好为 3：连败 2 不灰显、连败 3 灰显', () => {
    expect(UNAVAILABLE_FAILURE_THRESHOLD).toBe(3)
    const diff = { ghosts: ['ghost-legacy'], matched: [], missing: [] }
    const at = (fails: number) =>
      planAvailabilityWrites(FULL_MODELS, diff, {
        'ghost-legacy': { consecutiveFailures: fails, recentSuccesses: 0 },
      }).find((e) => e.name === 'ghost-legacy')!.availability
    expect(at(2)).toBe('unknown')
    expect(at(3)).toBe('unavailable')
  })

  it('A4 恢复：unavailable 模型本轮探活通过 ⇒ available', () => {
    const plan = planAvailabilityWrites(
      FULL_MODELS,
      { ghosts: [], matched: ['ghost-recovered'], missing: [] },
      {},
    )
    expect(plan.find((e) => e.name === 'ghost-recovered')).toEqual({
      name: 'ghost-recovered',
      capability: 'video',
      availability: 'available',
    })
  })

  it('matched 但非 unavailable ⇒ 不变（unknown 不被凭空置 available）', () => {
    const plan = planAvailabilityWrites(
      LEGACY_MODELS,
      { ghosts: [], matched: ['agnes-text-v1'], missing: [] },
      {},
    )
    expect(plan.find((e) => e.name === 'agnes-text-v1')!.availability).toBe('unknown')
    expect(plan.find((e) => e.name === 'agnes-text-v1')!.logged).toBeUndefined()
  })

  it('本轮 diff 无关的条目（归属其他上游）原样保留，绝不触碰', () => {
    const plan = planAvailabilityWrites(
      FULL_MODELS,
      { ghosts: ['ghost-legacy'], matched: [], missing: [] },
      { 'ghost-legacy': { consecutiveFailures: 3, recentSuccesses: 0 } },
    )
    expect(plan.find((e) => e.name === 'other-upstream-entry')).toEqual({
      name: 'other-upstream-entry',
      capability: 'image',
      availability: 'available',
    })
    expect(plan.find((e) => e.name === 'healthy-text')!.availability).toBe('available')
  })

  it('A5 兼容：旧格式整表读为 unknown，写入计划把全部条目升级为显式值', () => {
    const plan = planAvailabilityWrites(LEGACY_MODELS, { ghosts: [], matched: [], missing: [] }, {})
    expect(plan.map((e) => e.availability)).toEqual(['unknown', 'unknown'])
    // 等长同序：写入计划就是完整下一帧，调用方可直接 stringify
    expect(plan.map((e) => e.name)).toEqual(LEGACY_MODELS.map((e) => e.name))
  })

  it('无健康记录的 ghost（首轮发现）只记日志不灰显', () => {
    const plan = planAvailabilityWrites(
      LEGACY_MODELS,
      { ghosts: ['agnes-text-v1'], matched: [], missing: [] },
      {},
    )
    expect(plan.find((e) => e.name === 'agnes-text-v1')).toEqual({
      name: 'agnes-text-v1',
      capability: 'text',
      availability: 'unknown',
      logged: true,
    })
  })

  it('脏 availability 存量值按 unknown 处理（写出后归一化）', () => {
    const plan = planAvailabilityWrites(
      [{ name: 'm', capability: 'text', availability: 'grayed' }],
      { ghosts: [], matched: [], missing: [] },
      {},
    )
    expect(plan[0]!.availability).toBe('unknown')
  })
})

describe('bumpConsecutiveFailures（连败计数器）', () => {
  it('探活通过 ⇒ 归零；失败 ⇒ +1', () => {
    expect(bumpConsecutiveFailures(0, true)).toBe(0)
    expect(bumpConsecutiveFailures(2, true)).toBe(0)
    expect(bumpConsecutiveFailures(0, false)).toBe(1)
    expect(bumpConsecutiveFailures(2, false)).toBe(3)
  })
})
