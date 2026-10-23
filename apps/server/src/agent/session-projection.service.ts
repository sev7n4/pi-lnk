/**
 * 投影面（D6）——会话内单调序号 `seq` 的**回填口径**。
 *
 * 2026-10-22（多端同会话一致性 · Task 7）。本文件目前只有纯函数层：
 * 迁移 20261022043000 先加列（纯 additive），回填与 `@@unique([threadId, seq])`
 * 在观察到「加列后一切照旧」之后由后续迁移收口，snapshot 端点（Step 5）随后接上。
 *
 * 为什么先有纯函数：回填动的是存量每一行，**不可重放就等于不可信**——
 * 同一批数据跑两次算出两套 seq，唯一索引就无从谈起。口径先被测锁死。
 */

/** 回填输入的最小形状：只要能定位「它是谁、在哪个会话、什么时候写的」。 */
export interface SeqSourceRow {
  id: string
  threadId: string
  /** Date / epoch ms / ISO 串都收——迁移回填与 Prisma 查询结果形态不一致。 */
  createdAt: Date | number | string
}

export type SeqAssignment<T> = T & { seq: number }

function msOf(createdAt: Date | number | string): number {
  if (createdAt instanceof Date) return createdAt.getTime()
  if (typeof createdAt === 'number') return createdAt
  const parsed = Date.parse(createdAt)
  // 解析不出来就当「最早」：宁可排在最前被看见，也不要 NaN 让比较静默失效
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * 给一批消息算会话内 seq。
 *
 * 排序口径（**可重放的关键**）：`(createdAt, id)` 全序 ——
 * 同一毫秒写入的消息用 `id` 兜底，否则结果取决于数据库返回的物理顺序。
 *
 * - 按 `threadId` 分组，每组从 1 连续编号（seq 是「会话内」序号，不是全局序号）；
 * - 输出已按该全序排好，**与输入顺序无关** ⇒ 重跑结果逐字节一致。
 */
export function computeSeqs<T extends SeqSourceRow>(rows: readonly T[]): Array<SeqAssignment<T>> {
  const ordered = [...rows].sort((a, b) => {
    if (a.threadId !== b.threadId) return a.threadId < b.threadId ? -1 : 1
    const ta = msOf(a.createdAt)
    const tb = msOf(b.createdAt)
    if (ta !== tb) return ta - tb
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })

  const seqByThread = new Map<string, number>()
  return ordered.map((row) => {
    const next = (seqByThread.get(row.threadId) ?? 0) + 1
    seqByThread.set(row.threadId, next)
    return { ...row, seq: next }
  })
}
