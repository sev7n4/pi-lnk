/**
 * P1-C C2b：服务端侧道写者的合规落库通道（规格
 * `docs/superpowers/specs/2026-11-02-p1c-write-path-governance-design.md` §3.1
 * 落库不变量的横向复用）。
 *
 * C1a/C2a 把**客户端**写面收进 ops PATCH（sanitizeClientOps 白名单）之后，
 * 审计（2026-11-03）发现服务端仍残留绕过 op 语义、直接 read-modify-write
 * 整份 canvasData 的侧道写者（persist-remote 的节点 url 回写、composition
 * confirm 的 compositionRunGroup 侧车回写）。本函数把它们收编到与
 * agent-canvas-tools.persist / sessions.service.patchCanvas 同形的通道：
 *
 * 不变量三条：
 * 1. **事务内读最新**——消灭「事务外读快照 → 写回覆盖中间写者」的丢更新窗口
 *    （红车重复图片事故的同族形态）；
 * 2. **落地只经 `applyCanvasActions`**——op 语义单实现，杜绝各写者自造合并方言；
 * 3. **stagedActions 守卫**——staged 面是用户显式暂存区，服务端写不得混入：
 *    `onStaged:'skip'`（后台对账类写者退让，返回 skipped_staged 留痕）
 *    / `onStaged:'conflict'`（用户交互类写者由调用方映射 409，与 persist 家族同语义）。
 *
 * 与白名单的关系：`sanitizeClientOps` 只约束**客户端** PATCH（服务端专属字段禁写）；
 * 服务端写者（storageTier / compositionRunGroup 等）本来就是这些服务端字段的合法
 * owner——合规定义是 op 语义 + 事务 + staged 守卫，不是客户端白名单。
 */
import type { Prisma } from '@prisma/client'
import { applyCanvasActions } from '@lnkpi/agent'
import type { CanvasAction, CanvasData } from '@lnkpi/shared'
import type { PrismaService } from '../prisma/prisma.service'

/** 宽松 parse（默认）：坏 JSON / 缺 nodes/edges 回退空数组——后台写者 fail-soft 纪律。
 *  edges 必须兜底：applier 展开时 `edges: [...data.edges]`，存量脏数据可能缺该键。 */
function parseCanvasLoose(raw: string | null | undefined): CanvasData {
  if (!raw) return { nodes: [], edges: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasData>
    if (!parsed || !Array.isArray(parsed.nodes)) return { nodes: [], edges: [] }
    return { ...parsed, edges: Array.isArray(parsed.edges) ? parsed.edges : [] } as CanvasData
  } catch {
    return { nodes: [], edges: [] }
  }
}

export interface GovernedCanvasOpBuild {
  ops: CanvasAction[]
  /**
   * 与 canvasData **同一事务**原子落库的附加列（如 compositionPreview）。
   * 只放确需与 op 写同生共死的载荷，禁止拿来绕过 op 语义写画布本体。
   */
  extraUpdate?: { compositionPreview?: string }
}

export type GovernedCanvasOpOutcome =
  | { outcome: 'applied'; canvas: CanvasData }
  | { outcome: 'skipped_staged' | 'skipped_missing_session' | 'skipped_no_ops' }

export interface GovernedCanvasOpOpts {
  /** stagedActions 在场时的处置：'skip'=退让（后台写者）/ 'conflict'=调用方映射 409。 */
  onStaged: 'skip' | 'conflict'
  /**
   * parse 策略注入：默认宽松回退空画布；需要「parse 失败即整体失败」的写者
   * （composition confirm 的 BadRequest 语义）传自己的抛错 parse。
   */
  parse?: (raw: string | null | undefined) => CanvasData
  /**
   * 吸收态守卫拒绝留痕（规格 2026-11-04-generation-terminal-projection §5.2
   * 打点 `terminal_regen_rejected`）：传 logger 的写者获得观测，不传则静默拒绝。
   */
  onGuardReject?: (nodeId: string) => void
}

/**
 * 服务端画布 op 写的唯一合规落库形态：
 * `$transaction(读最新 → build ops → applyCanvasActions → 写回)`。
 * 返回值分类供调用方映射自己的失败语义（409 / 静默退让 / NotFound），本函数不抛业务异常。
 */
export async function transactGovernedCanvasOps(
  prisma: Pick<PrismaService, '$transaction'>,
  sessionId: string,
  build: (canvas: CanvasData) => GovernedCanvasOpBuild | null,
  opts: GovernedCanvasOpOpts,
): Promise<GovernedCanvasOpOutcome> {
  const parse = opts.parse ?? parseCanvasLoose
  const run = async (tx: Prisma.TransactionClient): Promise<GovernedCanvasOpOutcome> => {
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { canvasData: true, stagedActions: true },
    })
    if (!session) return { outcome: 'skipped_missing_session' }
    if (session.stagedActions) return { outcome: 'skipped_staged' }
    const current = parse(session.canvasData)
    const built = build(current)
    if (!built || built.ops.length === 0) return { outcome: 'skipped_no_ops' }
    const updated = applyCanvasActions(current, built.ops, {
      onGuardReject: (nodeId) =>
        opts.onGuardReject?.(nodeId),
    })
    const merged: CanvasData = { ...current, ...updated }
    await tx.session.update({
      where: { id: sessionId },
      data: { canvasData: JSON.stringify(merged), ...(built.extraUpdate ?? {}) },
    })
    return { outcome: 'applied', canvas: merged }
  }
  return prisma.$transaction(run)
}
