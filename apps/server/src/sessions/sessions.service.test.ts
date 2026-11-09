import 'reflect-metadata'
import { NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { SessionsService } from './sessions.service'
import { canvasPatchMetrics } from './canvas-patch-metrics'

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

// ── update：PUT canvasData 写入关闭（P1-C C2②，2026-11-03 提前于 ~11-16 执行）──
// 前史：2026-10-13 虚假确认事故（stale 全量盖写 → runtime 误读）催生 C0 字段级守卫；
// C1a PATCH 主通道上线后 PUT 进入弃用期；现网无真实用户 ⇒ 自愈窗前提失效，
// C2② 提前关闭：PUT 带 canvasData ⇒ 整包忽略（不落库），title 照常，打点留痕。
// 画布唯一合法落库通道 = PATCH /sessions/:id/canvas（op 语义 + 事务 + staged 守卫）；
// pending_confirm 等服务端字段的客户端防线由 PATCH 白名单（sanitizeClientOps）承接。
describe('SessionsService.update —— PUT canvasData 写入关闭（C2②）', () => {
  const prev = JSON.stringify({
    nodes: [
      { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'pending_confirm' } },
    ],
    edges: [],
  })

  function makeUpdateService(serverCanvas: string) {
    const findUnique = vi.fn(async () => ({
      id: 's1',
      userId: 'u1',
      title: 't',
      canvasData: serverCanvas,
      createdAt: new Date('2026-10-13T00:00:00Z'),
      updatedAt: new Date('2026-10-13T00:00:00Z'),
    }))
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 's1',
      userId: 'u1',
      title: (data.title as string) ?? 't',
      canvasData: (data.canvasData as string | undefined) ?? serverCanvas,
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

  it('旧客户端越权 payload（pending_confirm → completed）⇒ 整包忽略，落库载荷不含 canvasData', async () => {
    const { update, moduleRef } = makeUpdateService(prev)
    const svc = (await moduleRef.compile()).get(SessionsService)
    const out = await svc.update('s1', 'u1', {
      title: '改名',
      canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', content: 'x' } }], edges: [] },
    })
    // 落库载荷只含 title（canvasData undefined ⇒ 服务端画布不被 stale 整份覆盖）
    expect(update.mock.calls[0]![0].data).toEqual({ title: '改名' })
    expect(update.mock.calls[0]![0].data.canvasData).toBeUndefined()
    // 返回体带服务端现值（旧客户端下次 GET 对账即回到真值）
    const returned = out.canvasData as { nodes: Array<{ data: { status: string } }> }
    expect(returned.nodes[0].data.status).toBe('pending_confirm')
  })

  it('带 canvasData ⇒ 打 canvas_put_rejected 留痕；title-only ⇒ 不打', async () => {
    const { update, moduleRef } = makeUpdateService(prev)
    const svc = (await moduleRef.compile()).get(SessionsService)
    const loggerWarn = vi.spyOn(
      (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    )
    await svc.update('s1', 'u1', {
      canvasData: { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [] },
    })
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(String(loggerWarn.mock.calls[0][0])).toMatch(/^canvas_put_rejected sessionId=s1 nodes=2$/)
    await svc.update('s1', 'u1', { title: '只改名' })
    expect(loggerWarn).toHaveBeenCalledTimes(1) // 不新增
    expect(update.mock.calls[1]![0].data).toEqual({ title: '只改名' })
  })

  it('PUT 404/403 语义不变（会话不存在 / 他人会话）', async () => {
    const findUnique = vi.fn(async () => null)
    const update = vi.fn()
    const svc = (
      await Test.createTestingModule({
        providers: [SessionsService, { provide: PrismaService, useValue: { session: { findUnique, update } } }],
      }).compile()
    ).get(SessionsService)
    await expect(svc.update('ghost', 'u1', { title: 'x' })).rejects.toBeInstanceOf(NotFoundException)
    expect(update).not.toHaveBeenCalled()
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

// ── patchCanvas 埋点观测（SP-E 阶段 1 / Task 4）───────────────────────────────
// 复用本仓库既有的 PATCH 夹具形态（Test.createTestingModule + vi.fn：
// prisma.$transaction 直接执行回调，tx.findUnique 返回 canvasData + stagedActions），
// 与 sessions-patch.service.test.ts 同款；不新造 harness 机制。
describe('SessionsService.patchCanvas —— 埋点观测（Task 4）', () => {
  // update_node 目标 n1 必须存在于画布，否则 applier 的 node_not_found 会多计一次 skip。
  const canvasWithN1 = JSON.stringify({
    nodes: [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  })
  let service: SessionsService
  let txFindUnique: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    canvasPatchMetrics.reset()
    const findUnique = vi.fn(async () => ({
      id: 's1',
      userId: 'u1',
      title: 't',
      canvasData: canvasWithN1,
      createdAt: new Date('2026-09-29T00:00:00Z'),
      updatedAt: new Date('2026-09-29T00:00:00Z'),
    }))
    txFindUnique = vi.fn(async () => ({ canvasData: canvasWithN1, stagedActions: null }))
    const txUpdate = vi.fn(async () => ({ id: 's1' }))
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
    service = moduleRef.get(SessionsService)
  })

  it('成功 PATCH ⇒ 记录样本，skipped 精确', async () => {
    const res = await service.patchCanvas(
      's1',
      'u1',
      [
        { type: 'update_node', payload: { id: 'n1', position: { x: 1, y: 2 } } },
        { type: 'add_edge', payload: { id: 'e1', source: 'a', target: 'b' } },
        { type: 'add_edge', payload: { id: 'e1', source: 'a', target: 'b' } },
      ],
      'c1',
    )
    expect(res).toEqual({ applied: 3 })
    expect(canvasPatchMetrics.snapshot()).toMatchObject({
      patches: 1,
      ops: 3,
      applied: 3,
      skipped: 1,
      skippedByType: { add_edge: 1 },
      distinctClients: 1,
    })
  })

  it('R3：stagedActions 409 ⇒ 不记样本', async () => {
    txFindUnique.mockResolvedValue({
      canvasData: canvasWithN1,
      stagedActions: JSON.stringify([{ type: 'update_node', payload: {} }]),
    })
    await expect(
      service.patchCanvas('s1', 'u1', [{ type: 'set_viewport', payload: { viewport: {} } }], 'c1'),
    ).rejects.toThrow(/staged actions pending commit/)
    expect(canvasPatchMetrics.snapshot().patches).toBe(0)
  })

  it('R2：埋点抛错 ⇒ PATCH 仍成功', async () => {
    const spy = vi.spyOn(canvasPatchMetrics, 'record').mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await service.patchCanvas(
      's1',
      'u1',
      [{ type: 'set_viewport', payload: { viewport: {} } }],
      'c1',
    )
    expect(res).toEqual({ applied: 1 })
    spy.mockRestore()
  })
})
