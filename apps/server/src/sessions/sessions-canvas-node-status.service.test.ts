/**
 * CanvasNodeStatusService 单测（B2/B3，2026-11-02 死循环护栏 RCA v2 §5 验收 2/3）。
 *
 * 变异纪律：删 assertNodeStatusTransition 守卫 → 「generating→pending_confirm 拒绝」
 * 用例必须红；删 preTerminal 判定 → reconcile 幂等用例必须红。守卫禁删。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  assertNodeStatusTransition,
  NODE_STATUS_TRANSITIONS,
} from './sessions-canvas-node-status.service'

// ── B3 迁移表 ────────────────────────────────────────────────────────────

test('B3：generating → pending_confirm 非法（事故形态：重提议盖掉生成中）', () => {
  const v = assertNodeStatusTransition('generating', 'pending_confirm')
  assert.equal(v.ok, false)
})

test('B3：fallback_pending → pending_confirm 非法', () => {
  assert.equal(assertNodeStatusTransition('fallback_pending', 'pending_confirm').ok, false)
})

test('B3：generating → completed/failed/error/fallback_pending 合法（终态推进）', () => {
  for (const to of ['completed', 'failed', 'error', 'fallback_pending']) {
    assert.equal(assertNodeStatusTransition('generating', to).ok, true, to)
  }
})

test('B3：终态 → pending_confirm/generating 合法（重提议/重生成）', () => {
  for (const from of ['completed', 'failed', 'error']) {
    assert.equal(assertNodeStatusTransition(from, 'pending_confirm').ok, true, from)
    assert.equal(assertNodeStatusTransition(from, 'generating').ok, true, from)
  }
})

test('B3：draft → pending_confirm/generating 合法；draft → 终态非法（防旧记录复活草稿节点）', () => {
  assert.equal(assertNodeStatusTransition('draft', 'pending_confirm').ok, true)
  assert.equal(assertNodeStatusTransition('draft', 'generating').ok, true)
  assert.equal(assertNodeStatusTransition('draft', 'completed').ok, false)
})

test('B3：pending_confirm → 终态合法（B2 对账修复：记录已终态而节点被旧状态卡住）', () => {
  for (const to of ['completed', 'failed', 'error']) {
    assert.equal(assertNodeStatusTransition('pending_confirm', to).ok, true, to)
  }
})

test('B3：pending_confirm → pending_confirm 合法（B6 重提 epoch+1）', () => {
  assert.equal(assertNodeStatusTransition('pending_confirm', 'pending_confirm').ok, true)
})

test('B3：存量无状态节点（undefined）宽容放行；未知旧状态宽容放行', () => {
  assert.equal(assertNodeStatusTransition(undefined, 'generating').ok, true)
  assert.equal(assertNodeStatusTransition('', 'generating').ok, true)
  assert.equal(assertNodeStatusTransition('legacy_unknown', 'generating').ok, true)
})

test('B3：迁移表词表完备（每个已声状态都有出边定义）', () => {
  for (const s of ['draft', 'pending_confirm', 'generating', 'fallback_pending', 'completed', 'failed', 'error']) {
    assert.ok(NODE_STATUS_TRANSITIONS[s], `缺 ${s} 的迁移定义`)
  }
})

// ── B2 mergeNodeData / reconcileTerminal（fake prisma 事务驱动）──────────
import { CanvasNodeStatusService } from './sessions-canvas-node-status.service'

function canvasSession(nodes: Array<{ id: string; data?: Record<string, unknown> }>, stagedActions: unknown = null) {
  return {
    canvasData: JSON.stringify({ nodes, edges: [] }),
    stagedActions,
  }
}

function fakePrisma(session: ReturnType<typeof canvasSession> | null) {
  const written: unknown[] = []
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        session: {
          findUnique: async () => session,
          update: async ({ data }: { data: { canvasData: string } }) => {
            written.push(data.canvasData)
            return {}
          },
        },
      }),
  }
  return { prisma: prisma as never, written }
}

test('B2：mergeNodeData 应用 patch（status + generationRecordId 合并进 node.data）', async () => {
  const session = canvasSession([{ id: 'n1', data: { status: 'generating', prompt: 'x' } }])
  const { prisma, written } = fakePrisma(session)
  const svc = new CanvasNodeStatusService(prisma)
  const r = await svc.mergeNodeData('s1', 'n1', { status: 'completed', generationRecordId: 'rec1' })
  assert.equal(r, 'applied')
  const saved = JSON.parse(written[0]!)
  const node = saved.nodes.find((n: { id: string }) => n.id === 'n1')
  assert.equal(node.data.status, 'completed')
  assert.equal(node.data.generationRecordId, 'rec1')
  assert.equal(node.data.prompt, 'x', '既有字段必须保留')
})

test('B2：非法迁移拒绝且不落库（generating → pending_confirm）', async () => {
  const session = canvasSession([{ id: 'n1', data: { status: 'generating' } }])
  const { prisma, written } = fakePrisma(session)
  const svc = new CanvasNodeStatusService(prisma)
  const r = await svc.mergeNodeData('s1', 'n1', { status: 'pending_confirm' })
  assert.equal(r, 'rejected_transition')
  assert.equal(written.length, 0)
})

test('B2：stagedActions 在场 → 跳过（不混入用户暂存区）', async () => {
  const session = canvasSession([{ id: 'n1', data: { status: 'generating' } }], [{ type: 'add_node' }])
  const { prisma, written } = fakePrisma(session)
  const svc = new CanvasNodeStatusService(prisma)
  const r = await svc.mergeNodeData('s1', 'n1', { status: 'completed' })
  assert.equal(r, 'skipped_staged')
  assert.equal(written.length, 0)
})

test('B2：节点/会话缺失 → 分类跳过不抛', async () => {
  const { prisma } = fakePrisma(canvasSession([{ id: 'other' }]))
  const svc = new CanvasNodeStatusService(prisma)
  assert.equal(await svc.mergeNodeData('s1', 'n1', { status: 'completed' }), 'skipped_missing_node')
  const { prisma: p2 } = fakePrisma(null)
  const svc2 = new CanvasNodeStatusService(p2)
  assert.equal(await svc2.mergeNodeData('s1', 'n1', { status: 'completed' }), 'skipped_missing_session')
})

test('B2：reconcileTerminal 幂等——节点已终态跳过，pre-terminal 才修', async () => {
  const doneSession = canvasSession([{ id: 'n1', data: { status: 'completed' } }])
  const { prisma: p1 } = fakePrisma(doneSession)
  const svc1 = new CanvasNodeStatusService(p1)
  assert.equal(await svc1.reconcileTerminal('s1', 'n1', 'completed', 'rec1'), 'skipped_current')

  const stuckSession = canvasSession([{ id: 'n1', data: { status: 'pending_confirm' } }])
  const { prisma: p2, written } = fakePrisma(stuckSession)
  const svc2 = new CanvasNodeStatusService(p2)
  assert.equal(await svc2.reconcileTerminal('s1', 'n1', 'completed', 'rec1'), 'applied')
  const saved = JSON.parse(written[0]!)
  assert.equal(saved.nodes.find((n: { id: string }) => n.id === 'n1').data.status, 'completed')
})
