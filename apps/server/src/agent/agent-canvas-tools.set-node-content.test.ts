import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
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

// P1-1（spec 2026-10-13 §P1-1）：媒体节点（image/video/audio）拒收 content 写入——
// 2026-10-12 事故（cmv51vwpu0008p801hxaxcf8m）里模型把皮克斯文本写进 image 节点的
// data.content，且旧实现顺带强制 status:'completed' 污染生成状态机。fail-closed：
// 把静默错写变成模型可自愈的显式报错（错误消息必须指引 prompt 参数）。
describe('setNodeContent —— 媒体节点拒收 content（P1-1）', () => {
  async function makeSvc(initial: CanvasData) {
    const sessionUpdate = vi.fn(async ({ data }: { data: { canvasData: string } }) => ({
      id: 's1',
      canvasData: data.canvasData,
    }))
    const sessionFindUnique = vi.fn(async () => ({ id: 's1', userId: 'u1', canvasData: JSON.stringify(initial) }))
    // persist() 走 $transaction(fn)，fn 收到 tx（含 session.findUnique/update）——对齐主测试文件形态
    const $transaction = vi.fn((fn: (tx: { session: { findUnique: unknown; update: unknown } }) => Promise<unknown>) =>
      fn({ session: { findUnique: sessionFindUnique, update: sessionUpdate } }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentCanvasToolsService,
        {
          provide: PrismaService,
          useValue: {
            session: { findUnique: sessionFindUnique, update: sessionUpdate },
            userAiPreferences: {
              findUnique: vi.fn(async () => ({
                userId: 'u1',
                defaultImageModel: 'platform::user-default-image',
                defaultVideoModel: 'platform::user-default-video',
                defaultTextModel: 'platform::user-default-text',
                defaultAudioModel: 'platform::user-default-audio',
                defaultImageAspect: '1:1',
                defaultImageResolution: '2K',
              })),
            },
            material: { findFirst: vi.fn(async () => null) },
            userWorkflowRecipe: { create: vi.fn() },
            $transaction,
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
            listGenerations: vi.fn(),
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
        { provide: PersistRemoteService, useValue: { persistRemote: vi.fn() } },
        { provide: ImageSliceService, useValue: { slice: vi.fn() } },
        { provide: ProviderService, useValue: { bootstrap: vi.fn() } },
      ],
    }).compile()
    const svc = moduleRef.get(AgentCanvasToolsService)
    return { svc, sessionUpdate }
  }

  it('image 节点 content 写入 → BadRequest，消息指引 prompt 参数', async () => {
    const { svc } = await makeSvc({
      nodes: [{ id: 'img-1', type: 'image', position: { x: 0, y: 0 }, data: { prompt: '旧提示词', status: 'completed' } }],
      edges: [],
    })
    await expect(
      svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'img-1', content: '皮克斯文本' }),
    ).rejects.toThrow(BadRequestException)
    await expect(
      svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'img-1', content: '皮克斯文本' }),
    ).rejects.toThrow(/prompt 参数/)
  })

  it('video 节点同样拒收（同族媒体）', async () => {
    const { svc } = await makeSvc({
      nodes: [{ id: 'vid-1', type: 'video', position: { x: 0, y: 0 }, data: { prompt: 'v' } }],
      edges: [],
    })
    await expect(
      svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'vid-1', content: 'x' }),
    ).rejects.toThrow(BadRequestException)
  })

  it('audio 节点同样拒收（同族媒体）', async () => {
    const { svc } = await makeSvc({
      nodes: [{ id: 'aud-1', type: 'audio', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    })
    await expect(
      svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'aud-1', content: 'x' }),
    ).rejects.toThrow(BadRequestException)
  })

  it('prompt（文本类）节点行为不变：content 照写 + status completed（既有语义不动）', async () => {
    const { svc, sessionUpdate } = await makeSvc({
      nodes: [{ id: 'p-1', type: 'prompt', position: { x: 0, y: 0 }, data: { content: '旧' } }],
      edges: [],
    })
    const out = await svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'p-1', content: '新正文' })
    expect(out.actions.some((a) => a.type === 'update_node')).toBe(true)
    const written = JSON.parse(sessionUpdate.mock.calls[0][0].data.canvasData) as CanvasData
    expect(written.nodes[0].data.content).toBe('新正文')
    expect(written.nodes[0].data.status).toBe('completed')
  })
})
