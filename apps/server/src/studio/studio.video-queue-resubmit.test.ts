import 'reflect-metadata'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { createVideoProvider, mergeRefsToPrompt } from '@lnkpi/agent'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'
import { StudioService } from './studio.service'
import { createPricingMock } from '../pricing/pricing.test-utils'
import { PricingService } from '../pricing/pricing.service'

/**
 * 队列满延迟重提刀（spec：docs/superpowers/specs/2026-11-28-video-queue-full-delayed-resubmit-design.md）
 *
 * 生产背景：agnes 免费池 503 `video_queue_full` 是分钟级间歇容量信号，
 * 秒级内层退避救不了 ⇒ completeVideo 失败路径按分钟级重提。错误原文取自
 * 2026-11-28 生产取证（未造样本）。
 */

const QUEUE_FULL_MSG =
  'Agnes video create 503: {"code":"video_queue_full","message":"video queue is full, please retry later (request id: 20261102174520474936102GP5DQImi)","data":null}'

const videoGenerate = vi.fn()

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    mergeRefsToPrompt: vi.fn(async (input: { localPrompt?: string }) => ({
      mergedText: input.localPrompt ?? '',
      skippedMerge: true,
    })),
    createVideoProvider: vi.fn(() => ({ generate: videoGenerate })),
  }
})

const agnesPlatformResolved = {
  channelId: 'platform',
  modelName: 'agnes-video-2.5-flash',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'plat-key', baseUrl: 'https://apihub.agnes-ai.com/v1' },
  source: 'platform' as const,
}

const nonAgnesPlatformResolved = {
  channelId: 'platform',
  modelName: 'doubao-seedance-2.0-mini',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'plat-key', baseUrl: 'https://api.apimart.ai/v1' },
  source: 'platform' as const,
}

const userResolved = {
  channelId: 'ch_user',
  modelName: 'agnes-video-2.5-flash',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'user-key', baseUrl: 'https://apihub.agnes-ai.com/v1' },
  source: 'user' as const,
}

describe('StudioService 视频队列满延迟重提', () => {
  let svc: StudioService
  let resolveForGeneration: ReturnType<typeof vi.fn>
  let pointsRefund: ReturnType<typeof vi.fn>
  let generationUpdate: ReturnType<typeof vi.fn>
  let generationUpdateMany: ReturnType<typeof vi.fn>
  let stored: Record<string, unknown>
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    vi.clearAllMocks()
    // ⚠️ clearAllMocks 不清 once 队列（mockRejectedValueOnce 会跨用例泄漏，
    // BYOK 用例会吃到前序用例的「两次失败+一次成功」序列）⇒ 显式 reset。
    // 不用 vi.resetAllMocks：会把 vi.mock 工厂里 createVideoProvider 的实现也抹掉。
    videoGenerate.mockReset()
    stored = {}
    for (const key of ['LNKPI_VIDEO_QUEUE_RETRY_INTERVAL_MS']) {
      savedEnv[key] = process.env[key]
      process.env[key] = '1'
    }
    pointsRefund = vi.fn(async () => {})
    resolveForGeneration = vi.fn(async () => agnesPlatformResolved)
    const generationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
      stored = { id: 'g1', createdAt: new Date(), ...args.data }
      return stored
    })
    generationUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      stored = { ...stored, ...args.data, id: args.where.id }
      return stored
    })
    generationUpdateMany = vi.fn(async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      if (args.where.status && stored.status !== args.where.status) return { count: 0 }
      stored = { ...stored, ...args.data }
      return { count: 1 }
    })

    vi.mocked(mergeRefsToPrompt).mockImplementation(async (input) => ({
      mergedText: input.localPrompt ?? '',
      skippedMerge: true,
    }))

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        { provide: PricingService, useValue: createPricingMock() },
        {
          provide: PointsService,
          useValue: { consume: vi.fn(async () => {}), refund: pointsRefund },
        },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: generationCreate,
              update: generationUpdate,
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => stored),
              findMany: vi.fn(async () => []),
              delete: vi.fn(async () => ({})),
            },
          },
        },
        { provide: ProviderResolverService, useValue: { resolveForGeneration } },
        {
          provide: MediaProbeService,
          useValue: {
            probeUrl: vi.fn(async (url: string) => ({
              url,
              width: 1280,
              height: 720,
              bytes: 1_000_000,
              mimeType: 'video/mp4',
              probeStatus: 'ok' as const,
            })),
          },
        },
        {
          provide: UploadService,
          useValue: { saveUserFile: vi.fn(async () => ({ url: 'https://cdn/comp.png' })) },
        },
      ],
    }).compile()

    svc = moduleRef.get(StudioService)
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('重提后成功：记录 completed、provider 重调、metadata 记录重提次数、不退款', async () => {
    process.env.LNKPI_VIDEO_QUEUE_RETRY_INTERVAL_MS = '1'
    videoGenerate
      .mockRejectedValueOnce(new Error(QUEUE_FULL_MSG))
      .mockRejectedValueOnce(new Error(QUEUE_FULL_MSG))
      .mockResolvedValueOnce({ url: 'https://example.com/v.mp4' })

    await svc.generateVideo('u1', 'walk', 'agnes-video-2.5-flash')

    await vi.waitFor(() => expect(stored.status).toBe('completed'), { timeout: 5000 })
    expect(videoGenerate).toHaveBeenCalledTimes(3)
    expect(pointsRefund).not.toHaveBeenCalled()
    // 重提元数据走 generationRecord.update（记录保持 generating）；queuedRetryAttempt
    // 在 data.metadata 的 JSON 字符串内，需解析后过滤。
    const retryWrites = generationUpdate.mock.calls.filter((c) => {
      const raw = c[0].data?.metadata
      if (typeof raw !== 'string') return false
      try {
        return JSON.parse(raw).queuedRetryAttempt != null
      } catch {
        return false
      }
    })
    expect(retryWrites.length).toBe(2)
    const finalMeta = JSON.parse(String(stored.metadata))
    expect(finalMeta.queuedRetryAttempt).toBe(2)
    expect(finalMeta.status).toBeUndefined() // status 只在记录列，不在 metadata
    expect(stored.url).toBe('https://example.com/v.mp4')
  })

  it('窗口耗尽：failed + rate_limited + queueRetryExhausted，退款一次', async () => {
    process.env.LNKPI_VIDEO_QUEUE_RETRY_MAX_ATTEMPTS = '2'
    videoGenerate.mockRejectedValue(new Error(QUEUE_FULL_MSG))

    await svc.generateVideo('u1', 'walk', 'agnes-video-2.5-flash')

    await vi.waitFor(() => expect(stored.status).toBe('failed'), { timeout: 5000 })
    expect(videoGenerate).toHaveBeenCalledTimes(3) // 首次 + 2 次重提
    expect(pointsRefund).toHaveBeenCalledTimes(1)
    const meta = JSON.parse(String(stored.metadata))
    expect(meta.errorCode).toBe('rate_limited')
    expect(meta.queueRetryExhausted).toBe(true)
    expect(meta.queueRetryAttempt).toBe(2)
    expect(meta.refundedPoints).toBeGreaterThan(0)
  })

  it('BYOK 渠道不重提：直接 fallback_pending（现行为保持）', async () => {
    resolveForGeneration.mockImplementation(async () => userResolved)
    videoGenerate.mockRejectedValue(new Error(QUEUE_FULL_MSG))

    const record = await svc.generateVideo('u1', 'walk', 'ch_user::agnes-video-2.5-flash')

    await vi.waitFor(() => expect(stored.status).toBe('fallback_pending'), { timeout: 5000 })
    expect(videoGenerate).toHaveBeenCalledTimes(1)
    expect(record.status).toBe('generating') // generateVideo 立即返回占位
  })

  it('非 agnes 网关不重提：queue_full 直接走既有失败路径', async () => {
    resolveForGeneration.mockImplementation(async () => nonAgnesPlatformResolved)
    videoGenerate.mockRejectedValue(new Error(QUEUE_FULL_MSG))

    await svc.generateVideo('u1', 'walk', 'doubao-seedance-2.0-mini')

    await vi.waitFor(() => expect(stored.status).toBe('failed'), { timeout: 5000 })
    expect(videoGenerate).toHaveBeenCalledTimes(1)
    expect(pointsRefund).toHaveBeenCalledTimes(1)
    const meta = JSON.parse(String(stored.metadata))
    expect(meta.errorCode).toBe('rate_limited')
    expect(meta.queueRetryExhausted).toBeUndefined()
  })

  it('非 queue_full 形态（普通 503）不重提', async () => {
    videoGenerate.mockRejectedValue(new Error('Agnes video create 503: internal error'))

    await svc.generateVideo('u1', 'walk', 'agnes-video-2.5-flash')

    await vi.waitFor(() => expect(stored.status).toBe('failed'), { timeout: 5000 })
    expect(videoGenerate).toHaveBeenCalledTimes(1)
    const meta = JSON.parse(String(stored.metadata))
    expect(meta.errorCode).toBe('unknown')
  })
})
