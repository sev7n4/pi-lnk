import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { SessionsService } from './sessions.service'

function makeService() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 's1',
    title: (data.title as string) ?? '未命名画布',
    userId: data.userId as string,
    canvasData: (data.canvasData as string | null) ?? null,
    createdAt: new Date('2026-09-29T00:00:00Z'),
    updatedAt: new Date('2026-09-29T00:00:00Z'),
  }))
  return {
    create,
    moduleRef: Test.createTestingModule({
      providers: [SessionsService, { provide: PrismaService, useValue: { session: { create } } }],
    }),
  }
}

describe('SessionsService.create —— 新建画布不种提示词节点（spec 场景 A/B）', () => {
  it('canvasData 恒为 null（不再种 prompt-1）', async () => {
    const { create, moduleRef } = makeService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    const out = await svc.create('u1', '未命名画布')
    expect(create).toHaveBeenCalledOnce()
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.canvasData).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('prompt-1')
    expect(JSON.stringify(data)).not.toContain('描述你的创意场景')
    expect(out.title).toBe('未命名画布')
  })

  it('即使调用方仍传第三参（旧签名 prompt），也不再种节点', async () => {
    const { create, moduleRef } = makeService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    // 旧调用方传 prompt 的兼容性：字段被忽略，不再影响 canvasData
    await (svc.create as unknown as (u: string, t: string, p: string) => Promise<unknown>)(
      'u1',
      '一个赛博朋克茶馆',
      '一个赛博朋克茶馆',
    )
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.canvasData).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('prompt-1')
  })
})

// ── update：pending_confirm 状态转移守卫（2026-10-13 虚假确认事故 cmv51vwpu0008p801hxaxcf8m）──
// 浏览器整份 PUT 无权把服务端 pending_confirm 翻成旧终态（completed/error/failed）：
// 那是 10-12 事故的直接成因（stale 全量盖写 → runtime 轮询误读为已确认）。合法出口只有
// {pending_confirm, draft, generating}；违规**字段级**保留服务端值，其余字段照常落库，不 409。
describe('SessionsService.update —— pending_confirm 状态转移守卫', () => {
  const prev = JSON.stringify({
    nodes: [
      { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'pending_confirm' } },
      { id: 'n2', type: 'image', position: { x: 1, y: 1 }, data: { status: 'completed' } },
    ],
    edges: [],
  })

  function makeUpdateService() {
    const findUnique = vi.fn(async () => ({
      id: 's1',
      userId: 'u1',
      title: 't',
      canvasData: prev,
      createdAt: new Date('2026-10-13T00:00:00Z'),
      updatedAt: new Date('2026-10-13T00:00:00Z'),
    }))
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 's1',
      userId: 'u1',
      title: 't',
      canvasData: (data.canvasData as string) ?? null,
      createdAt: new Date('2026-10-13T00:00:00Z'),
      updatedAt: new Date('2026-10-13T00:00:00Z'),
    }))
    return {
      update,
      moduleRef: Test.createTestingModule({
        providers: [SessionsService, { provide: PrismaService, useValue: { session: { findUnique, update } } }],
      }),
    }
  }

  it('客户端把 pending_confirm 翻成 completed → 字段级丢弃，status 保留 pending_confirm，其余字段照落', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', {
      canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', content: '皮克斯文本' } }], edges: [] },
    })
    const written = JSON.parse(update.mock.calls[0][0].data.canvasData as string)
    expect(written.nodes[0].data.status).toBe('pending_confirm')
    expect(written.nodes[0].data.content).toBe('皮克斯文本')
  })

  it('error/failed 同族终态同样被丢弃（同一家族，spec P0-B）', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', {
      canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'error' } }], edges: [] },
    })
    expect(JSON.parse(update.mock.calls[0][0].data.canvasData as string).nodes[0].data.status).toBe('pending_confirm')
  })

  it('合法出口放行：generating（确认启动 patch 序列）原样落库', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', {
      canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'generating', generationRecordId: 'rec-1' } }], edges: [] },
    })
    const written = JSON.parse(update.mock.calls[0][0].data.canvasData as string)
    expect(written.nodes[0].data.status).toBe('generating')
    expect(written.nodes[0].data.generationRecordId).toBe('rec-1')
  })

  it('draft 放行（clear-propose 落 draft）', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', {
      canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'draft' } }], edges: [] },
    })
    expect(JSON.parse(update.mock.calls[0][0].data.canvasData as string).nodes[0].data.status).toBe('draft')
  })

  it('非 pending_confirm 节点不受守卫影响（n2 completed → draft 自由）', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', {
      canvasData: { nodes: [{ id: 'n2', type: 'image', position: { x: 1, y: 1 }, data: { status: 'draft' } }], edges: [] },
    })
    expect(JSON.parse(update.mock.calls[0][0].data.canvasData as string).nodes[0].data.status).toBe('draft')
  })

  it('旧 canvasData 是脏数据（解析失败）→ 守卫直通，保存不被阻塞', async () => {
    const findUnique = vi.fn(async () => ({
      id: 's1', userId: 'u1', title: 't', canvasData: '{not-json', createdAt: new Date(), updatedAt: new Date(),
    }))
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 's1', userId: 'u1', title: 't', canvasData: (data.canvasData as string) ?? null, createdAt: new Date(), updatedAt: new Date(),
    }))
    const svc = (await Test.createTestingModule({
      providers: [SessionsService, { provide: PrismaService, useValue: { session: { findUnique, update } } }],
    }).compile()).get(SessionsService)
    await expect(
      svc.update('s1', 'u1', { canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed' } }], edges: [] } }),
    ).resolves.toBeTruthy()
    expect(JSON.parse(update.mock.calls[0][0].data.canvasData as string).nodes[0].data.status).toBe('completed')
  })
})
