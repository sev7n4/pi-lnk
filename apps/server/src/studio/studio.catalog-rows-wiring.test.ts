/**
 * B2 S2-1c 接线回归：StudioService 的 image/video/audio 三个 builder 调用点
 * 必须把 `currentCatalogEntries()`（model-catalog-store 的 DB 目录缓存 rows）
 * 注入 agent 侧 adapter —— 否则后台 admin 新增的模型（只存 DB、不在常量目录）
 * 会被 agent 侧 resolve 静默 fallback 到默认模型并计费。
 *
 * 防的是「锁了透传没锁效果」：不只是单测 builder 收到 catalogRows，
 * 还要证明 server 调用点真实取了缓存 rows 且 resolve 命中 DB 条目
 * （provider 收到 DB 条目的 gatewayModelId、记录写入 DB 条目的 modelKey）。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import {
  createAudioProvider,
  createImageProvider,
  createVideoProvider,
  mergeRefsToPrompt,
} from '@lnkpi/agent'
import { STUDIO_MODEL_CATALOG, type StudioModelEntry } from '@lnkpi/shared'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'
import { StudioService } from './studio.service'

const imageGenerate = vi.fn(async () => ({
  url: 'https://example.com/i.png',
  urls: ['https://example.com/i.png'],
}))
const videoGenerate = vi.fn(async () => ({ url: 'https://example.com/v.mp4' }))
const audioGenerate = vi.fn(async () => ({ url: 'https://example.com/a.mp3' }))

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
    createAudioProvider: vi.fn(() => ({ generate: audioGenerate })),
  }
})

// 模拟「DB 缓存里有、常量目录没有」的 admin 新增条目：生产上 currentCatalogEntries
// 返回 model-catalog-store 的 5s TTL 缓存 rows；这里只替换返回值以固定观测，
// 其余导出（resolveModelKey 等）保留真实实现。
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
    modelKey: 'db-only-video',
    displayName: 'DB 新增视频模型',
    gatewayModelId: 'db-only-video-gw',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native', duration: 'native', aspectRatio: 'native', resolution: 'native' },
  },
  {
    modelKey: 'db-only-image',
    displayName: 'DB 新增图像模型',
    gatewayModelId: 'db-only-image-gw',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native', size: 'native', n: 'native' },
  },
  {
    modelKey: 'db-only-audio',
    displayName: 'DB 新增音频模型',
    gatewayModelId: 'db-only-audio-gw',
    modality: 'audio',
    audioKind: 'voice',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native', voice: 'native', speed: 'native' },
  },
]

const platformResolve = (model?: string) => ({
  channelId: 'platform',
  modelName: model ?? '',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'plat-key', baseUrl: 'https://platform.example.com/v1' },
  source: 'platform' as const,
})

describe('StudioService → agent adapter 注入 DB 目录 rows（B2 S2-1c 接线）', () => {
  let svc: StudioService
  let generationCreate: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    currentCatalogEntries.mockClear()
    currentCatalogEntries.mockImplementation(() => [...STUDIO_MODEL_CATALOG, ...dbOnlyRows])
    generationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'g1',
      createdAt: new Date(),
      ...args.data,
    }))

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        {
          provide: PointsService,
          useValue: { consume: vi.fn(async () => {}), refund: vi.fn(async () => {}) },
        },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: generationCreate,
              update: vi.fn(async () => ({})),
              updateMany: vi.fn(async () => ({ count: 1 })),
              findFirst: vi.fn(async () => null),
              findMany: vi.fn(async () => []),
              delete: vi.fn(async () => ({})),
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
            probeUrl: vi.fn(async (url: string) => ({ url, probeStatus: 'ok' as const })),
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

  it('video：DB-only 模型解析命中 DB 条目（不再 fallback 到 agnes-video-v2.0）', async () => {
    const record = await svc.generateVideo('u1', 'walk', 'db-only-video')
    await vi.waitFor(() => expect(videoGenerate).toHaveBeenCalled())

    expect(currentCatalogEntries).toHaveBeenCalled()
    // provider 收到 DB 条目的 gatewayModelId，而不是默认模型
    const opts = videoGenerate.mock.calls[0][1] as { model?: string }
    expect(opts.model).toBe('db-only-video-gw')
    expect(opts.model).not.toBe('agnes-video-v2.0')
    // 记录写入 DB 条目的规范 modelKey（fallback:true 时这里会是 agnes-video-v2.0）
    expect(record.model).toBe('db-only-video')
  })

  it('image：DB-only 模型解析命中 DB 条目', async () => {
    const record = await svc.generateImage('u1', 'a cat', 'db-only-image')
    await vi.waitFor(() => expect(imageGenerate).toHaveBeenCalled())

    expect(currentCatalogEntries).toHaveBeenCalled()
    const opts = imageGenerate.mock.calls[0][1] as { modelId?: string }
    expect(opts.modelId).toBe('db-only-image-gw')
    expect(record.model).toBe('db-only-image')
  })

  it('audio：DB-only 模型解析命中 DB 条目', async () => {
    const record = await svc.generateAudio('u1', 'hi', { model: 'db-only-audio' })
    await vi.waitFor(() => expect(audioGenerate).toHaveBeenCalled())

    expect(currentCatalogEntries).toHaveBeenCalled()
    const opts = audioGenerate.mock.calls[0][1] as { model?: string }
    expect(opts.model).toBe('db-only-audio-gw')
    expect(opts.model).not.toBe('speech-2.8-hd')
    expect(record.model).toBe('db-only-audio')
  })
})
