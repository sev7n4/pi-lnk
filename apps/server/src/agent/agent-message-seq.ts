/**
 * P4-T1（投影面收口）：AgentMessage `seq` 写路径的**唯一取号入口**。
 *
 * 背景：迁移 20261022043000 给 `AgentMessage` 加了 `seq Int?`（投影面 D6），
 * 但只加列未回填，且全仓此前 0 个写方。步 4 迁移落地
 * `@@unique([threadId, seq])` **之前**，全部写点必须先统一走本模块，
 * 否则唯一索引上线后并发写开始炸（先写方、后索引的顺序纪律）。
 *
 * 口径：运行时写入取 `max(seq)+1`（按 threadId 分组）。
 * 与回填口径 `computeSeqs`（session-projection.service.ts，(createdAt,id) 全序）
 * 在稳态下同序：新行 createdAt 必然 ≥ 既有行。
 *
 * 并发窗口：`aggregate` 与写入之间有真窗口（两笔并发同取 N+1）。
 * 单实例 + SQLite 单写者下窗口极窄，用 P2002 重试兜底（重新取号，≤3 次）；
 * 耗尽即上抛——落库失败不得降级成成功（本仓事故家族纪律，见 agent.service isUniqueViolation 注）。
 */

/** Prisma P2002 形态判定（与 agent.service.ts:256 同口径，独立成模块供跨服务复用）。 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
}

/** helper 需要的最小 db 面（PrismaService / 事务客户端都满足）。 */
export interface MessageSeqDb {
  agentMessage: {
    aggregate(args: {
      _max: { seq: true }
      where: { threadId: string }
    }): Promise<{ _max: { seq: number | null } }>
  }
}

/** 会话内下一个 seq（既有 max+1；NULL 不参与 max ⇒ 存量回填前不挡新写）。 */
export async function nextMessageSeq(db: MessageSeqDb, threadId: string): Promise<number> {
  const agg = await db.agentMessage.aggregate({
    _max: { seq: true },
    where: { threadId },
  })
  return (agg._max.seq ?? 0) + 1
}

/**
 * 在 op 内使用 freshly-allocated seq；P2002 时重新取号重试（默认 ≤3 次取号）。
 *
 * ⚠️ op 必须是「用传入 seq 做一次 create/upsert」的形态——重试会**整体重跑** op，
 * 有外部副作用的 op（先写别处再落库）不得传入。
 *
 * ⚠️ P2002 的语义归属由调用方裁决：finalizeTurn 的 create 有「runId 已被 owner
 * 记账 = 预期 no-op」的既有语义，外层 catch 保持不变——重试耗尽后抛出的 P2002
 * 仍落回那条既有路径（安静 no-op），不新增静默成功面。
 */
export async function runWithMessageSeq<T>(
  db: MessageSeqDb,
  threadId: string,
  op: (seq: number) => Promise<T>,
  opts?: { maxAttempts?: number },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3
  for (let attempt = 1; ; attempt++) {
    const seq = await nextMessageSeq(db, threadId)
    try {
      return await op(seq)
    } catch (err) {
      if (attempt < maxAttempts && isUniqueViolation(err)) continue
      throw err
    }
  }
}
