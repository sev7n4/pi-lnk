import 'reflect-metadata'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
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
 * P1-D（spec 2026-11-02-p1d-approval-tiering-design）：审批分级用例——
 * - 判定权在服务端 SSOT（env 白名单），agent/客户端不可传入；
 * - v1 白名单仅 text 通道生效（其他介质配置不生效，保守）；
 * - auto 路径：epoch+1 落节点（不带 status，不产生 pending_confirm）→ 直调
 *   start-text 同一函数（P0-1 dedup + epoch 断言 + 锚点纪律全复用）；
 * - GENERATION_AUTO_APPROVE='' ⇒ 全人工（部署级回滚开关）。
 *
 * 只走 tier 判定 + epoch/dedup 路径；runTextGeneration 为 fire-and-forget，
 * studio mock 返回 undefined 使管线内部立即失败并被 catch 吞掉（无副作用）。
 */
describe('AgentCanvasToolsService approval tier（P1-D）', () => {
  let svc: AgentCanvasToolsService
  let canvas: CanvasData
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()
  const prefsFindUnique = vi.fn()
  const persistRemote = vi.fn()
  const savedEnv = process.env.GENERATION_AUTO_APPROVE

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GENERATION_AUTO_APPROVE
    else process.env.GENERATION_AUTO_APPROVE = savedEnv
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    delete process.env.GENERATION_AUTO_APPROVE
    canvas = { nodes: [], edges: [] }
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

  const mediaNode = (type: string, data: Record<string, unknown>) => {
    canvas = {
      nodes: [
        { id: 'n-1', type, position: { x: 0, y: 0 }, data: { prompt: '测试 prompt', ...data } },
      ],
      edges: [],
    }
  }

  it('text 节点 + 缺省 env ⇒ auto：返回 generating+autoApproved，节点不落 pending_confirm', async () => {
    mediaNode('text', { status: 'draft' })

    const res = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'n-1' })
    if (!('autoApproved' in res) || res.autoApproved !== true) {
      throw new Error(`text propose 应走 auto，实际: ${JSON.stringify(res)}`)
    }
    expect(res.status).toBe('generating')
    expect(res.nodeId).toBe('n-1')
    // epoch 已落节点（「重提即纪元」不变式），且不产生 pending_confirm（C0 守卫面零接触）
    expect(canvas.nodes[0]?.data?.proposalEpoch).toBe(1)
    expect(canvas.nodes[0]?.data?.status).not.toBe('pending_confirm')
  })

  it('auto 后手动 start-text 携带同纪元 ⇒ 不 409（epoch 断言贯通）', async () => {
    mediaNode('text', { status: 'draft' })
    const res = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'n-1' })
    if (!('autoApproved' in res)) throw new Error('应走 auto')

    const again = await svc.startTextGeneration({
      sessionId: 's1',
      userId: 'u1',
      nodeId: 'n-1',
      proposalEpoch: 1,
    })
    expect(again.status).toBe('generating')
  })

  it('image/video/audio ⇒ 人工确认（pending_confirm 原样，白名单外零回归）', async () => {
    for (const type of ['image', 'video', 'audio']) {
      mediaNode(type, { status: 'draft' })
      const res = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'n-1' })
      if (!('summary' in res)) throw new Error(`${type} 应走人工 propose`)
      expect(res.status).toBe('pending_confirm')
      expect(res.summary.proposalEpoch).toBe(1)
      expect(canvas.nodes[0]?.data).toMatchObject({ status: 'pending_confirm', proposalEpoch: 1 })
    }
  })

  it('GENERATION_AUTO_APPROVE=\'\' ⇒ 全人工（部署级回滚开关）', async () => {
    process.env.GENERATION_AUTO_APPROVE = ''
    mediaNode('text', { status: 'draft' })

    const res = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'n-1' })
    if (!('summary' in res)) throw new Error('置空白名单后 text 应走人工')
    expect(res.status).toBe('pending_confirm')
  })

  it('GENERATION_AUTO_APPROVE=text,image ⇒ image 仍人工（v1 仅实现 text 通道，保守）', async () => {
    process.env.GENERATION_AUTO_APPROVE = 'text,image'
    mediaNode('image', { status: 'draft' })

    const res = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'n-1' })
    if (!('summary' in res)) throw new Error('image 应走人工 propose')
    expect(res.status).toBe('pending_confirm')
  })

  it('auto 重复 propose（重提）⇒ epoch 继续递增（重提语义不变）', async () => {
    mediaNode('text', { status: 'draft' })
    const first = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'n-1' })
    if (!('autoApproved' in first)) throw new Error('first 应走 auto')

    const second = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'n-1' })
    if (!('autoApproved' in second)) throw new Error('second 应走 auto')
    expect(canvas.nodes[0]?.data?.proposalEpoch).toBe(2)
  })
})
