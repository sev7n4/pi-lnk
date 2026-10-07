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
const DESIGN_MODEL = 'stepaudio-3-gen-preview' // audioKind: 'design'

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

/**
 * Ruling R14：**客户端参数校验类失败（`BadRequestException`）不得变成「换平台重试」的重试入口。**
 *
 * 🔴 危害链：`fallback_pending` 会让用户看到「用平台重试」，确认后
 * `confirmPlatformFallback` 取 `meta.modelKey` → 平台凭证 → 把 design/music 的模型名发进
 * `POST {baseUrl}/audio/speech`（**TTS** 端点）→ 记录标 `completed`。
 * 用户点了重试、拿到一段「成功的语音」，而他要的是音乐/综合音频 —— 与 Task 7 修掉的
 * music 缺陷同一类危害（那次是 music 落进 fallback_pending，这次是校验失败落进去）。
 *
 * 本文件锁死两条来源（两者都抛 `BadRequestException`，故同一条 catch 分支即可覆盖）：
 *  (a) `assertAudioKindMatchesModel`：声明的 kind 与模型分类不符（R12 引入）；
 *  (b) `assertStepFunAudioModel`：design/music 给了非阶跃模型（Task 4 引入，此前是
 *      deferred minor #3「守卫在 try 内 ⇒ BYOK 下会落 fallback_pending 而非 400」）。
 *
 * ⚠️ (b) 在**当前目录**下不可触发：所有 design/music 条目都是阶跃模型
 * （`stepaudio-3-gen-preview` / `stepaudio-3-music-preview`），阶跃判定 `^step` 必然通过。
 * 故用例 (b) 直接让 `assertStepFunAudioModel` 抛（spy 注入），验证的是
 * **catch 对该异常类型的处理**，而非目录内容 —— 这样目录将来新增非阶跃 design/music
 * 条目时，本分支已经是安全的。
 */
describe('generateAudio 的 BYOK 失败：客户端校验类失败不进 fallback_pending（R14）', () => {
  let pointsConsume: ReturnType<typeof vi.fn>
  let pointsRefund: ReturnType<typeof vi.fn>
  let generationCreate: ReturnType<typeof vi.fn>
  let generationUpdate: ReturnType<typeof vi.fn>
  let savedRecord: Record<string, unknown>

  /** 所有写盘动作的 status 集合 —— 用它断言「任何一次写盘都不是 fallback_pending」。 */
  const allStatuses = () => [
    ...generationCreate.mock.calls.map((c) => c[0].data.status),
    ...generationUpdate.mock.calls.map((c) => c[0].data.status),
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    savedRecord = {}
    pointsConsume = vi.fn(async () => {})
    pointsRefund = vi.fn(async () => {})
    generationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
      savedRecord = { id: 'g-byok', createdAt: new Date(), ...args.data }
      return savedRecord
    })
    generationUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      savedRecord = { ...savedRecord, ...args.data, id: args.where.id }
      return savedRecord
    })
  })

  /** BYOK 渠道（`source:'user'`）的 module —— 这是 fallback_pending 的唯一来源。 */
  async function byokService(modelName: string) {
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
              updateMany: vi.fn(async () => ({ count: 1 })),
              findFirst: vi.fn(async () => savedRecord),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            resolveForGeneration: vi.fn(async () => ({
              channelId: 'ch_user',
              modelName,
              apiFormat: 'openai' as const,
              credentials: { apiKey: 'user-key', baseUrl: 'https://user.example.com/v1' },
              source: 'user' as const,
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
    return moduleRef.get(StudioService)
  }

  it('(a) 🔴 BYOK + kind 与模型不匹配 ⇒ 拒绝 + failed + 退款，绝不建 fallback_pending', async () => {
    const svc = await byokService(TTS_MODEL)

    await expect(svc.generateAudio('u1', '一段轻快的背景乐', { kind: 'music' })).rejects.toThrow(
      BadRequestException,
    )

    // 核心断言：任何一次写盘都不得是 fallback_pending（否则用户能点「用平台重试」）。
    expect(allStatuses()).not.toContain('fallback_pending')
    const created = generationCreate.mock.calls.at(-1)![0].data as Record<string, unknown>
    expect(created.status).toBe('failed')
    // 积分必须退回，且走「失败退款」而非 BYOK 重试退款。
    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      5,
      expect.stringContaining('失败退款'),
      expect.objectContaining({ kind: 'refund', category: 'audio', status: 'failed_refund' }),
    )
    // 上游一次都不能碰。
    expect(ttsGenerate).not.toHaveBeenCalled()
    expect(musicGenerate).not.toHaveBeenCalled()
  })

  it('(b) 🔴 BYOK + 非阶跃 design 模型 ⇒ 同样不进 fallback_pending（覆盖 Task 4 缺口）', async () => {
    // `stepaudio-3-gen-preview` 在目录里是 design 且是阶跃 ⇒ 直接调用不会抛。
    // 这里让守卫真的抛，验证 catch 对「阶跃守卫抛出的 BadRequestException」的处理。
    const audioKind = await import('./audio-kind')
    const spy = vi
      .spyOn(audioKind, 'assertStepFunAudioModel')
      .mockImplementation(() => {
        throw new BadRequestException('综合音频分类仅支持阶跃（StepFun）模型，当前模型为 my-custom-model')
      })
    try {
      const svc = await byokService('my-custom-model')

      await expect(
        svc.generateAudio('u1', '一段综合音频', { kind: 'design' }),
      ).rejects.toThrow(BadRequestException)

      expect(allStatuses()).not.toContain('fallback_pending')
      const created = generationCreate.mock.calls.at(-1)![0].data as Record<string, unknown>
      expect(created.status).toBe('failed')
      expect(pointsRefund).toHaveBeenCalledWith(
        'u1',
        5,
        expect.stringContaining('失败退款'),
        expect.objectContaining({ kind: 'refund', category: 'audio' }),
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('(b 同型) BYOK + 非阶跃 music 模型 ⇒ 同样不进 fallback_pending', async () => {
    const audioKind = await import('./audio-kind')
    const spy = vi
      .spyOn(audioKind, 'assertStepFunAudioModel')
      .mockImplementation(() => {
        throw new BadRequestException('音乐分类仅支持阶跃（StepFun）模型，当前模型为 my-custom-model')
      })
    try {
      const svc = await byokService('my-custom-model')

      await expect(
        svc.generateAudio('u1', '一段背景乐', { kind: 'music', caption: '钢琴' }),
      ).rejects.toThrow(BadRequestException)

      expect(allStatuses()).not.toContain('fallback_pending')
      const created = generationCreate.mock.calls.at(-1)![0].data as Record<string, unknown>
      expect(created.status).toBe('failed')
    } finally {
      spy.mockRestore()
    }
  })

  it('🔴 BYOK + design 上游 5xx ⇒ failed + 退款，不建 fallback_pending（平台重放会变 TTS）', async () => {
    // 本条锁的是 B2 缺口：R14 的射程只覆盖了 music + BadRequestException，
    // `kind === 'design'` + BYOK + 上游 5xx 曾落进 `fallback_pending` ——
    // 而 `confirmPlatformFallback` 的 audio 分支**不读 `meta.audioKind`**，固定发
    // `POST {baseUrl}/audio/speech`，会把 `stepaudio-3-gen-preview` 当 TTS 模型发出去并标 completed。
    const svc = await byokService(DESIGN_MODEL)
    designGenerate.mockRejectedValueOnce(new Error('StepFun design API 502: upstream boom'))

    await expect(
      svc.generateAudio('u1', '一段综合音频', { kind: 'design' }),
    ).rejects.toThrow(/502/)

    // 核心断言：任何一次写盘都不得是 fallback_pending（否则用户能点「用平台重试」→ 变 TTS）。
    expect(allStatuses()).not.toContain('fallback_pending')
    const created = generationCreate.mock.calls.at(-1)![0].data as Record<string, unknown>
    expect(created.status).toBe('failed')
    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      5,
      expect.stringContaining('失败退款'),
      expect.objectContaining({ kind: 'refund', category: 'audio', status: 'failed_refund' }),
    )
  })

  it('回归锁：BYOK 的**上游**失败（非 BadRequestException）仍走 fallback_pending + 重试入口', async () => {
    // 这条是本改动的边界：只把「客户端参数校验类」失败移出重试入口，
    // 真正的渠道/上游故障（这里是 502）必须保留既有的 fallback_pending 语义。
    const svc = await byokService(TTS_MODEL)
    ttsGenerate.mockRejectedValueOnce(new Error('TTS API 502: upstream boom'))

    const record = await svc.generateAudio('u1', '一段旁白')

    expect(record.status).toBe('fallback_pending')
    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      5,
      '音频生成-BYOK失败退款',
      expect.objectContaining({ kind: 'refund', category: 'audio', status: 'byok_refund' }),
    )
  })

  it('回归锁：BYOK 上游失败返回 400 语义时也仍走 fallback_pending（按异常类型而非状态码分流）', async () => {
    // 上游 400 由 provider 包成 `new Error('TTS API 400: ...')`（见 audio-provider.ts），
    // 不是 BadRequestException ⇒ 仍算「渠道侧问题」，保留重试入口。
    const svc = await byokService(TTS_MODEL)
    ttsGenerate.mockRejectedValueOnce(new Error('TTS API 400: invalid voice'))

    const record = await svc.generateAudio('u1', '一段旁白')

    expect(record.status).toBe('fallback_pending')
  })
})
