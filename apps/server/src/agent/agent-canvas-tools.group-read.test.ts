/**
 * 服务端分组读链路的守卫（2026-10-21）。
 *
 * ⭐ 核心命题：**Agent 必须能拿到 group_id 与组颜色**。
 * 背景：分组 id 由**前端**生成（`group-${Date.now().toString(36)}`），
 * 而 `canvas_command` 是单向 SSE 下发、**无回传通道** ⇒ Agent 建组后
 * 自己算不出 id ⇒ 想改色/解组就只能先「读」一次画布。
 * 读入口必须落在**常驻**工具上（`get_canvas_summary`）——`get_canvas_layout`
 * 在延迟集，tool_search 触发率实测为 0，依赖它等于把链路挂在实测走不通的路径上。
 *
 * 覆盖：
 *  1. `getCanvasSummary` 必须返回 groups（含 id / title / colorKey / childIds）；
 *  2. 焦点过滤**不得**过滤掉 groups（分组是跨节点整体，被滤掉就找不到目标组）；
 *  3. `summarizeGroups` 必须带 colorKey（此前只返回 {id,title,childIds}
 *     ⇒ Agent 读得到「有哪些组」却读不到「组是什么颜色」）。
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
import { summarizeGroups } from './canvas-layout.util'

describe('服务端分组读链路（Agent 拿 group_id 与组色）', () => {
  let svc: AgentCanvasToolsService
  let canvas: CanvasData
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
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
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentCanvasToolsService,
        {
          provide: PrismaService,
          useValue: {
            session: { findUnique: sessionFindUnique, update: sessionUpdate },
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
            cancelGeneration: vi.fn(),
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
            cancelGeneration: vi.fn(),
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

  it('⭐ getCanvasSummary 返回 groups（含 id / title / colorKey / childIds）', async () => {
    canvas = {
      nodes: [],
      edges: [],
      groups: [
        {
          id: 'group-abc',
          title: '素材组',
          colorKey: 'moss',
          childIds: ['n1', 'n2'],
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
        },
      ],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect(Array.isArray(res.groups)).toBe(true)
    expect(res.groups).toHaveLength(1)
    expect(res.groups[0]).toMatchObject({
      id: 'group-abc',
      title: '素材组',
      colorKey: 'moss',
      childIds: ['n1', 'n2'],
    })
  })

  it('无分组时返回空数组（不是 undefined ⇒ 工具侧不用防 undefined）', async () => {
    const res = await svc.getCanvasSummary({ sessionId: 's1' })
    expect(res.groups).toEqual([])
  })

  it('⭐ 焦点过滤不得过滤掉 groups（分组是跨节点整体，滤掉就找不到目标组）', async () => {
    // 造 40 个节点（超过 CANVAS_SUMMARY_FULL_LIMIT=30）触发焦点过滤
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      type: 'image',
      position: { x: i * 10, y: 0 },
      data: {},
    }))
    canvas = {
      nodes,
      edges: [],
      groups: [
        {
          id: 'group-far',
          title: '远处的组',
          colorKey: 'rose',
          childIds: ['n35', 'n36'],
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
        },
      ],
    } as unknown as CanvasData
    const res = await svc.getCanvasSummary({ sessionId: 's1', focusNodeId: 'n0' })
    // 节点被聚焦过滤了（只留邻域）
    expect(res.nodes.length).toBeLessThan(40)
    // 但 groups 必须仍在
    expect(res.groups).toHaveLength(1)
    expect(res.groups[0]!.id).toBe('group-far')
  })

  it('⭐ summarizeGroups 必须带 colorKey（Agent 要知道组是什么颜色）', () => {
    const out = summarizeGroups([
      {
        id: 'g1',
        title: '组一',
        colorKey: 'clay',
        childIds: ['a', 'b'],
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
      },
    ])
    expect(out[0]).toMatchObject({ id: 'g1', title: '组一', colorKey: 'clay', childIds: ['a', 'b'] })
  })

  it('无 colorKey 的组不输出该字段（缺省 = 中性灰，不是 neutral 显式值）', () => {
    const out = summarizeGroups([
      {
        id: 'g1',
        title: '组一',
        childIds: ['a'],
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
      },
    ])
    expect(out[0]!.colorKey).toBeUndefined()
    expect('colorKey' in out[0]!).toBe(false)
  })
})
