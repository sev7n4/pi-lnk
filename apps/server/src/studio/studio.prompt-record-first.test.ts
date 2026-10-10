import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { StudioService } from './studio.service'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import { UploadService } from '../upload/upload.service'

/**
 * G3 归零复查发现（2026-10-10 生产取证）：generatePrompt（提示词模式）仍是
 * 「先扣费后建记录」旧模式——consume/refund 的 generationId 写死 null，
 * GenerationRecord 后置创建（成功才建 / 失败时才建），永远无法与积分交易对账。
 * 生产 43 笔 text 积分交易中 30 笔 generationId NULL（15 consume + 15 refund），
 * 对应 15 条 type='prompt' 的 GenerationRecord 全部成为零关联孤儿。
 *
 * 本文件钉死 record-first 改造语义（与 generateText / generateImage 主路径同构）：
 * 先建 generating 占位 → consume 带 record.id → 终态 update。
 */

const generatePromptFromUserInput = vi.fn()

vi.mock('@lnkpi/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lnkpi/agent')>()
  return {
    ...actual,
    generatePromptFromUserInput: vi.fn((...args: unknown[]) => generatePromptFromUserInput(...(args as []))),
  }
})

const platformResolved = {
  channelId: 'platform',
  modelName: 'deepseek-v4',
  apiFormat: 'openai' as const,
  credentials: { apiKey: 'plat-key', baseUrl: 'https://platform.example.com/v1' },
  source: 'platform' as const,
}

describe('StudioService.generatePrompt record-first（G3 缺口修复）', () => {
  let svc: StudioService
  let pointsConsume: ReturnType<typeof vi.fn>
  let pointsRefund: ReturnType<typeof vi.fn>
  let recordCreate: ReturnType<typeof vi.fn>
  let recordUpdate: ReturnType<typeof vi.fn>
  let recordDelete: ReturnType<typeof vi.fn>
  let createdIds: string[]

  beforeEach(async () => {
    vi.clearAllMocks()
    createdIds = []
    pointsConsume = vi.fn(async () => {})
    pointsRefund = vi.fn(async () => {})
    recordCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
      const id = `g${createdIds.length + 1}`
      createdIds.push(id)
      return { id, status: 'generating', createdAt: new Date(), ...args.data }
    })
    recordUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: args.where.id,
      ...args.data,
    }))
    recordDelete = vi.fn(async () => ({}))

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioService,
        { provide: PointsService, useValue: { consume: pointsConsume, refund: pointsRefund } },
        {
          provide: PrismaService,
          useValue: { generationRecord: { create: recordCreate, update: recordUpdate, delete: recordDelete } },
        },
        { provide: ProviderResolverService, useValue: { resolveForGeneration: vi.fn(async () => platformResolved) } },
        { provide: MediaProbeService, useValue: {} },
        { provide: UploadService, useValue: {} },
      ],
    }).compile()
    svc = moduleRef.get(StudioService)
  })

  it('成功路径：先建 generating 占位，consume 携带 record.id，终态 update completed（无第二次 create、无 refund）', async () => {
    generatePromptFromUserInput.mockResolvedValue({ mode: 'expand', content: '扩写后的提示词', visionUsed: false })

    const out = await svc.generatePrompt('u1', '一只猫')

    expect(recordCreate).toHaveBeenCalledTimes(1)
    expect(recordCreate.mock.calls[0][0].data.status).toBe('generating')

    expect(pointsConsume).toHaveBeenCalledTimes(1)
    const consumeMeta = pointsConsume.mock.calls[0]![3]
    const recordId = createdIds[0]!
    expect(consumeMeta.generationId).toBe(recordId)
    expect(consumeMeta.generationId).not.toBeNull()

    expect(recordUpdate).toHaveBeenCalledTimes(1)
    expect(recordUpdate.mock.calls[0][0].where.id).toBe(recordId)
    expect(recordUpdate.mock.calls[0][0].data.status).toBe('completed')
    expect(out.id).toBe(recordId)

    expect(recordDelete).not.toHaveBeenCalled()
    expect(pointsRefund).not.toHaveBeenCalled()
  })

  it('扣费失败（积分不足）：删除 generating 占位、异常传播、无 refund', async () => {
    generatePromptFromUserInput.mockResolvedValue({ mode: 'expand', content: 'x', visionUsed: false })
    pointsConsume.mockRejectedValueOnce(new Error('insufficient points'))

    await expect(svc.generatePrompt('u1', '一只猫')).rejects.toThrow('insufficient points')

    expect(recordCreate).toHaveBeenCalledTimes(1)
    expect(recordDelete).toHaveBeenCalledTimes(1)
    expect(recordDelete.mock.calls[0]![0].where.id).toBe(createdIds[0])
    expect(pointsRefund).not.toHaveBeenCalled()
    expect(recordUpdate).not.toHaveBeenCalled()
  })

  it('平台生成失败：refund 携带 record.id，record 终态 failed（不再后置 create failed）', async () => {
    generatePromptFromUserInput.mockRejectedValueOnce(new Error('upstream 500'))

    await expect(svc.generatePrompt('u1', '一只猫')).rejects.toThrow(/生成失败|upstream/)

    const recordId = createdIds[0]!
    expect(pointsRefund).toHaveBeenCalledTimes(1)
    const refundMeta = pointsRefund.mock.calls[0]![3]
    expect(refundMeta.generationId).toBe(recordId)

    expect(recordUpdate).toHaveBeenCalledTimes(1)
    expect(recordUpdate.mock.calls[0][0].where.id).toBe(recordId)
    expect(recordUpdate.mock.calls[0][0].data.status).toBe('failed')
    expect(recordCreate).toHaveBeenCalledTimes(1)
  })

  it('生成中取消：refund 携带 record.id，record 落终态（不悬挂 generating）', async () => {
    const cancel = { isCancelled: () => true }
    generatePromptFromUserInput.mockResolvedValue({ mode: 'expand', content: 'x', visionUsed: false })

    await expect(svc.generatePrompt('u1', '一只猫', undefined, cancel)).rejects.toThrow()

    const recordId = createdIds[0]!
    expect(pointsRefund).toHaveBeenCalledTimes(1)
    const refundMeta = pointsRefund.mock.calls[0]![3]
    expect(refundMeta.generationId).toBe(recordId)
    expect(refundMeta.status).toBe('cancelled_refund')

    const statuses = recordUpdate.mock.calls.map((c) => (c[0] as { data: { status: string } }).data.status)
    expect(statuses).not.toContain('completed')
    const lastUpdate = recordUpdate.mock.calls.at(-1)![0] as { data: { status: string } }
    expect(lastUpdate.data.status).not.toBe('generating')
  })
})
