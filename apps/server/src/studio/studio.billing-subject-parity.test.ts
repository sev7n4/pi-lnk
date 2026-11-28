import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { createAudioProvider, createImageProvider, StepFunDesignProvider, StepFunMusicProvider } from '@lnkpi/agent'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'
import { StudioService } from './studio.service'
import { PricingService } from '../pricing/pricing.service'
import { legacyPriceOf, type PricingQuery, type PricingQuote } from '../pricing/pricing.core'

/**
 * P1.5 展示==扣费参数对齐契约（spec 2026-11-15-pricing-subject-billing-takeover §P1.5）。
 *
 * 不变式：**计费侧 quote query 必须携带完整模型/规格参数**（modelKey + resolution +
 * audioKind 真实 kind），否则引擎主体自解析无从命中主体行（成本×利润价）⇒ 扣费静默
 * 落 legacy 家族行，而前端展示侧（useProposalNodeData / ImageDockPanel，各自的单测
 * 钉死参数）带全参数命中主体行 ⇒ 展示≠扣费，重演 #674 事故形态。
 *
 * 本文件把 studio 三个扣费点的 quote 入参逐字段钉死；漏传任何参数即 RED。
 */

const imageGenerate = vi.fn()
const musicGenerate = vi.fn()
const designGenerate = vi.fn()
const ttsGenerate = vi.fn(async () => ({ url: 'https://example.com/a.mp3' }))

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    mergeRefsToPrompt: vi.fn(async (input: { localPrompt?: string }) => ({
      mergedText: input.localPrompt ?? '',
      skippedMerge: true,
    })),
    createImageProvider: vi.fn(() => ({ generate: imageGenerate })),
    StepFunMusicProvider: vi.fn(() => ({ generate: musicGenerate })),
    StepFunDesignProvider: vi.fn(() => ({ generate: designGenerate })),
    createAudioProvider: vi.fn(() => ({ generate: ttsGenerate })),
  }
})

vi.mock('../media/upstream-ref-inline', () => ({
  inlineUpstreamReferenceImages: vi.fn(async (urls: string[]) => urls),
}))

const IMAGE_MODEL = 'seedream-5.0-pro'
const MUSIC_MODEL = 'stepaudio-3-music-preview'
const DESIGN_MODEL = 'stepaudio-3-gen-preview'

function resolved(modelName: string) {
  return {
    channelId: 'platform',
    modelName,
    apiFormat: 'openai' as const,
    credentials: { apiKey: 'plat-key', baseUrl: 'https://platform.example.com/v1' },
    source: 'platform' as const,
  }
}

describe('P1.5 计费侧 quote 参数契约（漏参 ⇒ 展示≠扣费）', () => {
  let svc: StudioService
  let quoteMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    imageGenerate.mockResolvedValue({ url: 'https://cdn/done.png' })
    musicGenerate.mockResolvedValue({ buffer: Buffer.from([1, 2, 3]) })
    designGenerate.mockResolvedValue({ buffer: Buffer.from([1, 2, 3]) })
    quoteMock = vi.fn(async (q: PricingQuery): Promise<PricingQuote> => ({
      credits: legacyPriceOf(q),
      ruleVersion: 'test-constants',
    }))
    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        { provide: PricingService, useValue: { onModuleInit: vi.fn(async () => {}), quote: quoteMock } },
        { provide: PointsService, useValue: { consume: vi.fn(async () => {}), refund: vi.fn(async () => {}) } },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
                id: 'g1',
                createdAt: new Date(),
                ...args.data,
              })),
              update: vi.fn(async () => ({})),
              updateMany: vi.fn(async () => ({ count: 1 })),
              delete: vi.fn(async () => ({})),
              findFirst: vi.fn(async () => ({})),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            resolveForGeneration: vi.fn(async (_userId: string, model?: string) =>
              resolved(model ?? IMAGE_MODEL),
            ),
          },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url, width: 1024, height: 1024 })) },
        },
        { provide: UploadService, useValue: { saveUserFile: vi.fn(async () => ({ url: 'x' })) } },
      ],
    }).compile()
    svc = moduleRef.get(StudioService)
  })

  it('generateImage：quote 必须带 modelKey（命中图像主体行），且按 profile clamp 后的实际张数计费', async () => {
    await svc.generateImage('u1', '一张图', IMAGE_MODEL, '1:1', [], [], '2K', 2, {})

    expect(quoteMock).toHaveBeenCalledTimes(1)
    const q = quoteMock.mock.calls[0]![0] as PricingQuery & { modelKey?: string }
    expect(q.capability).toBe('image')
    expect(q.modelKey).toBe(IMAGE_MODEL)
    expect(q.resolution).toBe('2K')
    // seedream 的 maxN=1：用户请求 2 张但上游只出 1 张，按实际 1 张计费。
    // 2026-11-28 起 generateImage 统一按 built.n（clamp 后）计费，修正旧实现
    // 「按请求数收费、按能力上限产出」的多收费（agnes 的 n must be 1 事故同族）。
    expect(q.count).toBe(1)
  })

  it('generateImage：agnes 模型 count=3 ⇒ quote/metadata/provider 全部按 clamp 后 n=1 计费与生成', async () => {
    // 2026-11-28 生产取证：agnes 上游强制 n=1，旧实现按用户 count=3 收费却只出 1 张。
    await svc.generateImage('u1', '一张图', 'agnes-image-2.1-flash', '16:9', [], [], '1K', 3, {})

    const q = quoteMock.mock.calls[0]![0] as PricingQuery & { modelKey?: string }
    expect(q.count).toBe(1)
    expect(q.modelKey).toBe('agnes-image-2.1-flash')

    const providerOptions = imageGenerate.mock.calls[0]?.[1] as { n?: number } | undefined
    expect(providerOptions?.n).toBe(1)
  })

  it('generateImageVariation：quote 必须带 modelKey（变体主体行 spec="*"）', async () => {
    await svc.generateImageVariation('u1', '换成夜景', '原图', IMAGE_MODEL, undefined, undefined)

    const q = quoteMock.mock.calls[0]![0] as PricingQuery & { modelKey?: string }
    expect(q.capability).toBe('image_variant')
    expect(q.modelKey).toBe(IMAGE_MODEL)
  })

  it('generateAudio music：quote 必须带真实 kind + modelKey', async () => {
    await svc.generateAudio('u1', '一段轻快的背景乐', { model: MUSIC_MODEL, kind: 'music' })

    const q = quoteMock.mock.calls[0]![0] as PricingQuery & { audioKind?: string; modelKey?: string }
    expect(q.capability).toBe('audio')
    expect(q.audioKind).toBe('music')
    expect(q.modelKey).toBe(MUSIC_MODEL)
  })

  it('generateAudio design：解除 design→voice 归并，quote 传 audioKind=design + modelKey', async () => {
    await svc.generateAudio('u1', '一段综合音频', { model: DESIGN_MODEL, kind: 'design' })

    const q = quoteMock.mock.calls[0]![0] as PricingQuery & { audioKind?: string; modelKey?: string }
    expect(q.capability).toBe('audio')
    expect(q.audioKind).toBe('design')
    expect(q.modelKey).toBe(DESIGN_MODEL)
  })
})

/**
 * material.service（画布素材补齐链路）四个 quote 点的静态契约：每个 quote query
 * 必须携带 modelKey（+video 的 resolution）。漏任一处 ⇒ 该链路扣费静默落 legacy
 * 家族行 ⇒ 展示≠扣费。行为级 mock 成本高（canvas store 依赖网大），源码级契约
 * 与本仓 gestureWiring 等静态守卫同一先例；变更时本测试强制让人回头看本不变式。
 */
describe('P1.5 material.service quote 参数静态契约', () => {
  const read = (): string => readFileSync(new URL('../canvas/material.service.ts', import.meta.url), 'utf8')

  it('主链图像 quote 带 modelKey', () => {
    const src = read()
    expect(src).toMatch(/capability: 'image', count: 1, resolution, modelKey: model/)
  })

  it('主链视频 quote 带 modelKey + resolution', () => {
    const src = read()
    expect(src).toMatch(/capability: 'video',\s*\n\s*modelKey: model,\s*\n\s*resolution,/)
  })

  it('platformFallback 图像 quote 带 modelKey + resolution（meta 缺省仅 undefined 化，不吞字段）', () => {
    const src = read()
    expect(src).toMatch(/modelKey: typeof meta\.model === 'string' \? meta\.model : undefined/)
    expect(src).toMatch(/resolution: typeof meta\.resolution === 'string' \? meta\.resolution : undefined/)
  })

  it('platformFallback 视频 quote 带 modelKey（modelKey/model 双路回退）+ resolution', () => {
    const src = read()
    expect(src).toMatch(/\(typeof meta\.modelKey === 'string' && meta\.modelKey\) \|\|\s*\n\s*\(typeof meta\.model === 'string' && meta\.model\) \|\|\s*\n\s*undefined/)
  })
})