import 'reflect-metadata'
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
 * Task 7 的 music 分支是**异步任务**：扣分 → 建generating 记录 → 先返回 → 后台跑
 * submit/query 轮询 → 终态收敛（completed 或退款 + failed）。
 *
 * 🔴 头号风险：上游终态 FAILED 时 HTTP 仍是 200。若只按 HTTP 码判成功，会产出一条
 * 「已完成但没有 url」的记录 ⇒ 前端展示空音频且**永不退款**。故这里逐条钉死状态字段判失败。
 */
const musicGenerate = vi.fn()
const ttsGenerate = vi.fn(async () => ({ url: 'https://example.com/a.mp3' }))

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    StepFunMusicProvider: vi.fn(() => ({ generate: musicGenerate })),
    // 兜住 voice 路径：本文件有一条用例故意用非阶跃模型，确保它走 TTS 而非 music。
    createAudioProvider: vi.fn(() => ({ generate: ttsGenerate })),
  }
})

const MUSIC_MODEL = 'stepaudio-3-music-preview'

const musicResolved = {
  channelId: 'platform',
  modelName: MUSIC_MODEL,
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'plat-stepfun-key', baseUrl: 'https://api.stepfun.com/v1' },
  source: 'platform' as const,
}

describe('generateAudio 的 music 分支（异步任务）', () => {
  let svc: StudioService
  let pointsConsume: ReturnType<typeof vi.fn>
  let pointsRefund: ReturnType<typeof vi.fn>
  let generationCreate: ReturnType<typeof vi.fn>
  let generationUpdate: ReturnType<typeof vi.fn>
  let generationUpdateMany: ReturnType<typeof vi.fn>
  let saveUserFile: ReturnType<typeof vi.fn>
  let stored: Record<string, unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    stored = {}
    pointsConsume = vi.fn(async () => {})
    pointsRefund = vi.fn(async () => {})
    generationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
      stored = { id: 'g-music', createdAt: new Date(), ...args.data }
      return stored
    })
    generationUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      stored = { ...stored, ...args.data, id: args.where.id }
      return stored
    })
    generationUpdateMany = vi.fn(async () => ({ count: 1 }))
    saveUserFile = vi.fn(async () => ({ url: 'https://cdn/u1/music.mp3' }))
    musicGenerate.mockResolvedValue({ buffer: Buffer.from([1, 2, 3]) })

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
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => stored),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: { resolveForGeneration: vi.fn(async () => musicResolved) },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url })) },
        },
        { provide: UploadService, useValue: { saveUserFile } },
      ],
    }).compile()

    svc = moduleRef.get(StudioService)
  })

  it('扣 15 分（music 定价，voice/design 仍是 5）并先返回 generating 记录', async () => {
    const record = await svc.generateAudio('u1', '一段轻快的背景乐', {
      model: MUSIC_MODEL,
      caption: '轻快的钢琴',
      instrumental: true,
    })

    expect(pointsConsume).toHaveBeenCalledWith(
      'u1',
      15,
      '音频生成-音乐',
      expect.objectContaining({ kind: 'consume', category: 'audio', status: 'success' }),
    )
    expect(record.status).toBe('generating')
    const meta = JSON.parse(String(generationCreate.mock.calls[0][0].data.metadata))
    expect(meta.audioKind).toBe('music')
    expect(meta.chargedPoints).toBe(15)
    expect(meta.caption).toBe('轻快的钢琴')
    expect(meta.instrumental).toBe(true)
    // 前端既有轮询器的接管点：返回体必须带 recordId + generationStartedAt。
    expect(record.id).toBe('g-music')
    expect(String(record.generationStartedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('provider 构造在 StepFun 端点域名上（不回落OPENAI 网关）', async () => {
    await svc.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: '轻快的钢琴' })
    await vi.waitFor(() => expect(musicGenerate).toHaveBeenCalled())
    expect(StepFunMusicProvider).toHaveBeenCalledWith(
      'plat-stepfun-key',
      'https://api.stepfun.com/v1',
    )
  })

  it('成功 → 落对象存储 + 记录转completed', async () => {
    await svc.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: '轻快的钢琴' })
    await vi.waitFor(() => expect(generationUpdateMany).toHaveBeenCalled())

    expect(saveUserFile).toHaveBeenCalledWith(
      'u1',
      Buffer.from([1, 2, 3]),
      'music.mp3',
      'audio/mpeg',
    )
    const [updateArgs] = generationUpdateMany.mock.calls[0] as [
      { where: { id: string; status: string }; data: Record<string, unknown> },
    ]
    expect(updateArgs.where).toEqual({ id: 'g-music', status: 'generating' })
    expect(updateArgs.data.status).toBe('completed')
    expect(updateArgs.data.url).toBe('https://cdn/u1/music.mp3')
    expect(pointsRefund).not.toHaveBeenCalled()
  })

  it('🔴 终态 FAILED（HTTP 200）→ 退款 15 + 记录 failed + 可判读文案', async () => {
    musicGenerate.mockRejectedValue(new Error('music task FAILED: content policy'))

    const record = await svc.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: 'x' })
    expect(record.status).toBe('generating')

    await vi.waitFor(() => expect(generationUpdate).toHaveBeenCalled())
    const failed = generationUpdate.mock.calls.at(-1)![0].data as Record<string, unknown>
    expect(failed.status).toBe('failed')
    const meta = JSON.parse(String(failed.metadata))
    expect(meta.refundedPoints).toBe(15)
    expect(meta.refundReason).toBe('platform_failed')
    // 文案必须能让人判读出「音乐失败 + 上游原因」，不能是泛化的 500。
    expect(String(meta.userMessage)).toContain('音乐生成失败')
    expect(String(meta.userMessage)).toContain('content policy')
    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      15,
      '音频生成-音乐-失败退款',
      expect.objectContaining({ kind: 'refund', category: 'audio', status: 'failed_refund' }),
    )
  })

  it('BYOK music 提交**后**失败也不进 fallback_pending（否则平台重放会变 TTS）', async () => {
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
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => stored),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            resolveForGeneration: vi.fn(async () => ({
              ...musicResolved,
              channelId: 'ch_user',
              source: 'user' as const,
              credentials: { apiKey: 'user-stepfun-key', baseUrl: 'https://user.example.com/v1' },
            })),
          },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url })) },
        },
        { provide: UploadService, useValue: { saveUserFile } },
      ],
    }).compile()
    const svcByok = moduleRef.get(StudioService)
    musicGenerate.mockRejectedValue(new Error('music task FAILED: boom'))

    await svcByok.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: 'x' })
    await vi.waitFor(() => expect(generationUpdate).toHaveBeenCalled())

    const statuses = generationUpdate.mock.calls.map((c) => c[0].data.status)
    expect(statuses).not.toContain('fallback_pending')
    expect(generationUpdate.mock.calls.at(-1)![0].data.status).toBe('failed')
    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      15,
      expect.stringContaining('失败退款'),
      expect.objectContaining({ status: 'failed_refund' }),
    )
  })

  it('🔴 BYOK music 缺 apiKey → failed + 退款，绝不 fallback_pending（否则平台重放会变 TTS）', async () => {
    // 回归锁（review Important 1）：通用守卫 `source==='user' && !apiKey` 在 music 分支
    // **之前**抛错 ⇒ 缺 key 的 BYOK music 从不走 completeMusic，而是落进共享 catch。
    // 若 catch 对 music 也走 BYOK 分支，记录就成了 fallback_pending，用户点「用平台重试」
    // 会把 `stepaudio-3-music-preview` 当 TTS 模型发出去并被标 completed。
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
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => stored),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            // provider.service.ts 的 clearApiKey 就是写 encryptedApiKey: null
            // ⇒ resolver 产出 apiKey: undefined。
            resolveForGeneration: vi.fn(async () => ({
              ...musicResolved,
              channelId: 'ch_user',
              source: 'user' as const,
              credentials: { apiKey: undefined, baseUrl: 'https://user.example.com/v1' },
            })),
          },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url })) },
        },
        { provide: UploadService, useValue: { saveUserFile } },
      ],
    }).compile()
    const svcNoKey = moduleRef.get(StudioService)

    await expect(
      svcNoKey.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: 'x' }),
    ).rejects.toThrow(/音乐生成失败/)

    // 记录必须是 failed，且任何一次写盘都不得出现 fallback_pending。
    expect(generationCreate).toHaveBeenCalledTimes(1)
    const created = generationCreate.mock.calls[0][0].data as Record<string, unknown>
    expect(created.status).toBe('failed')
    const allStatuses = [
      ...generationCreate.mock.calls.map((c) => c[0].data.status),
      ...generationUpdate.mock.calls.map((c) => c[0].data.status),
      ...generationUpdateMany.mock.calls.map((c) => c[0].data.status),
    ]
    expect(allStatuses).not.toContain('fallback_pending')

    const meta = JSON.parse(String(created.metadata))
    expect(meta.audioKind).toBe('music')
    expect(meta.refundedPoints).toBe(15)
    expect(String(meta.userMessage)).toContain('音乐生成失败')
    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      15,
      expect.stringContaining('失败退款'),
      expect.objectContaining({ kind: 'refund', category: 'audio', status: 'failed_refund' }),
    )
    // 提交根本没发生，别去碰上游。
    expect(musicGenerate).not.toHaveBeenCalled()
  })

  it('生成期间用户取消 → 不再写completed，也不二次退款', async () => {
    // 模拟 cancelGeneration 已把记录置failed 并退过款：completeMusic 必须识别并退出。
    generationCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      stored = { id: 'g-music', createdAt: new Date(), ...args.data }
      return stored
    })
    musicGenerate.mockImplementation(async () => {
      stored = {
        ...stored,
        status: 'failed',
        metadata: JSON.stringify({
          chargedPoints: 15,
          cancelled: true,
          refundedPoints: 15,
        }),
      }
      return { buffer: Buffer.from([1, 2, 3]) }
    })

    await svc.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: 'x' })
    await new Promise((r) => setTimeout(r, 50))

    expect(generationUpdateMany).not.toHaveBeenCalled()
    expect(stored.status).toBe('failed')
    // 退款只由 cancelGeneration 结算过一次，completeMusic 不许再退。
    expect(pointsRefund).not.toHaveBeenCalled()
  })

  it('记录仍是 generating 但已退过款 → completeMusic 不二次退款', async () => {
    // 防「先退款、后到达的终态」这类时序：状态还没翻，但钱已经退过了。
    musicGenerate.mockImplementation(async () => {
      stored = {
        ...stored,
        metadata: JSON.stringify({ chargedPoints: 15, refundedPoints: 15, refundReason: 'cancelled' }),
      }
      return { buffer: Buffer.from([1, 2, 3]) }
    })

    await svc.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: 'x' })
    await new Promise((r) => setTimeout(r, 50))

    expect(generationUpdateMany).not.toHaveBeenCalled()
    expect(pointsRefund).not.toHaveBeenCalled()
  })

  it('平台缺 STEPFUN key → 显式失败并退款，绝不静默改走别的provider', async () => {
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
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => stored),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            resolveForGeneration: vi.fn(async () => ({
              ...musicResolved,
              credentials: { apiKey: undefined, baseUrl: '' },
            })),
          },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url })) },
        },
        { provide: UploadService, useValue: { saveUserFile } },
      ],
    }).compile()
    const svcNoKey = moduleRef.get(StudioService)

    await expect(
      svcNoKey.generateAudio('u1', 'x', { model: MUSIC_MODEL, caption: 'x' }),
    ).rejects.toThrow(/STEPFUN_API_KEY/)

    expect(musicGenerate).not.toHaveBeenCalled()
    expect(pointsRefund).toHaveBeenCalledWith(
      'u1',
      15,
      '音频生成-音乐-失败退款',
      expect.objectContaining({ status: 'failed_refund' }),
    )
  })

  it('非阶跃模型不落music 分支：kind 由目录派生 ⇒ 它就是 voice，仍扣 5 分走 TTS', async () => {
    // `audioKindOf` 只看目录里的模型名：非阶跃模型在定义上就是 voice，
    // 所以「用非阶跃模型偷跑 music」这条路径根本不存在。这里反向锁死该不变量：
    // 非阶跃模型既不进 music 分支，也不改voice 的 5 分定价。
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
              updateMany: generationUpdateMany,
              findFirst: vi.fn(async () => stored),
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: {
            resolveForGeneration: vi.fn(async () => ({
              ...musicResolved,
              modelName: 'minimax-speech-2.8-hd',
            })),
          },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url })) },
        },
        { provide: UploadService, useValue: { saveUserFile } },
      ],
    }).compile()
    const svcOther = moduleRef.get(StudioService)

    const record = await svcOther.generateAudio('u1', 'x')

    expect(musicGenerate).not.toHaveBeenCalled()
    expect(record.status).toBe('completed')
    expect(pointsConsume).toHaveBeenCalledWith(
      'u1',
      5,
      '音频生成',
      expect.objectContaining({ kind: 'consume', category: 'audio', status: 'success' }),
    )
    const meta = JSON.parse(String(generationCreate.mock.calls[0][0].data.metadata))
    expect(meta.audioKind).toBe('voice')
  })
})