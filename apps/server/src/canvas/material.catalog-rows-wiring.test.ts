/**
 * B2 S2-1c 接线回归：MaterialService 的 image/video 两个 builder 调用点
 * 必须把 `currentCatalogEntries()`（model-catalog-store 的 DB 目录缓存 rows）
 * 注入 agent 侧 adapter —— 否则后台 admin 新增的模型（只存 DB、不在常量目录）
 * 会被 agent 侧 resolve 静默 fallback 到默认模型并计费。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { createImageProvider, createVideoProvider, mergeRefsToPrompt } from '@lnkpi/agent'
import { STUDIO_MODEL_CATALOG, type StudioModelEntry } from '@lnkpi/shared'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { MaterialService } from './material.service'

const imageGenerate = vi.fn(async () => ({ url: 'https://example.com/i.png' }))
const videoGenerate = vi.fn(async () => ({ url: 'https://example.com/v.mp4' }))

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    mergeRefsToPrompt: vi.fn(async (input: { localPrompt?: string }) => ({
      mergedText: input.localPrompt ?? '',
      skippedMerge: true,
    })),
    createImageProvider: vi.fn(() => ({ generate: imageGenerate })),
    createVideoProvider: vi.fn(() => ({ generate: videoGenerate })),
  }
})

// 模拟「DB 缓存里有、常量目录没有」的 admin 新增条目（其余导出保留真实实现）。
const { currentCatalogEntries } = vi.hoisted(() => ({
  currentCatalogEntries: vi.fn(),
}))

vi.mock('../provider/model-catalog-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider/model-catalog-store')>()
  return {
    ...actual,
    currentCatalogEntries,
  }
})

const dbOnlyRows: StudioModelEntry[] = [
  {
    modelKey: 'db-only-image',
    displayName: 'DB 新增图像模型',
    gatewayModelId: 'db-only-image-gw',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native', size: 'native', n: 'native' },
  },
  {
    modelKey: 'db-only-video',
    displayName: 'DB 新增视频模型',
    gatewayModelId: 'db-only-video-gw',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native', duration: 'native', aspectRatio: 'native', resolution: 'native' },
  },
]

const platformResolve = (model?: string) => ({
  channelId: 'platform',
  modelName: model ?? '',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'plat-key', baseUrl: 'https://platform.example.com/v1' },
  source: 'platform' as const,
})

describe('MaterialService → agent adapter 注入 DB 目录 rows（B2 S2-1c 接线）', () => {
  let svc: MaterialService

  beforeEach(async () => {
    vi.clearAllMocks()
    currentCatalogEntries.mockClear()
    currentCatalogEntries.mockImplementation(() => [...STUDIO_MODEL_CATALOG, ...dbOnlyRows])

    const moduleRef = await Test.createTestingModule({
      providers: [
        MaterialService,
        { provide: PointsService, useValue: { consume: vi.fn(async () => {}) } },
        {
          provide: PrismaService,
          useValue: {
            shot: {
              findUnique: vi.fn(async () => ({
                id: 'shot-1',
                sessionId: 'sess-1',
                session: { id: 'sess-1', userId: 'u1' },
              })),
            },
            material: {
              create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
                id: 'm1',
                ...args.data,
              })),
              update: vi.fn(async () => ({})),
              updateMany: vi.fn(async () => ({ count: 1 })),
              findFirst: vi.fn(async () => null),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            resolveForGeneration: vi.fn(async (_uid: string, model?: string) =>
              platformResolve(model),
            ),
          },
        },
        {
          provide: MediaProbeService,
          useValue: {
            probeUrl: vi.fn(async (url: string) => ({
              url,
              width: 1024,
              height: 768,
              bytes: 500_000,
              mimeType: 'image/png',
              probeStatus: 'ok' as const,
            })),
          },
        },
      ],
    }).compile()
    svc = moduleRef.get(MaterialService)
  })

  it('image：DB-only 模型解析命中 DB 条目（不再 fallback 到默认图像模型）', async () => {
    await svc.generateImage({
      userId: 'u1',
      shotId: 'shot-1',
      prompt: 'a cat',
      model: 'db-only-image',
      aspectRatio: '16:9',
      resolution: '1K',
      count: 1,
    })
    await vi.waitFor(() => expect(imageGenerate).toHaveBeenCalled())

    expect(currentCatalogEntries).toHaveBeenCalled()
    const opts = imageGenerate.mock.calls[0][1] as { modelId?: string }
    expect(opts.modelId).toBe('db-only-image-gw')
    expect(opts.modelId).not.toBe('doubao-seedream-5-0-pro')
  })

  it('video：DB-only 模型解析命中 DB 条目', async () => {
    await svc.generateVideo({
      userId: 'u1',
      shotId: 'shot-1',
      prompt: 'walk',
      model: 'db-only-video',
      duration: 5,
    })
    await vi.waitFor(() => expect(videoGenerate).toHaveBeenCalled())

    expect(currentCatalogEntries).toHaveBeenCalled()
    const opts = videoGenerate.mock.calls[0][1] as { model?: string }
    expect(opts.model).toBe('db-only-video-gw')
    expect(opts.model).not.toBe('agnes-video-v2.0')
  })
})
