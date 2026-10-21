import { describe, expect, it } from 'vitest'

import { computeSeqs } from './session-projection.service'

/**
 * 投影面 seq 的**回填**口径（plan Task 7 Step 3 · Review Focus #5）。
 *
 * 回填要动存量每一行，所以它必须满足一条性质：**结果与输入顺序无关**。
 * 否则「同一批数据跑两次」会算出两套 seq，唯一索引也就无从谈起。
 *
 * 断言全部落在函数输出（可观测出口），不碰源码字符串。
 */

const T0 = new Date('2026-10-22T00:00:00.000Z')
const T1 = new Date('2026-10-22T00:00:01.000Z')

const msg = (id: string, createdAt: Date, threadId = 't1') => ({ id, threadId, createdAt })

describe('computeSeqs（投影面 seq 回填）', () => {
  it('同毫秒内的消息按 id 兜底排序，回填两次结果一致（变异点：只用 createdAt 排序）', () => {
    const rows = [msg('b', T0), msg('a', T0)]

    // 输入顺序反过来 ⇒ 同一批数据，算出来必须逐字节相同
    expect(computeSeqs(rows)).toEqual(computeSeqs([...rows].reverse()))
    // 且 id 小的在前（兜底判据本身要显式锁住，不能只靠「两次一致」）
    expect(computeSeqs(rows).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('seq 按 thread 各自从 1 开始（变异点：跨会话共用一个计数器）', () => {
    const rows = [msg('a', T0, 't1'), msg('b', T1, 't1'), msg('c', T0, 't2')]

    const seqs = computeSeqs(rows)
    expect(seqs.find((r) => r.id === 'a')?.seq).toBe(1)
    expect(seqs.find((r) => r.id === 'b')?.seq).toBe(2)
    // 另一个会话的第一条同样是 1，而不是 3
    expect(seqs.find((r) => r.id === 'c')?.seq).toBe(1)
  })

  it('seq 连续无空洞：n 条消息恰好是 1..n（变异点：从 0 起或有跳号）', () => {
    const rows = [msg('c', T1), msg('a', T0), msg('b', T0)]

    expect(computeSeqs(rows).map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('时间不同时按 createdAt 升序，且不接受「先到先得」（变异点：按输入顺序编号）', () => {
    // 故意把最晚的消息放在输入第一位
    const rows = [msg('late', T1), msg('early', T0)]

    expect(computeSeqs(rows).map((r) => r.id)).toEqual(['early', 'late'])
  })

  it('空输入 ⇒ 空输出（变异点：返回 [{}] 之类的哨兵）', () => {
    expect(computeSeqs([])).toEqual([])
  })

  it('createdAt 为 number/string 时与 Date 同口径（迁移回填会拿到多种形态）', () => {
    const asDate = computeSeqs([msg('a', T0), msg('b', T1)])
    const asNum = computeSeqs([
      { id: 'a', threadId: 't1', createdAt: T0.getTime() },
      { id: 'b', threadId: 't1', createdAt: T1.getTime() },
    ])
    const asStr = computeSeqs([
      { id: 'a', threadId: 't1', createdAt: T0.toISOString() },
      { id: 'b', threadId: 't1', createdAt: T1.toISOString() },
    ])

    expect(asNum.map((r) => `${r.id}:${r.seq}`)).toEqual(asDate.map((r) => `${r.id}:${r.seq}`))
    expect(asStr.map((r) => `${r.id}:${r.seq}`)).toEqual(asDate.map((r) => `${r.id}:${r.seq}`))
  })
})
