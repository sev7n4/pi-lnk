import { describe, expect, it } from 'vitest'
import {
  selectExampleUtterances,
  buildDraftFromUtterance,
  pickUtteranceContext,
  type UtterancePool,
} from './exampleUtterances'

const pool: UtterancePool = {
  empty: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
  selection: ['s1', 's2'],
  artifact: ['a1', 'a2', 'a3'],
  attachment: ['m1', 'm2', 'm3', 'm4', 'm5'],
}

describe('selectExampleUtterances (P1-1.1)', () => {
  it('routes by canvas phase and caps at 4', () => {
    expect(selectExampleUtterances('empty', pool)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(selectExampleUtterances('selection', pool)).toEqual(['s1', 's2'])
    expect(selectExampleUtterances('artifact', pool)).toEqual(['a1', 'a2', 'a3'])
  })
})

describe('buildDraftFromUtterance (P1-1.2)', () => {
  it('returns editable draft text (never submits)', () => {
    expect(buildDraftFromUtterance('把首页 hero 重画成电商横幅')).toBe('把首页 hero 重画成电商横幅')
  })
})

/**
 * A1：attachment 相是 composer/草稿状态维度，不是画布状态维度 ——
 * 故不并入 CanvasPhase，改由 pickUtteranceContext 显式裁决（见规格 B′ 决策）。
 */
describe('pickUtteranceContext (A1 · B′ 决策)', () => {
  it('prefers attachment whenever attachments exist, regardless of canvas phase', () => {
    expect(pickUtteranceContext({ phase: 'empty', hasAttachments: true })).toBe('attachment')
    expect(pickUtteranceContext({ phase: 'selection', hasAttachments: true })).toBe('attachment')
    expect(pickUtteranceContext({ phase: 'artifact', hasAttachments: true })).toBe('attachment')
  })

  it('falls back to canvas phase when no attachments', () => {
    expect(pickUtteranceContext({ phase: 'empty', hasAttachments: false })).toBe('empty')
    expect(pickUtteranceContext({ phase: 'selection', hasAttachments: false })).toBe('selection')
    expect(pickUtteranceContext({ phase: 'artifact', hasAttachments: false })).toBe('artifact')
  })
})

describe('selectExampleUtterances · attachment 相与轮换 (A1)', () => {
  it('reads the attachment pool', () => {
    expect(selectExampleUtterances('attachment', pool, 0)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('rotates so items beyond the 4 slots still surface', () => {
    // empty 池 7 条 > 4 个展示位：不轮换的话 e5/e6/e7 永远不露出（等于没写）
    expect(selectExampleUtterances('empty', pool, 0)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(selectExampleUtterances('empty', pool, 4)).toEqual(['e5', 'e6', 'e7', 'e1'])
    expect(selectExampleUtterances('empty', pool, 6)).toEqual(['e7', 'e1', 'e2', 'e3'])
  })

  it('rotates without padding when pool is smaller than slots', () => {
    // selection 只有 2 条：轮换可以换序，但不得补齐到 4 条（缺口不是靠重复填）
    expect(selectExampleUtterances('selection', pool, 0)).toEqual(['s1', 's2'])
    expect(selectExampleUtterances('selection', pool, 1)).toEqual(['s2', 's1'])
  })
})
