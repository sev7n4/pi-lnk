/**
 * P1-C C2b：服务端侧道写者合规落库通道的行为级判据。
 *
 * 锁四条不变量（canvas-op-write.ts 头注释）：
 * 1. 事务内读最新（mock tx 读到的就是落库前最后一眼）；
 * 2. 落地只经 applyCanvasActions（update_node data 浅合并，非整份替换）；
 * 3. stagedActions 在场 ⇒ 一律不写（skip/conflict 两种模式同判）；
 * 4. extraUpdate 与 canvasData 同一次 update 原子落库。
 */
import { describe, expect, it, vi } from 'vitest'
import type { PrismaService } from '../prisma/prisma.service'
import { transactGovernedCanvasOps } from './canvas-op-write'

type Row = {
  id: string
  canvasData: string | null
  stagedActions?: string | null
}

function createPrisma(rows: Map<string, Row>) {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const tx = {
    session: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args)
        const current = rows.get(args.where.id)
        if (current) rows.set(args.where.id, { ...current, ...args.data } as Row)
        return current
      },
    },
  }
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  }
  return { rows, updates, prisma: prisma as unknown as PrismaService }
}

function canvasRow(id: string, canvas: unknown, stagedActions?: string): [string, Row] {
  return [
    id,
    { id, canvasData: JSON.stringify(canvas), ...(stagedActions ? { stagedActions } : {}) },
  ]
}

describe('transactGovernedCanvasOps', () => {
  it('applied：update_node 走 applier 浅合并，节点其余 data 键保留', async () => {
    const { rows, updates, prisma } = createPrisma(
      new Map([
        canvasRow('s1', {
          nodes: [{ id: 'n1', type: 'image', position: { x: 1, y: 2 }, data: { status: 'completed', title: 'T' } }],
          edges: [],
        }),
      ]),
    )
    const result = await transactGovernedCanvasOps(
      prisma,
      's1',
      () => ({
        ops: [
          { type: 'update_node', payload: { id: 'n1', data: { storageTier: 'persisted' } } },
        ],
      }),
      { onStaged: 'skip' },
    )
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    const node = result.canvas.nodes[0]!
    expect(node.data).toMatchObject({ status: 'completed', title: 'T', storageTier: 'persisted' })
    expect(updates).toHaveLength(1)
    expect(updates[0]!.data.canvasData).toBe(JSON.stringify(result.canvas))
  })

  it('skipped_staged：stagedActions 在场时不 build、不写（skip 模式退让）', async () => {
    const { updates, prisma } = createPrisma(
      new Map([
        canvasRow(
          's1',
          { nodes: [], edges: [] },
          JSON.stringify([{ type: 'add_node', payload: {} }]),
        ),
      ]),
    )
    const build = vi.fn(() => null)
    const result = await transactGovernedCanvasOps(prisma, 's1', build, { onStaged: 'skip' })
    expect(result.outcome).toBe('skipped_staged')
    expect(build).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('skipped_staged：conflict 模式同样不写，由调用方映射 409', async () => {
    const { updates, prisma } = createPrisma(
      new Map([
        canvasRow('s1', { nodes: [], edges: [] }, JSON.stringify([{ type: 'add_node', payload: {} }])),
      ]),
    )
    const result = await transactGovernedCanvasOps(prisma, 's1', () => ({ ops: [] }), {
      onStaged: 'conflict',
    })
    expect(result.outcome).toBe('skipped_staged')
    expect(updates).toHaveLength(0)
  })

  it('skipped_missing_session / skipped_no_ops：不抛异常，返回分类', async () => {
    const { updates, prisma } = createPrisma(new Map())
    const missing = await transactGovernedCanvasOps(prisma, 'nope', () => ({ ops: [] }), {
      onStaged: 'conflict',
    })
    expect(missing.outcome).toBe('skipped_missing_session')

    const { prisma: prisma2 } = createPrisma(
      new Map([canvasRow('s1', { nodes: [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: {} }], edges: [] })]),
    )
    const noNode = await transactGovernedCanvasOps(prisma2, 's1', (canvas) => {
      const node = canvas.nodes.find((n) => n.id === 'absent')
      if (!node) return null
      return { ops: [] }
    }, { onStaged: 'skip' })
    expect(noNode.outcome).toBe('skipped_no_ops')
    expect(updates).toHaveLength(0)
  })

  it('extraUpdate 与 canvasData 同一次 update 原子落库', async () => {
    const { rows, updates, prisma } = createPrisma(
      new Map([canvasRow('s1', { nodes: [], edges: [] })]),
    )
    await transactGovernedCanvasOps(
      prisma,
      's1',
      () => ({
        ops: [{ type: 'set_composition_run_group', payload: { compositionRunGroup: { nodeIds: ['n1'], dumpHash: 'h', createdAt: 't' } } }],
        extraUpdate: { compositionPreview: '{"v":1}' },
      }),
      { onStaged: 'conflict' },
    )
    expect(updates).toHaveLength(1)
    const saved = JSON.parse(rows.get('s1')!.canvasData!) as { compositionRunGroup?: unknown }
    expect(saved.compositionRunGroup).toMatchObject({ dumpHash: 'h' })
    expect(updates[0]!.data.compositionPreview).toBe('{"v":1}')
  })

  it('parse 抛错 ⇒ 整体失败且零写入（composition BadRequest 语义的挂靠点）', async () => {
    const { updates, prisma } = createPrisma(
      new Map([canvasRow('s1', { nodes: [], edges: [] })]),
    )
    await expect(
      transactGovernedCanvasOps(
        prisma,
        's1',
        () => ({ ops: [{ type: 'update_node', payload: { id: 'n1', data: {} } }] }),
        {
          onStaged: 'conflict',
          parse: () => {
            throw new Error('bad canvas')
          },
        },
      ),
    ).rejects.toThrow('bad canvas')
    expect(updates).toHaveLength(0)
  })
})
