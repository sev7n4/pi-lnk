import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { createAudioProvider, StepFunMusicProvider } from '@lnkpi/agent'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'
import { StudioService } from './studio.service'

/**
 * Ruling R12：`kind`（调用方声明的音频二阶分类）必须与**模型目录里的分类**一致。
 *
 * 🔴 为什么必须显式拒绝：`generateAudio` 的分支由 `audioKindOf(resolved.modelName)` 驱动，
 * **不读** `options.kind`。所以 agent 传 `kind:'music'` 而节点 `audioModel` 仍是 TTS 时，
 * 旧行为是静默出一段 TTS 并把记录标 completed —— 调用方拿到「成功」，却不是要的东西
 * （违反计划全局约束「禁止静默回退」）。本文件锁死「不匹配 ⇒ 显式失败 + 退款 + 不碰上游」。
 *
 * 夹具沿用 Task 7 的 `studio.audio-music.test.ts` 同款（Nest TestingModule + resolver/prisma/points mock）。
 */
const ttsGenerate = vi.fn(async () => ({ url: 'https://example.com/a.mp3' }))
const musicGenerate = vi.fn(async () => ({ buffer: Buffer.from([1, 2, 3]) }))
const designGenerate = vi.fn(async () => ({ buffer: Buffer.from([4, 5, 6]), contentType: 'audio/mpeg' }))

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    StepFunMusicProvider: vi.fn(() => ({ generate: musicGenerate })),
    StepFunDesignProvider: vi.fn(() => ({ generate: designGenerate })),
    createAudioProvider: vi.fn(() => ({ generate: ttsGenerate })),
  }
})

const TTS_MODEL = 'minimax-speech-2.8-hd' // audioKind: 'voice'
const MUSIC_MODEL = 'stepaudio-3-music-preview' // audioKind: 'music'

describe('generateAudio 的 kind↔模型一致性守卫（R12）', () => {
  let svc: StudioService
  let pointsConsume: ReturnType<typeof vi.fn>
  let pointsRefund: ReturnType<typeof vi.fn>
  let generationCreate: ReturnType<typeof vi.fn>
  let generationUpdateMany: ReturnType<typeof vi.fn>
  let savedRecord: Record<string, unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    savedRecord = {}
    pointsConsume = vi.fn(async () => {})
    pointsRefund = vi.fn(async () => {})
    generationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
      savedRecord = { id: 'g-audio', createdAt: new Date(), ...args.data }
      return savedRecord
    })
    generationUpdateMany = vi.fn(async () => ({ count: 1 }))

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        { provide: PointsService, useValue: { consume: pointsConsume, refund: pointsRefund } },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: generationCreate,
              update: vi.fn(async () => ({})),
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => savedRecord),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          // 默认解析出 TTS 模型：任何「声明 music/design 却拿到 TTS 模型」的请求都会撞守卫。
          useValue: {
            resolveForGeneration: vi.fn(async () => ({
              channelId: 'platform',
              modelName: TTS_MODEL,
              apiFormat: 'openai' as const,
              credentials: { apiKey: 'plat-key', baseUrl: 'https://gw.example.com/v1' },
              source: 'platform' as const,
            })),
          },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url })) },
        },
        { provide: UploadService, useValue: { saveUserFile: vi.fn(async () => ({ url: 'x' })) } },
      ],
    }).compile()

    svc = moduleRef.get(StudioService)
  })

  it('🔴 请求 music 但模型是 TTS ⇒ 显式失败，绝不静默出 TTS', async () => {
    await expect(svc.generateAudio('u1', '一段轻快的背景乐', { kind: 'music' })).rejects.toThrow(
      /music/,
    )

    // 上游一次都不能碰：碰了就等于「静默按模型跑」，正是本守卫要消灭的行为。
    expect(ttsGenerate).not.toHaveBeenCalled()
    expect(musicGenerate).not.toHaveBeenCalled()
    expect(createAudioProvider).not.toHaveBeenCalled()
    // 不得留下任何「已完成」痕迹。
    expect(generationUpdateMany).not.toHaveBeenCalled()
  })

  it('🔴 请求 design 但模型是 TTS ⇒ 显式失败', async () => {
    await expect(svc.generateAudio('u1', '一段综合音频', { kind: 'design' })).rejects.toThrow(
      BadRequestException,
    )
    expect(ttsGenerate).not.toHaveBeenCalled()
    expect(designGenerate).not.toHaveBeenCalled()
  })

  it('不匹配也要退款 + 落 failed 记录（不能吞了用户积分）', async () => {
    await expect(svc.generateAudio('u1', 'x', { kind: 'music' })).rejects.toThrow()

    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      5,
      expect.stringContaining('失败退款'),
      expect.objectContaining({ kind: 'refund', category: 'audio' }),
    )
    const created = generationCreate.mock.calls.at(-1)![0].data as Record<string, unknown>
    expect(created.status).toBe('failed')
    // 文案必须能让人判读出「要 music 但模型是 voice」，而不是泛化的 500。
    const meta = JSON.parse(String(created.metadata))
    expect(String(meta.userMessage)).toContain('music')
    expect(String(meta.userMessage)).toContain(TTS_MODEL)
  })

  it('kind 与模型一致 ⇒ 照旧放行（守卫不误伤正常路径）', async () => {
    const record = await svc.generateAudio('u1', '一段旁白', { kind: 'voice' })
    expect(record.status).toBe('completed')
    expect(ttsGenerate).toHaveBeenCalled()
    expect(pointsRefund).not.toHaveBeenCalled()
  })

  it('不传 kind ⇒ 照旧按模型走（存量调用逐字节不变）', async () => {
    const record = await svc.generateAudio('u1', '一段旁白')
    expect(record.status).toBe('completed')
    expect(ttsGenerate).toHaveBeenCalled()
  })

  it('请求 music 且模型确为音乐模型 ⇒ 放行（不误伤 Task 7 的 music 路径）', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        { provide: PointsService, useValue: { consume: pointsConsume, refund: pointsRefund } },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: generationCreate,
              update: vi.fn(async () => ({})),
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => savedRecord),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            resolveForGeneration: vi.fn(async () => ({
              channelId: 'platform',
              modelName: MUSIC_MODEL,
              apiFormat: 'openai' as const,
              credentials: { apiKey: 'plat-stepfun-key', baseUrl: 'https://api.stepfun.com/v1' },
              source: 'platform' as const,
            })),
          },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url })) },
        },
        { provide: UploadService, useValue: { saveUserFile: vi.fn(async () => ({ url: 'x' })) } },
      ],
    }).compile()
    const svcMusic = moduleRef.get(StudioService)

    const record = await svcMusic.generateAudio('u1', '一段轻快的背景乐', {
      kind: 'music',
      caption: '轻快的钢琴',
    })
    expect(record.status).toBe('generating')
    await vi.waitFor(() => expect(musicGenerate).toHaveBeenCalled())
    expect(StepFunMusicProvider).toHaveBeenCalled()
  })
})
