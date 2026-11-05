import { describe, expect, it } from 'vitest'

import { nextMessageSeq, runWithMessageSeq } from './agent-message-seq'

/**
 * P4-T1（投影面收口）：seq 写路径统一 helper 的口径测试。
 *
 * 背景：迁移 20261022043000 加了 `seq Int?` 列但全仓 0 个写方；
 * 步 4 唯一索引 `@@unique([threadId, seq])` 落地前，写方必须先统一走本 helper，
 * 否则并发写会在唯一索引上线后开始炸（先写方后索引的顺序纪律）。
 *
 * 口径与 computeSeqs（session-projection.service.ts）对齐：seq = 会话内
 * 「(createdAt, id) 全序」的位次；运行时写入取 `max(seq)+1` ——
 * 新行 createdAt 必然 ≥ 既有行，两个口径在稳态下同序。
 */

/** 内存假 db：只实现 helper 用到的两个面（aggregate / 任意 op 由测试注入）。 */
function makeFakeDb(rows: Array<{ threadId: string; seq: number | null }>) {
  return {
    rows,
    agentMessage: {
      aggregate: async (args: {
        _max: { seq: boolean }
        where: { threadId: string }
      }) => {
        const seqs = rows
          .filter((r) => r.threadId === args.where.threadId && r.seq !== null)
          .map((r) => r.seq as number)
        return { _max: { seq: seqs.length ? Math.max(...seqs) : null } }
      },
    },
  }
}

/** Prisma P2002 形态的 unique violation。 */
function p2002(meta?: { target?: string[] }): unknown {
  return { code: 'P2002', meta }
}

describe('nextMessageSeq（读侧：max+1 口径）', () => {
  it('空会话首个 seq = 1', async () => {
    const db = makeFakeDb([])
    await expect(nextMessageSeq(db as never, 't1')).resolves.toBe(1)
  })

  it('既有 max=N ⇒ 下一个 N+1；NULL seq 行不参与 max（存量行回填前不挡新写）', async () => {
    const db = makeFakeDb([
      { threadId: 't1', seq: 3 },
      { threadId: 't1', seq: null },
      { threadId: 't2', seq: 99 },
    ])
    await expect(nextMessageSeq(db as never, 't1')).resolves.toBe(4)
    await expect(nextMessageSeq(db as never, 't2')).resolves.toBe(100)
  })
})

describe('runWithMessageSeq（写侧：冲突重试）', () => {
  it('正常路径：op 收到的 seq 来自 max+1', async () => {
    const db = makeFakeDb([{ threadId: 't1', seq: 5 }])
    const seen: number[] = []
    await runWithMessageSeq(db as never, 't1', async (seq) => {
      seen.push(seq)
    })
    expect(seen).toEqual([6])
  })

  it('P2002 冲突重试：重新取号后成功（模拟并发窗口内 max 被推进）', async () => {
    const db = makeFakeDb([{ threadId: 't1', seq: 5 }])
    let calls = 0
    const result = await runWithMessageSeq(db as never, 't1', async (seq) => {
      calls += 1
      if (calls === 1) {
        // 第一笔在取号后、写入前被并发方抢先写入了 seq=6
        db.rows.push({ threadId: 't1', seq: seq })
        throw p2002({ target: ['threadId', 'seq'] })
      }
      return `ok-with-${seq}`
    })
    expect(calls).toBe(2)
    expect(result).toBe('ok-with-7')
  })

  it('重试耗尽：恒 P2002 ⇒ 向上抛（不吞——落库失败不得降级成成功）', async () => {
    const db = makeFakeDb([])
    await expect(
      runWithMessageSeq(db as never, 't1', async () => {
        throw p2002()
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('非 unique 错误不重试，原样上抛（fail-loud 纪律）', async () => {
    const db = makeFakeDb([])
    let calls = 0
    await expect(
      runWithMessageSeq(db as never, 't1', async () => {
        calls += 1
        throw new Error('db down')
      }),
    ).rejects.toThrow('db down')
    expect(calls).toBe(1)
  })

  it('重试次数有上限（默认 3 次取号），不是无界循环', async () => {
    const db = makeFakeDb([])
    let calls = 0
    await expect(
      runWithMessageSeq(db as never, 't1', async () => {
        calls += 1
        throw p2002()
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(calls).toBe(3)
  })
})
