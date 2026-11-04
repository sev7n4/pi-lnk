import { describe, expect, it } from 'vitest'
import { isTerminalNodeStatus, isTerminalRegen } from './canvasLifecycle'

/**
 * 吸收态守卫表驱动测试（规格 2026-11-04-generation-terminal-projection §5.2 图 4）。
 * 变异纪律：任何比较符/集合成员改动必须让本表至少一格变红。
 */
describe('isTerminalNodeStatus', () => {
  it('认全三个吸收态（含历史写者留下的 failed 字面量）', () => {
    expect(isTerminalNodeStatus('completed')).toBe(true)
    expect(isTerminalNodeStatus('error')).toBe(true)
    expect(isTerminalNodeStatus('failed')).toBe(true)
  })

  it('在途/待确认/未知值不是吸收态', () => {
    expect(isTerminalNodeStatus('generating')).toBe(false)
    expect(isTerminalNodeStatus('pending')).toBe(false)
    expect(isTerminalNodeStatus('pending_confirm')).toBe(false)
    expect(isTerminalNodeStatus('draft')).toBe(false)
    expect(isTerminalNodeStatus('fallback_pending')).toBe(false)
    expect(isTerminalNodeStatus(undefined)).toBe(false)
    expect(isTerminalNodeStatus(123)).toBe(false)
  })
})

describe('isTerminalRegen', () => {
  const base = {
    currentStatus: 'error',
    currentRecordId: 'rec-1',
    incomingStatus: 'generating',
  }

  it('吸收态 → 在途态且 recordId 相同 ⇒ 拒绝（事故主形态：陈旧快照回灌）', () => {
    expect(isTerminalRegen({ ...base, incomingRecordId: 'rec-1' })).toBe(true)
  })

  it('吸收态 → 在途态且无 recordId ⇒ 拒绝', () => {
    expect(isTerminalRegen({ ...base })).toBe(true)
    expect(isTerminalRegen({ ...base, incomingRecordId: undefined })).toBe(true)
    expect(isTerminalRegen({ ...base, incomingRecordId: '' })).toBe(true)
  })

  it('吸收态 → 在途态且携带不同的新 recordId ⇒ 放行（新一轮生成合法重置）', () => {
    expect(isTerminalRegen({ ...base, incomingRecordId: 'rec-2' })).toBe(false)
  })

  it('入向不是在途态（终态写/pending_confirm 等）⇒ 与吸收无关', () => {
    expect(isTerminalRegen({ ...base, incomingStatus: 'error' })).toBe(false)
    expect(isTerminalRegen({ ...base, incomingStatus: 'completed' })).toBe(false)
    expect(isTerminalRegen({ ...base, incomingStatus: 'pending_confirm' })).toBe(false)
    expect(isTerminalRegen({ ...base, incomingStatus: undefined })).toBe(false)
  })

  it('当前不是吸收态 ⇒ 不拒绝（generating→generating 重写、draft→generating 均放行）', () => {
    expect(
      isTerminalRegen({ currentStatus: 'generating', currentRecordId: 'rec-1', incomingStatus: 'generating', incomingRecordId: 'rec-1' }),
    ).toBe(false)
    expect(
      isTerminalRegen({ currentStatus: undefined, currentRecordId: undefined, incomingStatus: 'generating' }),
    ).toBe(false)
    expect(
      isTerminalRegen({ currentStatus: 'pending_confirm', incomingStatus: 'generating' }),
    ).toBe(false)
  })

  it('failed 也算吸收态（late-notify 旧映射写过的字面量）', () => {
    expect(
      isTerminalRegen({ currentStatus: 'failed', currentRecordId: 'rec-1', incomingStatus: 'generating', incomingRecordId: 'rec-1' }),
    ).toBe(true)
  })

  it('completed 被无 recordId 的 generating 覆盖 ⇒ 拒绝（防 2026-10-08 同族事故复发面）', () => {
    expect(isTerminalRegen({ currentStatus: 'completed', currentRecordId: 'rec-1', incomingStatus: 'generating' })).toBe(true)
  })
})
