import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { SessionsService } from './sessions.service'

function makeService() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 's1',
    title: (data.title as string) ?? '未命名项目',
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
    const out = await svc.create('u1', '未命名项目')
    expect(create).toHaveBeenCalledOnce()
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.canvasData).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('prompt-1')
    expect(JSON.stringify(data)).not.toContain('描述你的创意场景')
    expect(out.title).toBe('未命名项目')
  })

  it('不传 title 时默认落库「未命名项目」（IA v4 项目语义；list 兜底据此编号）', async () => {
    const { create, moduleRef } = makeService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    const out = await svc.create('u1')
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.title).toBe('未命名项目')
    expect(out.title).toBe('未命名项目')
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
// {pending_confirm, generating}（2026-10-30 P0-4 收紧：draft 出口随「前端自起生成」一并退役）；违规**字段级**保留服务端值，其余字段照常落库，不 409。
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

  it('P0-4 收紧：客户端把 pending_confirm 写回 draft → 字段级丢弃，status 保留 pending_confirm（取消走 decline 内部通道，不经浏览器 PUT）', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', {
      canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'draft' } }], edges: [] },
    })
    expect(JSON.parse(update.mock.calls[0][0].data.canvasData as string).nodes[0].data.status).toBe('pending_confirm')
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

// ── findAll：列表瘦身（2026-10-25 取证）───────────────────────────────────────
// 旧实现 `findMany` 不带 select ⇒ 165 个项目的整份画布 JSON 一起下发，实测 **589KB**。
// 后果不只是慢：几百 KB 的传输中途若链路静默死亡（代理 / NAT 残留），TCP 连接既不完成
// 也不报错，Chrome 对单 host 的 6 条 HTTP/1.1 连接被这类僵尸占满 ⇒ 后续一切请求排队饿死
// （项目抽屉「项目加载中」转不完）。瘦身口径与 `CanvasService.list` 一致：服务端解析出
// 封面 URL，响应体只回卡片字段。
describe('SessionsService.findAll —— 列表不带 canvasData，只回卡片字段 + 封面 URL', () => {
  const ROW = {
    id: 's1',
    title: '大闸蟹礼盒',
    userId: 'u1',
    canvasData: JSON.stringify({
      nodes: [
        {
          id: 'n1',
          type: 'image',
          data: { status: 'completed', url: 'https://cdn/a.png', generationStartedAt: '2026-10-22T10:00:00Z' },
        },
      ],
      edges: [],
    }),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-22T10:00:00Z'),
  }

  async function findAllWith(rows: Array<Record<string, unknown>>) {
    const findMany = vi.fn(async () => rows)
    const svc = (
      await Test.createTestingModule({
        providers: [SessionsService, { provide: PrismaService, useValue: { session: { findMany } } }],
      }).compile()
    ).get(SessionsService)
    return { svc, findMany, out: await svc.findAll('u1') }
  }

  it('响应体不含 canvasData（整份画布 JSON 不出服务端）', async () => {
    const { out } = await findAllWith([ROW])
    expect(out[0]).not.toHaveProperty('canvasData')
    expect(Object.keys(out[0]!).sort()).toEqual(['coverUrl', 'createdAt', 'id', 'title', 'updatedAt', 'userId'])
  })

  it('封面由服务端算好，只回一个 URL（与 CanvasService.list 同口径）', async () => {
    const { out } = await findAllWith([ROW])
    expect(out[0]!.coverUrl).toBe('https://cdn/a.png')
  })

  it('体积守卫：165 个项目（每条 canvasData 3.5KB）响应体仍远小于旧版 589KB', async () => {
    const rows = Array.from({ length: 165 }, (_, i) => ({
      ...ROW,
      id: `s${i}`,
      canvasData: JSON.stringify({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            data: { status: 'completed', url: `https://cdn/${i}.png`, generationStartedAt: '2026-10-22T10:00:00Z' },
          },
        ],
        edges: [],
        pad: 'x'.repeat(3500),
      }),
    }))
    const { out } = await findAllWith(rows)
    const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8')
    // 旧实现 ≈ 589KB；瘦身上限取 60KB（165 条 × (id+title+时间戳+URL) ≈ 25KB，留一倍余量）
    expect(bytes, `列表响应体 ${bytes} B，应远小于旧版 589KB`).toBeLessThan(60_000)
  })

  it('findMany 仍 select canvasData —— 只为在服务端解析封面，这个字段不下发', async () => {
    const { findMany } = await findAllWith([ROW])
    const arg = findMany.mock.calls[0]![0] as { select: Record<string, unknown> }
    expect(arg.select.canvasData).toBe(true)
    expect(arg.select.id).toBe(true)
  })

  it('脏 canvasData（非法 JSON）不抛错，封面降级为 null', async () => {
    const { out } = await findAllWith([{ ...ROW, canvasData: '{not-json' }])
    expect(out[0]!.coverUrl).toBeNull()
    expect(out[0]).not.toHaveProperty('canvasData')
  })

  it('无产物节点（canvasData 为 null）⇒ 封面 null，列表照常返回', async () => {
    const { out } = await findAllWith([{ ...ROW, canvasData: null }])
    expect(out[0]!.coverUrl).toBeNull()
    expect(out[0]!.title).toBe('大闸蟹礼盒')
  })
})
