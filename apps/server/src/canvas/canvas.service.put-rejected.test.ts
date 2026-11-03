import { NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { CanvasService } from './canvas.service'

/**
 * P1-C C2②（规格 §4.2）：`PUT /agent/canvas/update` 的 canvasData 写入已关闭。
 * 行为级判据：带 canvasData ⇒ 打 canvas_put_rejected + 落库载荷不含 canvasData
 * （title 照常）；title-only ⇒ 不打点。返回 200（旧客户端假成功，下次 GET 对账）。
 */
describe('CanvasService.update → PUT canvasData 写入关闭（C2②）', () => {
  it('带 canvasData ⇒ 打点 canvas_put_rejected 且不落库；title-only ⇒ 不打', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 's1',
      userId: 'u1',
      canvasData: JSON.stringify({ nodes: [{ id: 'keep', data: {} }], edges: [] }),
    })
    const update = vi.fn().mockImplementation(async ({ data }: { data: { title?: string } }) => ({
      id: 's1',
      userId: 'u1',
      title: data.title ?? 't',
      canvasData: JSON.stringify({ nodes: [{ id: 'keep', data: {} }], edges: [] }),
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    const moduleRef = await Test.createTestingModule({
      providers: [
        CanvasService,
        { provide: PrismaService, useValue: { session: { findFirst, update } } },
      ],
    }).compile()
    const svc = moduleRef.get(CanvasService)
    const loggerWarn = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')

    const oldCanvas = JSON.stringify({
      nodes: [
        { id: 'keep', data: { status: 'pending_confirm' } },
        { id: 'rogue', data: { status: 'completed' } },
      ],
      edges: [],
    })
    // 旧客户端整份 PUT（含把 pending_confirm 改 completed 的越权 payload）⇒ 整包忽略
    const r1 = await svc.update('s1', 'u1', { title: '改名', canvasData: oldCanvas })
    expect(r1.title).toBe('改名')
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(String(loggerWarn.mock.calls[0][0])).toMatch(/^canvas_put_rejected sessionId=s1 nodes=2$/)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0].data).toEqual({ title: '改名' })
    expect(update.mock.calls[0]![0].data.canvasData).toBeUndefined()

    // 坏 JSON 同样拒绝（nodes=-1 留痕）
    await svc.update('s1', 'u1', { canvasData: '{not-json' })
    expect(String(loggerWarn.mock.calls[1][0])).toMatch(/^canvas_put_rejected sessionId=s1 nodes=-1$/)

    // title-only ⇒ 不打点
    await svc.update('s1', 'u1', { title: '只改名' })
    expect(loggerWarn).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[2]![0].data).toEqual({ title: '只改名' })

    // 404 仍在
    findFirst.mockResolvedValueOnce(null)
    await expect(svc.update('x', 'u1', { title: 't' })).rejects.toBeInstanceOf(NotFoundException)
  })
})
