/**
 * P1-C C1a（规格 2026-11-02-p1c-write-path-governance-design §3.1/§5）：
 * PATCH /sessions/:id/canvas——ops 白名单 + applier 落库 + PUT 弃用打点。
 *
 * 判据覆盖：
 * - C1-1/C1-3：客户端 ops 提交 status/errorMessage 等服务端字段 ⇒ 键被剥除+warn，
 *   其余字段照常落地；非 whitelisted op 类型整体剥除。
 * - C1-5：同节点不同字段（或不同节点）ops 各自落库（applier 键级 merge）。
 * - remove_node 保护：generating/pending_confirm ⇒ 409；draft 可删。
 * - stagedActions 未清 ⇒ 409（与 agent persist 同语义）。
 * - PUT 弃用打点：sessions.update 带 canvasData ⇒ canvas_put_deprecated warn。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionsService } from './sessions.service'
import { sanitizeClientOps, CLIENT_FORBIDDEN_NODE_DATA_KEYS } from './sessions-canvas-patch'

function canvas(nodes: unknown[]) {
  return JSON.stringify({ nodes, edges: [] })
}

describe('sanitizeClientOps（C1a 纯函数）', () => {
  it('update_node.data 的服务端五键被剥除并计数（C1-3）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ops = [
      {
        type: 'update_node',
        payload: {
          id: 'n1',
          data: {
            status: 'completed',
            errorMessage: 'x',
            generationRecordId: 'rec',
            generationStartedAt: 't',
            proposalEpoch: 3,
            title: '保留',
          },
        },
      },
    ]
    const { sanitized, strippedKeys, droppedOps } = sanitizeClientOps(ops)
    expect(strippedKeys).toBe(5)
    expect(droppedOps).toBe(0)
    const data = (sanitized[0] as { payload: { data: Record<string, unknown> } }).payload.data
    for (const key of CLIENT_FORBIDDEN_NODE_DATA_KEYS) expect(key in data).toBe(false)
    expect(data.title).toBe('保留')
    warn.mockRestore()
  })

  it('非 whitelisted op 类型整体剥除；set_viewport 放行；脏输入安全', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sanitized, droppedOps } = sanitizeClientOps([
      { type: 'set_viewport', payload: { viewport: { x: 1 } } },
      { type: 'update_node', payload: { id: 'n1', data: { title: 'ok' } } },
      { type: 'rewrite_all', payload: {} },
      'garbage',
      null,
    ])
    expect(sanitized).toHaveLength(2)
    expect(droppedOps).toBe(3)
    warn.mockRestore()
  })

  it('C2a 侧车 op：合法载荷放行，畸形载荷整体剥除', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const group = { id: 'g1', title: 't', childIds: ['n1'], position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
    const { sanitized, droppedOps } = sanitizeClientOps([
      { type: 'set_groups', payload: { groups: [group] } },
      { type: 'set_groups', payload: { groups: [] } },
      { type: 'set_composition_run_group', payload: { compositionRunGroup: { nodeIds: ['a'], dumpHash: 'h', createdAt: 't' } } },
      { type: 'set_composition_run_group', payload: { compositionRunGroup: null } },
      // 畸形：groups 非数组 / 缺载荷 / runGroup 缺字段
      { type: 'set_groups', payload: { groups: 'oops' } },
      { type: 'set_groups', payload: {} },
      { type: 'set_composition_run_group', payload: { compositionRunGroup: { nodeIds: 'not-array' } } },
      { type: 'set_composition_run_group', payload: {} },
    ])
    expect(sanitized).toHaveLength(4)
    expect(droppedOps).toBe(4)
    expect((sanitized[0] as { payload: { groups: unknown[] } }).payload.groups).toEqual([group])
    expect(
      (sanitized[3] as { payload: { compositionRunGroup: unknown } }).payload.compositionRunGroup,
    ).toBeNull()
    warn.mockRestore()
  })
})

describe('SessionsService.patchCanvas（C1a 端到端）', () => {
  let svc: SessionsService
  let findUnique: ReturnType<typeof vi.fn>
  let txFindUnique: ReturnType<typeof vi.fn>
  let txUpdate: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    findUnique = vi.fn()
    txFindUnique = vi.fn()
    txUpdate = vi.fn()
    const tx = { session: { findUnique: txFindUnique, update: txUpdate } }
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        {
          provide: PrismaService,
          useValue: {
            session: { findUnique },
            $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
          },
        },
      ],
    }).compile()
    svc = moduleRef.get(SessionsService)
  })

  function ownSession(canvasRaw: string | null, stagedActions: string | null = null) {
    findUnique.mockResolvedValue({ id: 's1', userId: 'u1', canvasData: canvasRaw, stagedActions })
  }

  it('C1-3：客户端 ops 提交 status ⇒ 键被剥除，其余字段落地，applied 计数', async () => {
    ownSession(canvas([{ id: 'n1', data: { status: 'draft', title: '旧' } }]))
    txFindUnique.mockResolvedValue({
      canvasData: canvas([{ id: 'n1', data: { status: 'draft', title: '旧' } }]),
      stagedActions: null,
    })
    txUpdate.mockResolvedValue({ id: 's1' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = await svc.patchCanvas('s1', 'u1', [
      { type: 'update_node', payload: { id: 'n1', data: { status: 'completed', title: '新' } } },
    ])
    expect(out).toEqual({ applied: 1 })
    const saved = JSON.parse(txUpdate.mock.calls[0][0].data.canvasData)
    expect(saved.nodes[0].data.title).toBe('新')
    expect(saved.nodes[0].data.status).toBe('draft') // 服务端值保留
    warn.mockRestore()
  })

  it('C1-5：同节点不同字段两字段均落库（applier 键级 merge）', async () => {
    const prev = canvas([{ id: 'n1', data: { title: 'T0', prompt: 'P0' } }])
    ownSession(prev)
    txFindUnique.mockResolvedValue({ canvasData: prev, stagedActions: null })
    txUpdate.mockResolvedValue({ id: 's1' })

    await svc.patchCanvas('s1', 'u1', [
      { type: 'update_node', payload: { id: 'n1', data: { title: 'T1' } } },
      { type: 'update_node', payload: { id: 'n1', data: { prompt: 'P1' } } },
    ])
    const saved = JSON.parse(txUpdate.mock.calls[0][0].data.canvasData)
    expect(saved.nodes[0].data.title).toBe('T1')
    expect(saved.nodes[0].data.prompt).toBe('P1')
  })

  it('remove_node：generating/pending_confirm ⇒ 409；draft 节点可删', async () => {
    ownSession(
      canvas([
        { id: 'gen', data: { status: 'generating' } },
        { id: 'dr', data: { status: 'draft' } },
      ]),
    )
    await expect(
      svc.patchCanvas('s1', 'u1', [{ type: 'remove_node', payload: { id: 'gen' } }]),
    ).rejects.toBeInstanceOf(ConflictException)

    txFindUnique.mockResolvedValue({
      canvasData: canvas([
        { id: 'gen', data: { status: 'generating' } },
        { id: 'dr', data: { status: 'draft' } },
      ]),
      stagedActions: null,
    })
    txUpdate.mockResolvedValue({ id: 's1' })
    await svc.patchCanvas('s1', 'u1', [{ type: 'remove_node', payload: { id: 'dr' } }])
    const saved = JSON.parse(txUpdate.mock.calls[0][0].data.canvasData)
    expect(saved.nodes.map((n: { id: string }) => n.id)).toEqual(['gen'])
  })

  it('stagedActions 未清 ⇒ 409（与 agent persist 同语义）', async () => {
    ownSession(canvas([]))
    txFindUnique.mockResolvedValue({
      canvasData: canvas([]),
      stagedActions: JSON.stringify([{ type: 'update_node', payload: {} }]),
    })
    await expect(
      svc.patchCanvas('s1', 'u1', [
        { type: 'update_node', payload: { id: 'n1', data: { title: 'x' } } },
      ]),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('属主校验：他人会话 403、不存在 404；空 ops ⇒ applied 0 不进事务', async () => {
    findUnique.mockResolvedValue({ id: 's1', userId: 'other', canvasData: canvas([]) })
    await expect(svc.patchCanvas('s1', 'u1', [])).rejects.toBeInstanceOf(ForbiddenException)

    findUnique.mockResolvedValue(null)
    await expect(svc.patchCanvas('s1', 'u1', [])).rejects.toBeInstanceOf(NotFoundException)

    ownSession(canvas([]))
    await expect(svc.patchCanvas('s1', 'u1', [])).resolves.toEqual({ applied: 0 })
    expect(txUpdate).not.toHaveBeenCalled()
  })
})

describe('SessionsService.update → PUT 弃用打点（C1a）', () => {
  it('带 canvasData ⇒ warn canvas_put_deprecated；title-only ⇒ 不打', async () => {
    let svc: SessionsService
    const findUnique = vi.fn().mockResolvedValue({
      id: 's1',
      userId: 'u1',
      canvasData: canvas([]),
    })
    const prismaUpdate = vi.fn().mockResolvedValue({
      id: 's1',
      title: 't',
      userId: 'u1',
      canvasData: canvas([]),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: PrismaService, useValue: { session: { findUnique, update: prismaUpdate } } },
      ],
    }).compile()
    svc = moduleRef.get(SessionsService)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loggerWarn = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')

    await svc.update('s1', 'u1', { canvasData: { nodes: [{ id: 'a' }, { id: 'b' }] } })
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(String(loggerWarn.mock.calls[0][0])).toMatch(/^canvas_put_deprecated sessionId=s1 nodes=2$/)

    await svc.update('s1', 'u1', { title: '改名' })
    expect(loggerWarn).toHaveBeenCalledTimes(1) // 不新增
    warn.mockRestore()
  })
})
