/**
 * P1-C C0 守卫止血（规格 2026-11-02-p1c-write-path-governance-design §4.1）：
 * pending_confirm 客户端写守卫共享纯函数 + canvas 面接入。
 *
 * 历史：sessions 面守卫 2026-10-13 上线（虚假确认事故）→ P0-4 2026-10-30 收紧；
 * `PUT /agent/canvas/update` 是零守卫旁路，C0 堵缺口并抽共享函数禁漂移。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { CanvasService } from './canvas.service'
import { guardPendingConfirmStatuses } from './pending-confirm-guard'

function canvas(nodes: unknown[]) {
  return JSON.stringify({ nodes, edges: [] })
}

describe('guardPendingConfirmStatuses（共享纯函数）', () => {
  it('prev pending_confirm + 客户端写终态 ⇒ 字段级保留 pending_confirm（虚假确认事故复现）', () => {
    const prev = canvas([{ id: 'n1', data: { status: 'pending_confirm', prompt: 'p' } }])
    const next = { nodes: [{ id: 'n1', data: { status: 'completed', prompt: 'p' } }] }
    const out = guardPendingConfirmStatuses(prev, next) as { nodes: Array<{ data: Record<string, unknown> }> }
    expect(out.nodes[0].data.status).toBe('pending_confirm')
    // 其余字段照常落库
    expect(out.nodes[0].data.prompt).toBe('p')
  })

  it('合法出口（pending_confirm 幂等 / generating）放行', () => {
    const prev = canvas([{ id: 'n1', data: { status: 'pending_confirm' } }])
    for (const exit of ['pending_confirm', 'generating']) {
      const next = { nodes: [{ id: 'n1', data: { status: exit } }] }
      const out = guardPendingConfirmStatuses(prev, next) as { nodes: Array<{ data: { status: string } }> }
      expect(out.nodes[0].data.status).toBe(exit)
    }
  })

  it('客户端非法写 error/draft/无 status ⇒ 保留 pending_confirm', () => {
    const prev = canvas([{ id: 'n1', data: { status: 'pending_confirm' } }])
    for (const bad of ['error', 'draft', undefined]) {
      const data = bad === undefined ? {} : { status: bad }
      const out = guardPendingConfirmStatuses(prev, { nodes: [{ id: 'n1', data }] }) as {
        nodes: Array<{ data: Record<string, unknown> }>
      }
      expect(out.nodes[0].data.status).toBe('pending_confirm')
    }
  })

  it('prev 非 pending_confirm 节点不干预（draft/completed/generating 自由写）', () => {
    const prev = canvas([
      { id: 'a', data: { status: 'draft' } },
      { id: 'b', data: { status: 'completed' } },
    ])
    const next = {
      nodes: [
        { id: 'a', data: { status: 'completed' } },
        { id: 'b', data: { status: 'error' } },
      ],
    }
    const out = guardPendingConfirmStatuses(prev, next) as { nodes: Array<{ data: { status: string } }> }
    expect(out.nodes[0].data.status).toBe('completed')
    expect(out.nodes[1].data.status).toBe('error')
  })

  it('prev 脏 JSON ⇒ 守卫直通（保存优先）；next 非 canvas 形状原样返回', () => {
    const next = { nodes: [{ id: 'n1', data: { status: 'completed' } }] }
    expect(guardPendingConfirmStatuses('not-json{', next)).toBe(next)
    expect(guardPendingConfirmStatuses(null, next)).toBe(next)
    expect(guardPendingConfirmStatuses(canvas([]), 'flat-string')).toBe('flat-string')
    expect(guardPendingConfirmStatuses(canvas([]), null)).toBe(null)
  })

  it('next 新增节点（prev 无此 id）不干预', () => {
    const prev = canvas([])
    const next = { nodes: [{ id: 'new', data: { status: 'completed' } }] }
    const out = guardPendingConfirmStatuses(prev, next) as { nodes: Array<{ data: { status: string } }> }
    expect(out.nodes[0].data.status).toBe('completed')
  })
})

describe('CanvasService.update → C0 守卫接入（堵 P0-4 旁路）', () => {
  let svc: CanvasService
  let findFirst: ReturnType<typeof vi.fn>
  let prismaUpdate: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    findFirst = vi.fn()
    prismaUpdate = vi.fn()
    const moduleRef = await Test.createTestingModule({
      providers: [
        CanvasService,
        { provide: PrismaService, useValue: { session: { findFirst, update: prismaUpdate } } },
      ],
    }).compile()
    svc = moduleRef.get(CanvasService)
  })

  it('prev pending_confirm + 客户端整份提交终态 ⇒ 落库串里 status 被守住', async () => {
    findFirst.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      canvasData: canvas([{ id: 'n1', data: { status: 'pending_confirm' } }]),
    })
    prismaUpdate.mockResolvedValue({ id: 's1' })
    await svc.update('s1', 'u1', {
      canvasData: canvas([{ id: 'n1', data: { status: 'completed' } }]),
    })
    const arg = prismaUpdate.mock.calls[0][0]
    const saved = JSON.parse(arg.data.canvasData)
    expect(saved.nodes[0].data.status).toBe('pending_confirm')
  })

  it('title-only 更新（canvasData undefined）不触发守卫直写 title', async () => {
    findFirst.mockResolvedValue({ id: 's1', userId: 'u1', canvasData: canvas([]) })
    prismaUpdate.mockResolvedValue({ id: 's1' })
    await svc.update('s1', 'u1', { title: '新标题' })
    const arg = prismaUpdate.mock.calls[0][0]
    expect(arg.data.title).toBe('新标题')
    expect(arg.data.canvasData).toBeUndefined()
  })

  it('无 pending_confirm 前态 ⇒ canvasData 原样落库', async () => {
    findFirst.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      canvasData: canvas([{ id: 'n1', data: { status: 'draft' } }]),
    })
    prismaUpdate.mockResolvedValue({ id: 's1' })
    const payload = canvas([{ id: 'n1', data: { status: 'completed', url: 'http://x' } }])
    await svc.update('s1', 'u1', { canvasData: payload })
    const arg = prismaUpdate.mock.calls[0][0]
    expect(JSON.parse(arg.data.canvasData).nodes[0].data.url).toBe('http://x')
  })
})
