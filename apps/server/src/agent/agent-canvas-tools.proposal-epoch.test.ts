import 'reflect-metadata'
import { ConflictException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { CanvasData } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { PersistRemoteService } from '../assets/persist-remote.service'
import { StudioService } from '../studio/studio.service'
import { ImageSliceService } from '../studio/image-slice.service'
import { VideoGenerationOrchestrator } from '../studio/video-generation.orchestrator'
import { MaterialService } from '../canvas/material.service'
import { ProviderService } from '../provider/provider.service'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'

/**
 * P1-B B6（spec 2026-11-01-p1b-generation-job-design §4.1 幂等/epoch）：
 * proposalEpoch 判据用例——
 * - B6 判据①：撤回重提后迟到确认被拒（epoch 校验 409）；
 * - B6 判据②：正常二次确认走幂等去重不误拒（deduped）。
 *
 * 全部用例只走 epoch 校验 + P0-1 dedup 路径，不触发 studio 真管线。
 */
describe('AgentCanvasToolsService proposalEpoch（P1-B B6）', () => {
  let svc: AgentCanvasToolsService
  let canvas: CanvasData
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()
  const prefsFindUnique = vi.fn()
  const persistRemote = vi.fn()

  const emptyCanvas = (): CanvasData => ({ nodes: [], edges: [] })

  beforeEach(async () => {
    vi.clearAllMocks()
    canvas = emptyCanvas()
    sessionFindUnique.mockImplementation(async () => ({
      id: 's1',
      userId: 'u1',
      canvasData: JSON.stringify(canvas),
    }))
    sessionUpdate.mockImplementation(async ({ data }: { data: { canvasData: string } }) => {
      canvas = JSON.parse(data.canvasData) as CanvasData
      return { id: 's1', canvasData: data.canvasData }
    })
    prefsFindUnique.mockResolvedValue({
      userId: 'u1',
      defaultImageModel: 'platform::seedream-5.0-pro',
      defaultVideoModel: 'platform::agnes-video-v2.0',
      defaultTextModel: 'platform::agnes-2.0-flash',
      defaultAudioModel: 'platform::minimax-speech-2.8-hd',
    })
    persistRemote.mockResolvedValue(undefined)

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentCanvasToolsService,
        {
          provide: PrismaService,
          useValue: {
            session: { findUnique: sessionFindUnique, update: sessionUpdate },
            userAiPreferences: { findUnique: prefsFindUnique },
            material: { findFirst: vi.fn().mockResolvedValue(null) },
            userWorkflowRecipe: { create: vi.fn() },
            $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
              fn({ session: { findUnique: sessionFindUnique, update: sessionUpdate } }),
          },
        },
        {
          provide: StudioService,
          useValue: {
            generateImage: vi.fn(),
            generateVideo: vi.fn(),
            generateText: vi.fn(),
            generateAudio: vi.fn(),
            getGeneration: vi.fn(),
            expandPromptContent: vi.fn(),
            cancelGeneration: vi.fn(),
            getGenerationDiagnostic: vi.fn(),
            confirmPlatformFallback: vi.fn(),
            cancelPlatformFallback: vi.fn(),
            listGenerations: vi.fn().mockResolvedValue([]),
          },
        },
        VideoGenerationOrchestrator,
        {
          provide: MaterialService,
          useValue: {
            cancelGeneration: vi.fn(),
            getMaterialDiagnostic: vi.fn(),
            confirmPlatformFallback: vi.fn(),
            cancelPlatformFallback: vi.fn(),
          },
        },
        { provide: PersistRemoteService, useValue: { persistRemote } },
        { provide: ImageSliceService, useValue: { slice: vi.fn() } },
        {
          provide: ProviderService,
          useValue: { bootstrap: vi.fn().mockResolvedValue({ channels: [] }) },
        },
      ],
    }).compile()
    svc = moduleRef.get(AgentCanvasToolsService)
    svc.pollIntervalMs = 1
    svc.pollTimeoutMs = 50
  })

  const imageNode = (data: Record<string, unknown>) => {
    canvas = {
      nodes: [
        {
          id: 'img-1',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { prompt: '白底图', ...data },
        },
      ],
      edges: [],
    }
  }

  it('proposeGeneration 每次重提递增 proposalEpoch（写入节点 + summary 带回）', async () => {
    imageNode({ status: 'draft' })

    const first = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' })
    if (!('summary' in first)) throw new Error('first propose 应成功')
    expect(first.summary.proposalEpoch).toBe(1)
    expect(
      canvas.nodes[0]?.data,
    ).toMatchObject({ status: 'pending_confirm', proposalEpoch: 1 })

    // 模拟撤回重提：clear 后再 propose（epoch 只在 propose 时 +1）
    canvas = {
      ...canvas,
      nodes: [{ ...canvas.nodes[0]!, data: { ...canvas.nodes[0]!.data, status: 'draft' } }],
    }
    const second = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' })
    if (!('summary' in second)) throw new Error('second propose 应成功')
    expect(second.summary.proposalEpoch).toBe(2)
    expect(canvas.nodes[0]?.data).toMatchObject({ status: 'pending_confirm', proposalEpoch: 2 })
  })

  it('迟到确认被拒：start 请求 epoch 落后于节点 ⇒ 409（四类入口全覆盖）', async () => {
    imageNode({ status: 'pending_confirm', proposalEpoch: 2 })

    await expect(
      svc.startImageGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1', proposalEpoch: 1 }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      svc.startVideoGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1', proposalEpoch: 1 }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      svc.startTextGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1', proposalEpoch: 1 }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      svc.startAudioGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1', proposalEpoch: 1 }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('epoch 相等 + generating ⇒ P0-1 deduped 直返（不误拒）', async () => {
    imageNode({ status: 'generating', generationRecordId: 'rec-live', proposalEpoch: 3 })

    const again = await svc.startImageGeneration({
      sessionId: 's1',
      userId: 'u1',
      nodeId: 'img-1',
      proposalEpoch: 3,
    })
    expect(again.deduped).toBe(true)
    expect(again.generationRecordId).toBe('rec-live')
  })

  it('请求缺省 epoch ⇒ 跳过校验（手动生成 / run_* / 老客户端兼容）', async () => {
    imageNode({ status: 'generating', generationRecordId: 'rec-live', proposalEpoch: 5 })

    const res = await svc.startImageGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' })
    expect(res.deduped).toBe(true)
    expect(res.generationRecordId).toBe('rec-live')
  })

  it('存量节点无 epoch ⇒ 宽容放行', async () => {
    imageNode({ status: 'generating', generationRecordId: 'rec-legacy' })

    const res = await svc.startImageGeneration({
      sessionId: 's1',
      userId: 'u1',
      nodeId: 'img-1',
      proposalEpoch: 9,
    })
    expect(res.deduped).toBe(true)
    expect(res.generationRecordId).toBe('rec-legacy')
  })

// ── B1 生成中守卫（2026-11-02 老黄牛死循环护栏，RCA v2 §4-B1 / §5 验收 2）────
describe('AgentCanvasToolsService proposeGeneration 生成中守卫（B1）', () => {
  it('generating 节点 propose ⇒ 409 且文案含行动指令（事故形态：重提议盖掉 generating）', async () => {
    imageNode({ status: 'generating', generationRecordId: 'rec-live' })
    await expect(
      svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' }),
    ).rejects.toThrow(/已有生成在跑/)
    await expect(
      svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' }),
    ).rejects.toThrow(ConflictException)
    // 画布状态绝不能被改写（守卫必须在落库前拒绝）
    expect(canvas.nodes[0]!.data.status).toBe('generating')
  })

  it('fallback_pending 节点 propose ⇒ 409', async () => {
    imageNode({ status: 'fallback_pending' })
    await expect(
      svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('completed 节点 propose ⇒ 放行（合法重生成，epoch+1 落 pending_confirm）', async () => {
    imageNode({ status: 'completed', generationRecordId: 'rec-old' })
    const res = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' })
    if (!('summary' in res)) throw new Error('completed 重提议应放行')
    expect(res.summary.proposalEpoch).toBe(1)
    expect(canvas.nodes[0]?.data).toMatchObject({ status: 'pending_confirm' })
  })
})
})
