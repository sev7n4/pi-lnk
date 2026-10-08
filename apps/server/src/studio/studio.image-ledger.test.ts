import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { createImageProvider, mergeRefsToPrompt } from '@lnkpi/agent'
import { BadRequestException } from '@nestjs/common'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'
import { StudioService } from './studio.service'

const imageGenerate = vi.fn()

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    mergeRefsToPrompt: vi.fn(async (input: { localPrompt?: string }) => ({
      mergedText: input.localPrompt ?? '',
      skippedMerge: true,
    })),
    createImageProvider: vi.fn(() => ({ generate: imageGenerate })),
  }
})

vi.mock('../media/upstream-ref-inline', () => ({
  inlineUpstreamReferenceImages: vi.fn(async (urls: string[]) => urls),
}))

const platformResolved = {
  channelId: 'platform',
  modelName: 'seedream-5.0-pro',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'plat-key', baseUrl: 'https://platform.example.com/v1' },
  source: 'platform' as const,
}

describe('generateImage 账本对账（记录先行）', () => {
  let svc: StudioService
  let resolveForGeneration: ReturnType<typeof vi.fn>
  let generationCreate: ReturnType<typeof vi.fn>
  let generationDelete: ReturnType<typeof vi.fn>
  let generationFindFirst: ReturnType<typeof vi.fn>
  let generationUpdateMany: ReturnType<typeof vi.fn>
  let pointsConsume: ReturnType<typeof vi.fn>
  let stored: Record<string, unknown>
  /** 记录 create 与 consume 的真实调用顺序。 */
  let callOrder: string[]

  beforeEach(async () => {
    vi.clearAllMocks()
    callOrder = []
    stored = {}
    imageGenerate.mockResolvedValue({ url: 'https://cdn/done.png' })
    pointsConsume = vi.fn(async () => {
      callOrder.push('consume')
    })
    resolveForGeneration = vi.fn(async () => platformResolved)
    generationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
      callOrder.push('create')
      stored = { id: 'g1', createdAt: new Date(), ...args.data }
      return stored
    })
    generationDelete = vi.fn(async () => {
      stored = {}
      return stored
    })
    generationFindFirst = vi.fn(async () => stored)
    generationUpdateMany = vi.fn(
      async (args: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        if (stored.status !== args.where.status) return { count: 0 }
        stored = { ...stored, ...args.data }
        return { count: 1 }
      },
    )

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        { provide: PointsService, useValue: { consume: pointsConsume, refund: vi.fn() } },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: generationCreate,
              delete: generationDelete,
              update: vi.fn(),
              updateMany: generationUpdateMany,
              findFirst: generationFindFirst,
              findMany: vi.fn(async () => []),
            },
          },
        },
        { provide: ProviderResolverService, useValue: { resolveForGeneration } },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async () => ({ width: 1024, height: 1024 })) },
        },
        { provide: UploadService, useValue: {} },
      ],
    }).compile()
    svc = moduleRef.get(StudioService)
  })

  it('扣费交易携带 generationId，且记录先于扣费创建', async () => {
    await svc.generateImage('u1', '一只猫', undefined, '16:9', [], [], '1K', 1, {
      sessionId: 's1',
      nodeId: 'n1',
    })

    expect(callOrder).toEqual(['create', 'consume'])
    const consumeArgs = pointsConsume.mock.calls[0]
    // consume(userId, cost, reason, meta)
    expect(consumeArgs[1]).toBe(10)
    expect(consumeArgs[2]).toBe('图像生成')
    expect(consumeArgs[3]).toMatchObject({
      kind: 'consume',
      category: 'image',
      generationId: 'g1',
    })
    // 占位记录就是 generating 态，与 completeImage 的结算守卫对齐
    expect(generationCreate.mock.calls[0][0].data.status).toBe('generating')
  })

  it('扣费失败（积分不足）立即删除占位记录并原样抛错，不留孤儿', async () => {
    pointsConsume.mockRejectedValue(new BadRequestException('积分不足'))

    await expect(
      svc.generateImage('u1', '一只猫', undefined, '16:9', [], [], '1K', 1, { sessionId: 's1' }),
    ).rejects.toThrow('积分不足')

    expect(generationDelete).toHaveBeenCalledWith({ where: { id: 'g1' } })
    expect(generationCreate).toHaveBeenCalledTimes(1)
  })

  it('n>1 时成本按 10×n 且 generationId 仍指向同一记录', async () => {
    await svc.generateImage('u1', '一张图', undefined, '1:1', [], [], '1K', 2, { sessionId: 's1' })

    expect(pointsConsume.mock.calls[0][1]).toBe(20)
    expect(pointsConsume.mock.calls[0][3].generationId).toBe('g1')
  })

  it('分辨率分级定价（诊断 B4）：2K=15/张、4K=20/张，1K 维持 10', async () => {
    await svc.generateImage('u1', '一张图', undefined, '1:1', [], [], '2K', 1, { sessionId: 's1' })
    expect(pointsConsume.mock.calls[0][1]).toBe(15)

    await svc.generateImage('u1', '一张图', undefined, '1:1', [], [], '4K', 1, { sessionId: 's1' })
    expect(pointsConsume.mock.calls[1][1]).toBe(20)
  })

  it('无文本引用时 merge 透传（skippedMerge），生成正常完成', async () => {
    const rec = await svc.generateImage('u1', '一只猫', undefined, '16:9', [], [], '1K', 1, {
      sessionId: 's1',
    })

    expect(mergeRefsToPrompt).toHaveBeenCalledTimes(1)
    expect(imageGenerate).toHaveBeenCalledTimes(1)
    // 返回的记录就是那个 generating 占位（结算在 detached completion / 轮询侧收尾）
    expect((rec as { id?: string }).id).toBe('g1')
  })
})
