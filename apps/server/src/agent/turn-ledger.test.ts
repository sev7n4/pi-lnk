/**
 * 回合账本纯函数（PR2）回归锁。
 *
 * 这些函数只做两件事：**判定账本是否完整**、**归并两段账本**。都是纯函数
 * （无 IO），因为判据必须与生产链路共用同一份实现——两处各写一遍必然漂移。
 */
import { describe, expect, it } from 'vitest'
import { isLedgerComplete, ledgerGapFrom, mergeExecutionEvents, type LedgerCapture } from './turn-ledger'
import type { PersistedExecutionEvent } from '@lnkpi/shared'

const ev = (gSeq: number | undefined, type = 'tool_call'): PersistedExecutionEvent => ({
  type,
  data: { gSeq },
  ...(gSeq !== undefined ? { gSeq } : {}),
})

describe('isLedgerComplete（账本完整性的因果围栏）', () => {
  it('看到 run 起点 ⇒ 完整', () => {
    expect(isLedgerComplete({ sawRunStart: true, firstSeq: 1, eventCount: 5 })).toBe(true)
  })

  it('没看到 run 起点却有事件 ⇒ 不完整（切片形态：首事件是孤儿 tool_result）', () => {
    expect(isLedgerComplete({ sawRunStart: false, firstSeq: 4242, eventCount: 3 })).toBe(false)
  })

  it('空账本判完整 —— 没有可缺的东西，标 partial 只是噪音', () => {
    expect(isLedgerComplete({ sawRunStart: false, firstSeq: undefined, eventCount: 0 })).toBe(true)
  })
})

describe('ledgerGapFrom（缺口起点）', () => {
  it('不完整时给出首个捕获序号（语义：此序号之前的事件没看到）', () => {
    const capture: LedgerCapture = { sawRunStart: false, firstSeq: 4242, eventCount: 3 }
    expect(ledgerGapFrom(capture)).toBe(4242)
  })

  it('完整时为 undefined（键不出现纪律：不落 gapFrom）', () => {
    expect(ledgerGapFrom({ sawRunStart: true, firstSeq: 1, eventCount: 3 })).toBeUndefined()
  })
})

describe('mergeExecutionEvents（按全局序号归并去重）', () => {
  it('同 gSeq 只留一条（先到者），并按序号升序', () => {
    const a = [ev(30, 'tool_result'), ev(10, 'tool_call')]
    const b = [ev(10, 'tool_call'), ev(20, 'thinking')]
    const merged = mergeExecutionEvents(a, b)
    expect(merged.map((e) => e.gSeq)).toEqual([10, 20, 30])
    // 去重：gSeq=10 出现两次（a、b 各一）⇒ 只留 a 的那条
    expect(merged.filter((e) => e.gSeq === 10)).toHaveLength(1)
  })

  it('两段互补时并集 = 全集（谁都不是全集，丢任何一边都是丢数据）', () => {
    const a = [ev(1, 'tool_call')]
    const b = [ev(2, 'tool_result')]
    expect(mergeExecutionEvents(a, b).map((e) => e.gSeq)).toEqual([1, 2])
  })

  it('无 gSeq 的事件不去重、整体置前（宁可顺序不完美也不丢事件）', () => {
    const legacy = [{ type: 'tool_call', data: {} } as PersistedExecutionEvent]
    const merged = mergeExecutionEvents(legacy, [ev(5, 'tool_result')])
    expect(merged).toHaveLength(2)
    expect(merged[0]?.gSeq).toBeUndefined()
    expect(merged[1]?.gSeq).toBe(5)
  })

  it('空输入 ⇒ 空输出', () => {
    expect(mergeExecutionEvents([], [])).toEqual([])
  })
})
