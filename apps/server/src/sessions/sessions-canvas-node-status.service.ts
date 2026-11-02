/**
 * CanvasNodeStatusService（B2/B3，2026-11-02 老黄牛死循环护栏，RCA v2 §4-B2/B3）。
 *
 * 职责：**回合外生成终态 → 画布节点 status 的服务端单点写者**。
 *
 * 事故根因 R4：GenerationRecord 结算（completeImage/completeVideo/reapOne）只写记录，
 * 画布节点 status 从不推进——老黄牛卡死 pending_confirm、乌龟卡死 generating，模型每轮
 * 读画布都看到旧状态而无限重提议。本服务补上「记录终态 ⇒ 节点 SSOT」的最后一跳。
 *
 * 为什么放 SessionsModule：依赖方向 agent → studio（agent-canvas-tools 注入 StudioService），
 * studio 不能反向 import agent/canvas 模块（Nest 环）；sessions 是双方共同的低层模块
 * （studio.module 已 import SessionsModule）。
 *
 * 语义纪律：
 * - **fail-soft 绝不抛**：调用方是生成结算路径，画布写失败绝不能拖垮结算（退款/记录优先）；
 *   失败以返回值 + warn 留痕，由调用方记日志。
 * - 读-改-写在同一 $transaction 内（与 agent-canvas-tools.persist 同形），stagedActions
 *   在场时跳过（staged 面是用户显式暂存区，服务端后台写不得混入）。
 * - B3 迁移表守卫：非法迁移（generating→pending_confirm = 本次事故形态）拒绝并留痕，
 *   绝不把状态写坏。
 */
import { Inject, Injectable } from '@nestjs/common'
import type { CanvasData } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'

/** B3 画布节点状态机词表与合法迁移（RCA v2 §4-B3）。
 *  ⚠️ 唯一权威定义：B1（proposeGeneration 409 守卫）与本服务共用；后续 start 与 wait
 *  等写者逐步收敛到本表（违规迁移打点 follow-up）。 */
export const NODE_STATUS_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  draft: new Set(['pending_confirm', 'generating']),
  // pending_confirm → pending_confirm：B6 重提（epoch+1）合法；
  // pending_confirm → 终态：B2 对账修复（记录已终态而节点被旧状态卡住 = 本次事故形态）
  pending_confirm: new Set([
    'draft',
    'generating',
    'pending_confirm',
    'completed',
    'failed',
    'error',
  ]),
  // generating 不可被打回 pending_confirm（本次事故形态）也不可直接改判终态外的值
  generating: new Set(['completed', 'failed', 'error', 'fallback_pending']),
  fallback_pending: new Set(['generating', 'completed', 'failed', 'error']),
  // 终态 → pending_confirm/generating：用户重提议/重生成合法
  completed: new Set(['pending_confirm', 'generating']),
  failed: new Set(['pending_confirm', 'generating']),
  error: new Set(['pending_confirm', 'generating']),
}

/** 纯函数裁决（可单测）：undefined（存量无状态节点）宽容放行。 */
export function assertNodeStatusTransition(
  from: unknown,
  to: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof from !== 'string' || !from) return { ok: true }
  const legal = NODE_STATUS_TRANSITIONS[from]
  if (!legal) return { ok: true }
  if (legal.has(to)) return { ok: true }
  return { ok: false, reason: `非法状态迁移 ${from} → ${to}` }
}

export type NodeStatusWriteResult =
  | 'applied'
  | 'skipped_staged'
  | 'skipped_missing_node'
  | 'skipped_missing_session'
  | 'rejected_transition'

/** 视为「生成仍在进行」的节点状态（B2 对账只修这些）。 */
const PRE_TERMINAL_STATUSES = new Set(['generating', 'pending_confirm', 'fallback_pending'])

function parseCanvas(raw: string | null | undefined): CanvasData {
  if (!raw) return { nodes: [], edges: [] }
  try {
    const parsed = JSON.parse(raw) as CanvasData
    return parsed && Array.isArray(parsed.nodes) ? parsed : { nodes: [], edges: [] }
  } catch {
    return { nodes: [], edges: [] }
  }
}

@Injectable()
export class CanvasNodeStatusService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 合并节点 data（读-改-写，事务内；迁移表守卫）。fail-soft：不抛，返回结果分类。
   * @param patch 合并进 node.data 的增量（如 { status:'completed', generationRecordId }）
   */
  async mergeNodeData(
    sessionId: string,
    nodeId: string,
    patch: Record<string, unknown>,
  ): Promise<NodeStatusWriteResult> {
    const nextStatus = typeof patch.status === 'string' ? patch.status : undefined
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { canvasData: true, stagedActions: true },
      })
      if (!session) return 'skipped_missing_session'
      if (session.stagedActions) return 'skipped_staged'
      const canvas = parseCanvas(session.canvasData)
      const node = canvas.nodes.find((n) => n.id === nodeId)
      if (!node) return 'skipped_missing_node'
      if (nextStatus) {
        const verdict = assertNodeStatusTransition(
          (node.data as { status?: unknown } | undefined)?.status,
          nextStatus,
        )
        if (!verdict.ok) {
          console.warn(
            `[node-status] rejected: ${verdict.reason} sessionId=${sessionId} nodeId=${nodeId} patch=${JSON.stringify(patch)}`,
          )
          return 'rejected_transition'
        }
      }
      node.data = { ...(node.data ?? {}), ...patch }
      await tx.session.update({
        where: { id: sessionId },
        data: { canvasData: JSON.stringify(canvas) },
      })
      return 'applied'
    })
  }

  /**
   * B2 对账专用：记录已落终态而节点仍 pre-terminal（generating/pending_confirm/
   * fallback_pending）时，把节点推到记录终态。节点已是终态/草稿 → 'skipped_current'
   * （按状态幂等，reaper 每轮扫描不会重复写）。
   */
  async reconcileTerminal(
    sessionId: string,
    nodeId: string,
    recordStatus: 'completed' | 'failed' | 'error',
    generationRecordId: string,
  ): Promise<NodeStatusWriteResult | 'skipped_current'> {
    const preTerminal = await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { canvasData: true },
      })
      if (!session) return false
      const canvas = parseCanvas(session.canvasData)
      const node = canvas.nodes.find((n) => n.id === nodeId)
      if (!node) return false
      const status = (node.data as { status?: unknown } | undefined)?.status
      return typeof status === 'string' && PRE_TERMINAL_STATUSES.has(status)
    })
    if (!preTerminal) return 'skipped_current'
    return this.mergeNodeData(sessionId, nodeId, {
      status: recordStatus === 'error' ? 'error' : recordStatus,
      generationRecordId,
    })
  }
}
