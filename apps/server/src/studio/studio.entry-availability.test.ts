import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { UPSTREAM_ROUTE_SEEDS } from '@lnkpi/shared'
import { createImageProvider, mergeRefsToPrompt } from '@lnkpi/agent'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { CryptoService } from '../provider/crypto.service'
import { PLATFORM_CHANNEL_ID } from '../provider/provider.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import {
  __resetUpstreamRouteStoreForTests,
  __setCachedUpstreamRoutesForTests,
} from '../provider/upstream-route-store'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'
import { StudioService } from './studio.service'

const imageGenerate = vi.fn()

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    mergeRefsToPrompt: vi.fn(async (input: { localPrompt?: string }) => ({
      mergedText: input.localPrompt ?? 'merged',
      skippedMerge: true,
    })),
    createImageProvider: vi.fn(() => ({ generate: imageGenerate })),
  }
})

interface RecordRow {
  id: string
  status: string
  metadata: string
  [key: string]: unknown
}

function createMemoryPrisma(platformModels: unknown[]) {
  const records = new Map<string, RecordRow>()
  const platformChannel = {
    id: PLATFORM_CHANNEL_ID,
    userId: null,
    name: '平台服务',
    apiFormat: 'openai',
    baseUrl: 'https://platform.example.com/v1',
    encryptedApiKey: null,
    iv: null,
    authTag: null,
    keyVersion: 1,
    models: JSON.stringify(platformModels),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  return {
    records,
    providerChannel: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === PLATFORM_CHANNEL_ID ? platformChannel : null,
    },
    generationRecord: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: RecordRow = {
          ...(data as RecordRow),
          id: String(data.id ?? `g${records.size + 1}`),
          createdAt: new Date(),
        }
        records.set(row.id, row)
        return row
      },
      findFirst: async ({ where }: { where: { id: string } }) =>
        records.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = records.get(where.id)!
        const next = { ...row, ...data }
        records.set(where.id, next)
        return next
      },
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const row = records.get(where.id)
        if (!row || row.status !== where.status) return { count: 0 }
        records.set(where.id, { ...row, ...data })
        return { count: 1 }
      },
      delete: async ({ where }: { where: { id: string } }) => {
        records.delete(where.id)
        return {}
      },
      findMany: async () => [...records.values()],
    },
    session: { findUnique: async () => null },
  }
}

function parseMeta(row: RecordRow | null): Record<string, unknown> {
  if (!row) return {}
  try {
    return JSON.parse(row.metadata) as Record<string, unknown>
  } catch {
    return {}
  }
}

describe('S2-3 生成入口 availability 校验 + 二次失败独立计费退款（A3/A5）', () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY
  const originalOpenAiBase = process.env.OPENAI_BASE_URL
  const originalEncryptionKey = process.env.BYOK_ENCRYPTION_KEY_V1
  let svc: StudioService
  let prisma: ReturnType<typeof createMemoryPrisma>
  let pointsConsume: ReturnType<typeof vi.fn>
  let pointsRefund: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = 'platform-env-key'
    process.env.OPENAI_BASE_URL = 'https://platform.example.com/v1'
    process.env.BYOK_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 7).toString('base64')
    __resetUpstreamRouteStoreForTests()
    __setCachedUpstreamRoutesForTests([...UPSTREAM_ROUTE_SEEDS])
    imageGenerate.mockReset()
    pointsConsume = vi.fn(async () => {})
    pointsRefund = vi.fn(async () => {})
    prisma = createMemoryPrisma([
      { name: 'agnes-image-2.1-flash', capability: 'image', availability: 'unavailable' },
    ])

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        ProviderResolverService,
        CryptoService,
        { provide: PrismaService, useValue: prisma },
        { provide: PointsService, useValue: { consume: pointsConsume, refund: pointsRefund } },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url, probeStatus: 'ok' as const })) },
        },
        {
          provide: UploadService,
          useValue: { saveUserFile: vi.fn(async () => ({ url: 'https://cdn/x.png' })) },
        },
      ],
    }).compile()
    svc = moduleRef.get(StudioService)
  })

  afterEach(() => {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAiKey
    if (originalOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalOpenAiBase
    if (originalEncryptionKey === undefined) delete process.env.BYOK_ENCRYPTION_KEY_V1
    else process.env.BYOK_ENCRYPTION_KEY_V1 = originalEncryptionKey
  })

  it('A3：生成入口对探活 unavailable 的模型拒绝（不扣费、不建记录）', async () => {
    await expect(
      svc.generateImage('u1', 'a cat', 'platform::agnes-image-2.1-flash'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'model_unavailable' }),
    })
    expect(pointsConsume).not.toHaveBeenCalled()
    expect(prisma.records.size).toBe(0)
  })

  it('A3：合法模型（不在灰显名单）正常出记录', async () => {
    imageGenerate.mockResolvedValue({ url: 'https://example.com/ok.png', urls: ['https://example.com/ok.png'] })
    const record = await svc.generateImage('u1', 'a cat', 'platform::seedream-5.0-pro')
    expect(record).toBeTruthy()
    expect(pointsConsume).toHaveBeenCalledTimes(1)
    expect(prisma.records.size).toBe(1)
  })

  it('A5：换模型重试再失败 → 新记录独立计费退款，旧记录不变', async () => {
    imageGenerate.mockRejectedValue(new Error('upstream boom'))
    // agnes-image-2.0-flash 是 sync_url 档：completeImage 在快速路径内同步落库
    const first = await svc.generateImage('u1', 'a cat', 'platform::agnes-image-2.0-flash')
    expect(first).toBeTruthy()
    const firstRow = prisma.records.get(String((first as { id: string }).id))!
    const firstMeta = parseMeta(firstRow)
    expect(firstRow.status).toBe('failed')
    expect(firstMeta.chargedPoints).toBe(10)
    expect(firstMeta.refundedPoints).toBe(10)
    expect(firstMeta.refundReason).toBe('platform_failed')
    expect(pointsRefund).toHaveBeenCalledTimes(1)

    // 换模型重试（同一 generateImage 通路，换成另一个 sync 档合法模型）→ 再次失败
    const second = await svc.generateImage('u1', 'a cat again', 'platform::agnes-image-2.5-flash')
    const secondRow = prisma.records.get(String((second as { id: string }).id))!
    const secondMeta = parseMeta(secondRow)
    expect(secondRow.id).not.toBe(firstRow.id)
    expect(secondRow.status).toBe('failed')
    expect(secondMeta.chargedPoints).toBe(10)
    expect(secondMeta.refundedPoints).toBe(10)
    // 旧记录独立：零改动
    expect(prisma.records.get(firstRow.id)!.metadata).toBe(firstRow.metadata)
    expect(pointsRefund).toHaveBeenCalledTimes(2)
  })
})
