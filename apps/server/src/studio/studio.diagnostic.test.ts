import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { NotFoundException } from '@nestjs/common'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'
import { StudioService } from './studio.service'

describe('StudioService.getGenerationDiagnostic', () => {
  let svc: StudioService
  let generationFindFirst: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    generationFindFirst = vi.fn()

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        {
          provide: PointsService,
          useValue: { consume: vi.fn(), refund: vi.fn() },
        },
        {
          provide: PrismaService,
          useValue: {
            generationRecord: {
              create: vi.fn(),
              update: vi.fn(),
              updateMany: vi.fn(),
              findFirst: generationFindFirst,
              findMany: vi.fn(async () => []),
            },
          },
        },
        {
          provide: ProviderResolverService,
          useValue: { resolveForGeneration: vi.fn() },
        },
        {
          provide: MediaProbeService,
          useValue: { probeUrl: vi.fn(async (url: string) => ({ url, probeStatus: 'ok' as const })) },
        },
        {
          provide: UploadService,
          useValue: { saveUserFile: vi.fn(async () => ({ url: 'https://cdn/comp.png' })) },
        },
      ],
    }).compile()

    svc = moduleRef.get(StudioService)
  })

  it('getGenerationDiagnostic returns 404 when not failed', async () => {
    generationFindFirst.mockResolvedValue({
      id: 'g1',
      userId: 'u1',
      status: 'completed',
      model: 'seedream-5.0-pro',
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
      metadata: JSON.stringify({}),
    })

    await expect(svc.getGenerationDiagnostic('u1', 'g1')).rejects.toThrow(/不存在|找不到|诊断/)
    await expect(svc.getGenerationDiagnostic('u1', 'g1')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('getGenerationDiagnostic allows fallback_pending with BYOK error', async () => {
    generationFindFirst.mockResolvedValue({
      id: 'g-fp',
      userId: 'u1',
      status: 'fallback_pending',
      model: 'user-byok',
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
      metadata: JSON.stringify({
        errorCode: 'fallback_pending',
        byokErrorRaw: 'upstream 502 Bad Gateway',
        errorRaw: 'upstream 502 Bad Gateway',
        userMessage: 'BYOK 上游失败（upstream）：upstream 502 Bad Gateway',
        channelId: 'ch1',
        failedAt: '2026-07-21T01:00:00.000Z',
      }),
    })

    const d = await svc.getGenerationDiagnostic('u1', 'g-fp')
    expect(d.code).toBe('fallback_pending')
    expect(d.providerSnippet).toContain('502')
    expect(d.userMessage).toContain('BYOK')
  })

  it('getGenerationDiagnostic redacts provider snippet', async () => {
    generationFindFirst.mockResolvedValue({
      id: 'g1',
      userId: 'u1',
      status: 'failed',
      model: 'seedream-5.0-pro',
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
      metadata: JSON.stringify({
        errorCode: 'upstream_error',
        errorRaw: 'Bearer sk-secret hello',
        userMessage: '上游服务异常',
        failedAt: '2026-07-21T01:00:00.000Z',
        channelId: 'platform',
      }),
    })

    const d = await svc.getGenerationDiagnostic('u1', 'g1')
    expect(d.code).toBe('upstream_error')
    expect(d.taskKind).toBe('generation')
    expect(d.taskId).toBe('g1')
    expect(d.providerSnippet).not.toContain('sk-secret')
  })

  it('getGenerationDiagnostic allows status error', async () => {
    generationFindFirst.mockResolvedValue({
      id: 'g2',
      userId: 'u1',
      status: 'error',
      model: null,
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
      metadata: JSON.stringify({
        errorCode: 'upstream_timeout',
        errorRaw: 'timeout of 90000ms exceeded',
        failedAt: '2026-07-21T02:00:00.000Z',
      }),
    })

    const d = await svc.getGenerationDiagnostic('u1', 'g2')
    expect(d.code).toBe('upstream_timeout')
    expect(d.taskId).toBe('g2')
  })

  it('getGenerationDiagnostic renders the production 503 model_not_found failure via the real path (S0-2)', async () => {
    // 生产 503 原文（总体规格 §2.4 逐字）
    const prod503Text =
      'Text API 503: {"error":{"code":"model_not_found","message":"No available channel for model deepseek-v4 under group default (distributor) (request id: 20261009043413943840776XprVkXAP)","type":"AgnesAI_error"}}'
    // metadata 模拟失败记录：故意不写入 errorCode，让 code 断言走读取路径的真实分类回落分支
    // mapMessageToErrorCode(errRaw)（studio.service.ts:1112-1113），用生产 503 原文非循环地验证分类。
    // userMessage 仍为 metadata 回放（读取路径只透传 meta.userMessage）；写入路径（applyFailureDiagnosticMeta）
    // 的覆盖属已知限制，留待后续任务。
    generationFindFirst.mockResolvedValue({
      id: 'g-503',
      userId: 'u1',
      status: 'failed',
      model: 'deepseek-v4',
      createdAt: new Date('2026-10-09T04:34:00.000Z'),
      metadata: JSON.stringify({
        errorRaw: prod503Text,
        userMessage: '平台暂未开通该模型（上游无可用渠道），请换个模型或联系管理员',
        httpStatus: 503,
        failedAt: '2026-10-09T04:34:14.000Z',
      }),
    })

    const d = await svc.getGenerationDiagnostic('u1', 'g-503')
    // userMessage = metadata 回放（见上注释）
    expect(d.userMessage).toBe('平台暂未开通该模型（上游无可用渠道），请换个模型或联系管理员')
    // code = 真实分类回落分支：meta 无 errorCode → mapMessageToErrorCode(生产 503 原文)
    expect(d.code).toBe('model_unavailable')
    expect(d.hint).toBe('请更换可用模型')
    // 2.4：解析链把 meta.httpStatus 填进 diagnostic
    expect(d.httpStatus).toBe(503)
  })

  it('S2-3：诊断透传 metadata 退款三字段（只透传不重算，缺字段不下发）', async () => {
    generationFindFirst.mockResolvedValue({
      id: 'g-refund',
      userId: 'u1',
      status: 'failed',
      model: 'agnes-image-2.1-flash',
      createdAt: new Date('2026-10-10T00:00:00.000Z'),
      metadata: JSON.stringify({
        errorCode: 'upstream_error',
        errorRaw: 'upstream boom',
        chargedPoints: 5,
        refundedPoints: 5,
        refundReason: 'platform_failed',
      }),
    })
    const d = await svc.getGenerationDiagnostic('u1', 'g-refund')
    expect(d.chargedPoints).toBe(5)
    expect(d.refundedPoints).toBe(5)
    expect(d.refundReason).toBe('platform_failed')

    // 缺字段：不下发（undefined），前端不渲染退款行
    generationFindFirst.mockResolvedValue({
      id: 'g-norefund',
      userId: 'u1',
      status: 'failed',
      model: 'agnes-image-2.1-flash',
      createdAt: new Date('2026-10-10T00:00:00.000Z'),
      metadata: JSON.stringify({ errorCode: 'upstream_error', errorRaw: 'boom' }),
    })
    const d2 = await svc.getGenerationDiagnostic('u1', 'g-norefund')
    expect(d2.refundedPoints).toBeUndefined()
    expect(d2.chargedPoints).toBeUndefined()
    expect(d2.refundReason).toBeUndefined()
  })
})
