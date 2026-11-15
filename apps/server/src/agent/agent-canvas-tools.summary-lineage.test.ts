/**
 * D-1 L3（spec §5.1）：get_canvas_summary 只读派生字段守卫。
 *
 * ⭐ 核心命题：Agent 必须能从**常驻读工具**上看到「哪些下游失效了 + 资产血缘」，
 * 而不用新增任何工具/事件（零新增工具、零新增事件）。
 * 派生是纯读：stale 闭包在写路径 applyStalePropagation 已完成，读路径直读
 * data.stale 字段，不遍历边、不调 downstreamClosure。
 *
 * 覆盖：
 *  1. 画布含 stale 节点 ⇒ response 带 staleNodeIds + lineage 条目；
 *  2. 带 assetId/version 但未 stale ⇒ 只有 lineage，staleNodeIds 缺省；
 *  3. 无 stale / 无资产字段 ⇒ **两个键都缺省**（不加空数组——A-3「缺省键
 *     不出现」纪律，本文件的验收线）；
 *  4. lineage 条目内缺省键不出现（data 没有的字段不写进条目）；
 *  5. data 缺失/垃圾的存量节点 ⇒ 读链路不炸、不产生条目。
 */
import 'reflect-metadata'
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

describe('get_canvas_summary 只读派生（D-1 L3 staleNodeIds / lineage）', () => {
  let svc: AgentCanvasToolsService
  let canvas: CanvasData
  const sessionFindUnique = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    canvas = { nodes: [], edges: [] }
    sessionFindUnique.mockImplementation(async () => ({
      id: 's1',
      userId: 'u1',
      canvasData: JSON.stringify(canvas),
    }))
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentCanvasToolsService,
        {
          provide: PrismaService,
          useValue: {
            session: { findUnique: sessionFindUnique, update: vi.fn() },
            userAiPreferences: { findUnique: vi.fn() },
            material: { findFirst: vi.fn() },
            userWorkflowRecipe: { create: vi.fn() },
            $transaction: vi.fn(),
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
            listGenerations: vi.fn(),
          },
        },
        VideoGenerationOrchestrator,
        {
          provide: MaterialService,
          useValue: {
            cancelGeneration: vi.fn(),
            getGenerationDiagnostic: vi.fn(),
            confirmPlatformFallback: vi.fn(),
          },
        },
        { provide: PersistRemoteService, useValue: { persistRemote: vi.fn() } },
        { provide: ImageSliceService, useValue: { sliceImage: vi.fn() } },
        { provide: ProviderService, useValue: { bootstrap: vi.fn() } },
      ],
    }).compile()
    svc = moduleRef.get(AgentCanvasToolsService)
    svc.pollIntervalMs = 1
    svc.pollTimeoutMs = 50
  })

  it('⭐ 画布含 stale 节点 ⇒ staleNodeIds 带 id + lineage 有条目（stale: true）', async () => {
    canvas = {
      nodes: [
        { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { title: '上游', contentHash: 'a'.repeat(64), version: 3 } },
        { id: 'n2', type: 'image', position: { x: 1, y: 0 }, data: { stale: true } },
        { id: 'n3', type: 'image', position: { x: 2, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect(res.staleNodeIds).toEqual(['n2'])
    expect(res.lineage).toHaveLength(2)
    expect(res.lineage).toContainEqual({ nodeId: 'n1', version: 3 })
    expect(res.lineage).toContainEqual({ nodeId: 'n2', stale: true })
  })

  it('带 assetId/version 但未 stale ⇒ 只有 lineage，staleNodeIds 键缺省', async () => {
    canvas = {
      nodes: [
        { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { assetId: 'char-hero', version: 2 } },
      ],
      edges: [],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect(res.lineage).toEqual([{ nodeId: 'n1', assetId: 'char-hero', version: 2 }])
    // 验收线：缺省键不出现（不是空数组）
    expect('staleNodeIds' in res).toBe(false)
  })

  it('⭐⭐ 无 stale / 无资产字段 ⇒ staleNodeIds 与 lineage 两个键都缺省（A-3 验收线）', async () => {
    canvas = {
      nodes: [
        { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { title: '普通节点', status: 'completed' } },
        { id: 'n2', type: 'image', position: { x: 1, y: 0 }, data: {} },
      ],
      edges: [],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect('staleNodeIds' in res).toBe(false)
    expect('lineage' in res).toBe(false)
    // 其余既有字段不受影响
    expect(res.nodes).toHaveLength(2)
    expect(res.groups).toEqual([])
  })

  it('lineage 条目缺省键不出现（data 只有 stale ⇒ 条目无 assetId/version 键）', async () => {
    canvas = {
      nodes: [
        { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { stale: true } },
      ],
      edges: [],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect(res.lineage).toHaveLength(1)
    const entry = res.lineage![0]!
    expect(entry).toEqual({ nodeId: 'n1', stale: true })
    expect('assetId' in entry).toBe(false)
    expect('version' in entry).toBe(false)
  })

  it('stale 显式 false 不算失效、不产生条目（缺省 = 非 stale）', async () => {
    canvas = {
      nodes: [
        { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { stale: false } },
      ],
      edges: [],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect('staleNodeIds' in res).toBe(false)
    expect('lineage' in res).toBe(false)
  })

  it('data 缺失/垃圾的存量节点 ⇒ 读链路不炸、不产生条目', async () => {
    canvas = {
      nodes: [
        { id: 'n1', type: 'image', position: { x: 0, y: 0 } }, // 无 data
        { id: 'n2', type: 'image', position: { x: 1, y: 0 }, data: 'garbage' }, // data 非对象
        { id: 'n3', type: 'image', position: { x: 2, y: 0 }, data: { stale: true, assetId: 'prop-lamp', version: 5 } },
      ],
      edges: [],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect(res.staleNodeIds).toEqual(['n3'])
    expect(res.lineage).toEqual([{ nodeId: 'n3', assetId: 'prop-lamp', version: 5, stale: true }])
  })

  it('staleNodeIds/lineage 恒为全画布派生（不被焦点过滤——跨节点整体事实，同 groups）', async () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      type: 'image',
      position: { x: i * 10, y: 0 },
      data: i === 39 ? { stale: true } : {},
    }))
    canvas = { nodes, edges: [] } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1', focusNodeId: 'n0' })
    // 节点列表被焦点过滤（邻域外 n39 不在 nodes 里）
    expect(res.nodes.length).toBeLessThan(40)
    // 但派生字段是全画布口径：n39 的失效依然可见
    expect(res.staleNodeIds).toEqual(['n39'])
    expect(res.lineage).toEqual([{ nodeId: 'n39', stale: true }])
  })
})
