import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { createImageProvider } from '@lnkpi/agent'
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

const byokResolved = {
  channelId: 'ch-1',
  modelName: 'agnes-image-2.0-flash',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'user-key', baseUrl: 'https://apihub.example.com/v1' },
  source: 'user' as const,
}

/**
 * 图片侧三条「仍无 generationId」的 consume 路径收尾（诊断 B2）：
 * generateImageVariation / editImage / material.service。
 * 这里覆盖变体（generateImageVariation），精修与素材各自在同名测试文件里覆盖。
 */
describe('generateImageVariation 账本对账（记录先行）', () => {
  let svc: StudioService
  let resolveForGeneration: ReturnType<typeof vi.fn>
  let generationCreate: ReturnType<typeof vi.fn>
  let generationUpdate: ReturnType<typeof vi.fn>
  let generationDelete: ReturnType<typeof vi.fn>
  let pointsConsume: ReturnType<typeof vi.fn>
  let pointsRefund: ReturnType<typeof vi.fn>
  let stored: Record<string, unknown>
  let callOrder: string[]

  const findFirst = vi.fn(async () => stored)

  beforeEach(async () => {
    vi.clearAllMocks()
    callOrder = []
    stored = {}
    imageGenerate.mockResolvedValue({ url: 'https://cdn/variation.png' })
    pointsConsume = vi.fn(async () => {
      callOrder.push('consume')
    })
    pointsRefund = vi.fn(async () => {
      callOrder.push('refund')
    })
    resolveForGeneration = vi.fn(async () => platformResolved)
    generationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
      callOrder.push('create')
      stored = { id: 'g1', createdAt: new Date(), ...args.data }
      return stored
    })
    generationUpdate = vi.fn(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        stored = { ...stored, ...args.data, id: args.where.id }
        return stored
      },
    )
    generationDelete = vi.fn(async () => {
      stored = {}
      return stored
    })
    findFirst.mockImplementation(async () => stored)

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        { provide: PointsService, useValue: { consume: pointsConsume, refund: pointsRefund } },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: generationCreate,
              update: generationUpdate,
              delete: generationDelete,
              findFirst,
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

  it('扣费交易携带 generationId，且占位记录先于扣费创建', async () => {
    await svc.generateImageVariation('u1', '换成夜景', '原图', undefined, undefined, {
      sessionId: 's1',
      nodeId: 'n1',
    })

    expect(callOrder).toEqual(['create', 'consume'])
    const consumeArgs = pointsConsume.mock.calls[0]
    expect(consumeArgs[1]).toBe(10)
    expect(consumeArgs[2]).toBe('图像变体')
    expect(consumeArgs[3]).toMatchObject({
      kind: 'consume',
      category: 'image',
      generationId: 'g1',
    })
    expect((generationCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data.status).toBe(
      'generating',
    )
  })

  it('成功后结算同一条记录（update 而非再 create 一条），不再留 generating 占位', async () => {
    const rec = await svc.generateImageVariation('u1', '换成夜景')

    expect(generationCreate).toHaveBeenCalledTimes(1)
    expect(generationUpdate).toHaveBeenCalledTimes(1)
    expect(stored.status).toBe('completed')
    expect(stored.url).toBe('https://cdn/variation.png')
    expect((rec as { id?: string }).id).toBe('g1')
  })

  it('扣费失败（积分不足）立即删除占位记录并原样抛错，不留孤儿', async () => {
    pointsConsume.mockRejectedValue(new BadRequestException('积分不足'))

    await expect(svc.generateImageVariation('u1', '换成夜景')).rejects.toThrow('积分不足')

    expect(generationDelete).toHaveBeenCalledWith({ where: { id: 'g1' } })
    expect(imageGenerate).not.toHaveBeenCalled()
  })

  it('渠道解析失败时不扣费、不建记录，也不产生退款交易', async () => {
    resolveForGeneration.mockRejectedValueOnce(new Error('channel not found'))

    await expect(svc.generateImageVariation('u1', '换成夜景')).rejects.toThrow('channel not found')

    expect(pointsConsume).not.toHaveBeenCalled()
    expect(pointsRefund).not.toHaveBeenCalled()
    expect(generationCreate).not.toHaveBeenCalled()
  })

  it('平台源失败：退款带 generationId，占位记录置 failed（不再新造一条失败记录）', async () => {
    imageGenerate.mockRejectedValueOnce(new Error('upstream 502'))

    await expect(svc.generateImageVariation('u1', '换成夜景')).rejects.toThrow()

    expect(generationCreate).toHaveBeenCalledTimes(1)
    expect(pointsRefund).toHaveBeenCalledTimes(1)
    expect(pointsRefund.mock.calls[0]![3]).toMatchObject({
      category: 'image',
      status: 'failed_refund',
      generationId: 'g1',
    })
    expect(stored.status).toBe('failed')
  })

  it('BYOK 源失败：退款带 generationId，占位记录转 fallback_pending', async () => {
    resolveForGeneration.mockResolvedValueOnce(byokResolved)
    imageGenerate.mockRejectedValueOnce(new Error('bad gateway'))

    const rec = await svc.generateImageVariation('u1', '换成夜景')

    expect(pointsRefund).toHaveBeenCalledTimes(1)
    expect(pointsRefund.mock.calls[0]![3]).toMatchObject({
      category: 'image',
      status: 'byok_refund',
      generationId: 'g1',
    })
    expect((rec as { status?: string }).status).toBe('fallback_pending')
  })

  it('取消：只退一次（已退款则不重复退），占位记录置 failed 而非留 generating', async () => {
    await expect(
      svc.generateImageVariation('u1', '换成夜景', undefined, undefined, {
        isCancelled: () => true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)

    expect(pointsRefund).toHaveBeenCalledTimes(1)
    expect(pointsRefund.mock.calls[0]![3]).toMatchObject({
      status: 'cancelled_refund',
      generationId: 'g1',
    })
    expect(stored.status).toBe('failed')
    expect(JSON.parse(String(stored.metadata)).cancelled).toBe(true)
  })
})
