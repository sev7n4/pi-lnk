/**
 * D-1 L1 失效传播——server 侧单一写者接线契约（spec §6.2 / Review Focus 1-2）。
 *
 * 三个断言契约（验收线，不可省）：
 * 1. hash 不变 ⇒ 不写 stale（幂等，防抖动，spec §8.2-4）；
 * 2. hash 变化 ⇒ 下游闭包内节点 stale=true 且与 version 更新同事务；
 * 3. stale 只能由本路径写——不带 stale 的客户端式整份更新不抹掉 stale 语义，
 *    载荷显式携带 stale/contentHash/version 会被剥除（Review Focus 1，spec §11 风险 2）。
 *
 * mock/夹具形态对齐 agent-canvas-tools.service.test.ts 现行集成测试基建
 * （Test.createTestingModule + session findUnique/update mock + $transaction 串行链）。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { CanvasData } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { StudioService } from '../studio/studio.service'
import { MaterialService } from '../canvas/material.service'
import { PersistRemoteService } from '../assets/persist-remote.service'
import { ImageSliceService } from '../studio/image-slice.service'
import { VideoGenerationOrchestrator } from '../studio/video-generation.orchestrator'
import { ProviderService } from '../provider/provider.service'
import {
  AgentCanvasToolsService,
  computeNodeContentHash,
} from './agent-canvas-tools.service'

/** 3 节点链 A→B→C（C 的 data 为 null——Task 1 前任务指针的 null-data 兜底正例）。 */
const chainCanvas = (): CanvasData =>
  ({
    nodes: [
      { id: 'A', type: 'image', position: { x: 0, y: 0 }, data: { title: '母版', prompt: 'p0' } },
      { id: 'B', type: 'image', position: { x: 1, y: 0 }, data: { title: '下游B', prompt: 'b0' } },
      { id: 'C', type: 'image', position: { x: 2, y: 0 }, data: null },
    ],
    edges: [
      { id: 'e-A-B', source: 'A', target: 'B' },
      { id: 'e-B-C', source: 'B', target: 'C' },
    ],
  }) as CanvasData

describe('AgentCanvasToolsService 画布单一写者 L1 失效传播', () => {
  let svc: AgentCanvasToolsService
  let canvas: CanvasData
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    canvas = chainCanvas()
    sessionFindUnique.mockImplementation(async () => ({
      id: 's1',
      userId: 'u1',
      canvasData: JSON.stringify(canvas),
    }))
    sessionUpdate.mockImplementation(async ({ data }: { data: { canvasData: string } }) => {
      canvas = JSON.parse(data.canvasData) as CanvasData
      return { id: 's1', canvasData: data.canvasData }
    })

    let txChain: Promise<unknown> = Promise.resolve()
    const $transaction = (
      fn: (tx: {
        session: { findUnique: typeof sessionFindUnique; update: typeof sessionUpdate }
      }) => Promise<unknown>,
    ) => {
      const next = txChain.then(() =>
        fn({ session: { findUnique: sessionFindUnique, update: sessionUpdate } }),
      )
      txChain = next.catch(() => undefined)
      return next
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentCanvasToolsService,
        { provide: PrismaService, useValue: { session: { findUnique: sessionFindUnique, update: sessionUpdate }, $transaction } },
        { provide: StudioService, useValue: {} },
        { provide: VideoGenerationOrchestrator, useValue: {} },
        { provide: MaterialService, useValue: {} },
        { provide: PersistRemoteService, useValue: {} },
        { provide: ImageSliceService, useValue: {} },
        { provide: ProviderService, useValue: {} },
      ],
    }).compile()
    svc = moduleRef.get(AgentCanvasToolsService)
  })

  const nodeOf = (id: string) => canvas.nodes.find((n) => n.id === id)

  it('契约 2：hash 变化 ⇒ 下游闭包 stale=true，contentHash/version 与 stale 同一事务落库', async () => {
    await svc.setNodePrompt({ sessionId: 's1', nodeId: 'A', prompt: 'p1' })

    const a = nodeOf('A')
    const b = nodeOf('B')
    const c = nodeOf('C')
    // changed 节点：盖新 contentHash + version 自增，且重写即新鲜 ⇒ stale 清回 false
    expect(a?.data?.contentHash).toBe(computeNodeContentHash({ title: '母版', prompt: 'p1' }))
    expect(a?.data?.version).toBe(1)
    expect(a?.data?.stale).toBe(false)
    // 下游闭包（不含起点 A）：B、C stale=true；C 的 data 原为 null ⇒ 兜底成 { stale: true }，不抛错
    expect(b?.data?.stale).toBe(true)
    expect(c?.data).toEqual({ stale: true })
    // 上游/无关节点不受影响：B/C 自身不盖 contentHash/version
    expect(b?.data?.contentHash).toBeUndefined()
    expect(b?.data?.version).toBeUndefined()
    // 同事务：一次 persist = 一个事务 = 一条 session.update，stale 与 version 同在一份载荷里
    expect(sessionUpdate).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(
      (sessionUpdate.mock.calls[0][0] as { data: { canvasData: string } }).data.canvasData,
    ) as CanvasData
    const pa = persisted.nodes.find((n) => n.id === 'A')
    const pb = persisted.nodes.find((n) => n.id === 'B')
    expect(pa?.data?.version).toBe(1)
    expect(pb?.data?.stale).toBe(true)
  })

  it('契约 1：hash 不变 ⇒ 不写 stale、不 bump version（防抖动幂等，spec §8.2-4）', async () => {
    // A 预盖与当前内容一致的 contentHash ⇒ 本次保存哈希不变
    canvas = chainCanvas()
    const a0 = canvas.nodes.find((n) => n.id === 'A')
    a0!.data = {
      title: '母版',
      prompt: 'p0',
      contentHash: computeNodeContentHash({ title: '母版', prompt: 'p0' }),
      version: 3,
    }

    await svc.setNodePrompt({ sessionId: 's1', nodeId: 'A', prompt: 'p0' })

    const a = nodeOf('A')
    const b = nodeOf('B')
    const c = nodeOf('C')
    expect(b?.data?.stale).toBeUndefined()
    expect(c?.data?.stale).toBeUndefined()
    expect(a?.data?.version).toBe(3)
    expect(a?.data?.contentHash).toBe(computeNodeContentHash({ title: '母版', prompt: 'p0' }))
  })

  it('契约 3：stale 只能由本路径写——整份式更新不抹标记，载荷携带 server 专属字段被剥除', async () => {
    // B 预置与其内容一致的 contentHash ⇒ 后续 status-only 更新哈希不变、不构成重写
    // （否则 shouldPropagate「首次」语义会给 B 首次记账 hash，落入契约 6 的重写清 stale 通道）
    canvas = chainCanvas()
    const b0 = canvas.nodes.find((n) => n.id === 'B')
    b0!.data = {
      title: '下游B',
      prompt: 'b0',
      contentHash: computeNodeContentHash({ title: '下游B', prompt: 'b0' }),
    }

    await svc.setNodePrompt({ sessionId: 's1', nodeId: 'A', prompt: 'p1' })
    expect(nodeOf('B')?.data?.stale).toBe(true)

    // (a) 客户端式更新（整节点 patch、不带 stale）不得抹掉 stale 语义（浅合并保留）
    await svc.updateNodesBatch({ sessionId: 's1', items: [{ nodeId: 'B', patch: { status: 'completed' } }] })
    expect(nodeOf('B')?.data?.stale).toBe(true)
    expect(nodeOf('B')?.data?.status).toBe('completed')

    // (b) 载荷显式携带 stale:false / version:99 / contentHash:'fake' ⇒ 服务端剥除，
    //     stale/contentHash/version 不被传入值覆盖；合法字段照常合并
    const legitHash = nodeOf('A')?.data?.contentHash
    await svc.updateNodesBatch({
      sessionId: 's1',
      items: [
        {
          nodeId: 'A',
          patch: { stale: false, version: 99, contentHash: 'fake', status: 'completed' },
        },
      ],
    })
    const a = nodeOf('A')
    // A 在本用例第一步（setNodePrompt）被重写 ⇒ 已清为 stale:false；(b) 哈希不变
    // 不构成重写 ⇒ false 保持——传入的 stale:false 经剥除不参与，值来自重写语义
    expect(a?.data?.stale).toBe(false)
    expect(a?.data?.version).toBe(1)
    expect(a?.data?.contentHash).toBe(legitHash)
    expect(a?.data?.status).toBe('completed')
    // (c) 剥除后无内容字段变化 ⇒ 哈希不变 ⇒ 不再 bump version（防抖动）
    expect(a?.data?.contentHash).toBe(computeNodeContentHash({ title: '母版', prompt: 'p1' }))
  })

  it('契约 4（commitStage 同型接线）：staged 内容变更传播下游 stale；伪造 contentHash 被剥', async () => {
    // staged 载荷携带伪造 server 专属字段 + 改 B 的内容（B→C 边存在 ⇒ C 是 B 的下游）
    const staged = [
      {
        type: 'update_node',
        payload: { id: 'B', data: { prompt: 'b1', contentHash: 'fake', stale: false, version: 99 } },
      },
    ]
    sessionFindUnique.mockImplementation(async () => ({
      id: 's1',
      userId: 'u1',
      canvasData: JSON.stringify(canvas),
      stagedActions: JSON.stringify(staged),
      stagedAt: new Date(), // 新鲜 stagedAt ⇒ expireStaleStage 不清暂存区
    }))

    const { actions } = await svc.commitStage({ sessionId: 's1' })

    // 剥除发生在落库前：返回值（实际落地形态）不含 server 专属字段
    expect(actions).toHaveLength(1)
    const landed = (actions[0] as { payload: { data: Record<string, unknown> } }).payload.data
    expect(landed).toEqual({ prompt: 'b1' })
    // staged 内容变更算 hash：B 盖新 contentHash + version 自增；伪造值不落地；
    // 重写即新鲜 ⇒ stale 清回 false
    const b = nodeOf('B')
    expect(b?.data?.contentHash).toBe(computeNodeContentHash({ title: '下游B', prompt: 'b1' }))
    expect(b?.data?.version).toBe(1)
    expect(b?.data?.stale).toBe(false)
    // 同一事务传播：下游 C stale=true（同一条 tx.session.update，见同事务断言）
    expect(nodeOf('C')?.data?.stale).toBe(true)
    expect(sessionUpdate).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(
      (sessionUpdate.mock.calls[0][0] as { data: { canvasData: string } }).data.canvasData,
    ) as CanvasData
    const pb = persisted.nodes.find((n) => n.id === 'B')
    const pc = persisted.nodes.find((n) => n.id === 'C')
    expect(pb?.data?.version).toBe(1)
    expect(pc?.data?.stale).toBe(true)
  })

  it('契约 5（多 action 批次）：changedNodeIds 对账——每个被改节点的下游进闭包，changed 节点本身不标 stale', async () => {
    // 单次 persist、两条 update_node 作用于 A、B 两个节点
    await svc.updateNodesBatch({
      sessionId: 's1',
      items: [
        { nodeId: 'A', patch: { prompt: 'a-new' } },
        { nodeId: 'B', patch: { prompt: 'b-new' } },
      ],
    })
    // changed 集合 {A,B}：各自盖 hash + version + stale:false；A→B 使 B 理论上是 A 的下游，
    // 但 B 属 changed 起点 ⇒ 不进下游闭包（verbatim 闭包语义：本事务刚重写的节点
    // 不标 stale，且显式清回 false——重写即新鲜）
    const a = nodeOf('A')
    const b = nodeOf('B')
    expect(a?.data?.contentHash).toBe(computeNodeContentHash({ title: '母版', prompt: 'a-new' }))
    expect(a?.data?.version).toBe(1)
    expect(a?.data?.stale).toBe(false)
    expect(b?.data?.contentHash).toBe(computeNodeContentHash({ title: '下游B', prompt: 'b-new' }))
    expect(b?.data?.version).toBe(1)
    expect(b?.data?.stale).toBe(false)
    // 两个 changed 节点的下游并集 = {C}，C 只落一份 stale（闭包去重）
    expect(nodeOf('C')?.data?.stale).toBe(true)
    // 单事务单写点：两条 action 同一 tx.session.update 落库
    expect(sessionUpdate).toHaveBeenCalledTimes(1)
  })

  it('契约 6（重写清 stale）：同一节点先被标 stale、后内容重写 ⇒ 该节点 stale 清回 false 且下游标 true', async () => {
    // 第一步：改 A ⇒ 下游 B 被标 stale=true（失效传播）
    await svc.setNodePrompt({ sessionId: 's1', nodeId: 'A', prompt: 'p1' })
    expect(nodeOf('B')?.data?.stale).toBe(true)

    // 第二步：重写 B 的内容（prompt 变化 ⇒ hash 变化）⇒ B 是本次重写的新鲜品：
    // 拿到新 contentHash/version，自身 stale 清回 false（不再是被动的陈旧品）
    await svc.updateNodesBatch({ sessionId: 's1', items: [{ nodeId: 'B', patch: { prompt: 'b1' } }] })
    const b = nodeOf('B')
    expect(b?.data?.stale).toBe(false)
    expect(b?.data?.contentHash).toBe(computeNodeContentHash({ title: '下游B', prompt: 'b1' }))
    expect(b?.data?.version).toBe(1)
    // 下游闭包照常传播：C stale=true
    expect(nodeOf('C')?.data?.stale).toBe(true)
  })
})
