// apps/server/src/agent/agent-canvas-tools.asset-snapshot.test.ts
import 'reflect-metadata'
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import {
  AgentCanvasToolsController,
  GetAssetContractSnapshotDto,
} from './agent-canvas-tools.controller'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'

/**
 * D-1：资产契约快照 internal 端点（fix round 1 裁决口径，spec §6.1 落地决定）。
 * 判据输入全部来自服务端结构化字段（禁采信模型自报 #815）：
 * 1. registeredIds：节点 data.assetId（parseAssetNodeData 解析；strict 解析失败时降级
 *    L1 computeNodeContentHash 同款直接字段读取——真实节点 data 混业务键是常态）；
 * 2. referencedIds：Shot.pinnedAssetId（非空）∪ 节点 data.derivedFrom，去重；
 *    只做结构化字段，不做文本级引用提取（limitations 透出）；
 * 3. authorities：Material.status ∈ MaterialStatus 闭集（idle|generating|completed|
 *    failed|fallback_pending）——「已验收」映射到唯一生产终态成功值 'completed'
 *    （createFromAgent 缺省值、生成成功回调落值；failed/fallback_pending 非验收）；
 *    pinned = entry.pinnedVersion 存在；未解析 metadata 的素材跳过；
 * 4. durationRows：全部 Shot {shotId, durationMs}；dialogueChars 无结构化源 ⇒ 缺省不造数
 *    （client 组装边界归 missing ⇒ durationBudget fail-closed，dialogue 源留 follow-up）。
 * 测试基建照 agent-canvas-tools.parse-canvas.test.ts（fake PrismaService 直构造 service）。
 */

interface FakeShot {
  id: string
  durationMs: number | null
  pinnedAssetId: string | null
  materials: Array<{ id: string; status: string; metadata: string | null }>
}

function makeService(canvasNodes: unknown[], shots: FakeShot[], canvasData?: string) {
  const sessionFindUnique = vi.fn(async () => ({
    id: 's1',
    userId: 'u1',
    canvasData: canvasData ?? JSON.stringify({ nodes: canvasNodes, edges: [] }),
  }))
  const shotFindMany = vi.fn(async () => shots)
  const svc = new AgentCanvasToolsService(
    {
      session: { findUnique: sessionFindUnique },
      shot: { findMany: shotFindMany },
    } as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { svc, sessionFindUnique, shotFindMany }
}

const SNAPSHOT_NODE = { id: 'n1', type: 'text', position: { x: 0, y: 0 } }

describe('getAssetContractSnapshot 派生口径（裁决四条）', () => {
  it('① registeredIds：data.assetId 节点计入；混合业务键 data（strict 解析失败）降级直接字段读取仍计入；无 assetId / 无 data 存量节点不计入；字段类型垃圾 ⇒ skippedNodes', async () => {
    const { svc } = makeService(
      [
        { ...SNAPSHOT_NODE, id: 'n-a', data: { assetId: 'hero' } }, // strict parse ok
        { ...SNAPSHOT_NODE, id: 'n-mixed', data: { assetId: 'scene-1', prompt: '茶馆' } }, // 混合键 ⇒ 降级读取
        { ...SNAPSHOT_NODE, id: 'n-empty', data: {} }, // 无 assetId ⇒ 不计入
        { ...SNAPSHOT_NODE, id: 'n-none' }, // 无 data ⇒ 不计入（存量常态）
        { ...SNAPSHOT_NODE, id: 'n-bad', data: { assetId: 42 } }, // 类型垃圾 ⇒ skippedNodes
        { ...SNAPSHOT_NODE, id: 'n-junk', data: 'oops' }, // data 非对象 ⇒ skippedNodes
      ],
      [],
    )
    const r = await svc.getAssetContractSnapshot({ sessionId: 's1' })
    expect(r.registeredIds.sort()).toEqual(['hero', 'scene-1'])
    expect(r.skippedNodes).toBe(2)
    expect(r.limitations).toEqual(['text-references-not-derived'])
  })

  it('② referencedIds：Shot.pinnedAssetId（非空）∪ 节点 data.derivedFrom，去重；pinnedAssetId null/空串不计', async () => {
    const { svc } = makeService(
      [
        { ...SNAPSHOT_NODE, data: { derivedFrom: 'asset-d1' } },
        { ...SNAPSHOT_NODE, id: 'n2', data: { derivedFrom: 'asset-d1' } }, // 重复 ⇒ 去重
        { ...SNAPSHOT_NODE, id: 'n3', data: { derivedFrom: 7 } }, // 类型垃圾 ⇒ skippedNodes
      ],
      [
        { id: 'shot-1', durationMs: null, pinnedAssetId: 'asset-p1', materials: [] },
        { id: 'shot-2', durationMs: null, pinnedAssetId: null, materials: [] },
        { id: 'shot-3', durationMs: null, pinnedAssetId: '', materials: [] },
      ],
    )
    const r = await svc.getAssetContractSnapshot({ sessionId: 's1' })
    expect(r.referencedIds.sort()).toEqual(['asset-d1', 'asset-p1'])
    expect(r.skippedNodes).toBe(1)
  })

  it('③ authorities：accepted 映射 status==="completed"（唯一生产终态成功值），pinned=pinnedVersion 存在；未解析 metadata 跳过；null/空 metadata 无 authority', async () => {
    const authority = (pinnedVersion?: number) =>
      JSON.stringify({ authority: { face: { level: 'primary', ...(pinnedVersion !== undefined ? { pinnedVersion } : {}) } } })
    const { svc } = makeService(
      [],
      [
        // 已验收 + 已钉版 ⇒ accepted:true pinned:true
        { id: 'shot-1', durationMs: null, pinnedAssetId: null, materials: [{ id: 'm1', status: 'completed', metadata: authority(2) }] },
        // generating（生成中）⇒ accepted:false（同闭集内 failed/fallback_pending 语义相同）
        { id: 'shot-2', durationMs: null, pinnedAssetId: null, materials: [{ id: 'm2', status: 'generating', metadata: authority(3) }] },
        // 已验收但未钉版 ⇒ pinned:false
        { id: 'shot-3', durationMs: null, pinnedAssetId: null, materials: [{ id: 'm3', status: 'completed', metadata: authority() }] },
        // 未解析 metadata（非法 JSON）⇒ 整个素材跳过
        { id: 'shot-4', durationMs: null, pinnedAssetId: null, materials: [{ id: 'm4', status: 'completed', metadata: '{not-json' }] },
        // metadata null / 空对象 ⇒ 无 authority 键 ⇒ 不产生条目
        { id: 'shot-5', durationMs: null, pinnedAssetId: null, materials: [{ id: 'm5', status: 'completed', metadata: null }, { id: 'm6', status: 'completed', metadata: '{}' }] },
      ],
    )
    const r = await svc.getAssetContractSnapshot({ sessionId: 's1' })
    expect(r.authorities).toEqual([
      { dimension: 'face', materialId: 'm1', accepted: true, pinned: true },
      { dimension: 'face', materialId: 'm2', accepted: false, pinned: true },
      { dimension: 'face', materialId: 'm3', accepted: true, pinned: false },
    ])
  })

  it('④ durationRows：全部 Shot {shotId, durationMs}；durationMs null ⇒ 键省略；dialogueChars 恒缺省（不造数）', async () => {
    const { svc } = makeService(
      [],
      [
        { id: 'shot-1', durationMs: 2000, pinnedAssetId: null, materials: [] },
        { id: 'shot-2', durationMs: null, pinnedAssetId: null, materials: [] },
      ],
    )
    const r = await svc.getAssetContractSnapshot({ sessionId: 's1' })
    expect(r.durationRows).toEqual([
      { shotId: 'shot-1', durationMs: 2000 },
      { shotId: 'shot-2' },
    ])
    expect(r.durationRows.every((row) => !('dialogueChars' in row))).toBe(true)
  })

  it('边界：空画布 + 空 shots ⇒ 四集合全空、skippedNodes 0；响应仍带 skippedNodes/limitations', async () => {
    const { svc } = makeService([], [])
    const r = await svc.getAssetContractSnapshot({ sessionId: 's1' })
    expect(r).toEqual({
      registeredIds: [],
      referencedIds: [],
      authorities: [],
      durationRows: [],
      skippedNodes: 0,
      limitations: ['text-references-not-derived'],
    })
  })

  it('会话不存在 ⇒ NotFoundException（client 端转 ok:false fail-open，契约不变）', async () => {
    const svc = new AgentCanvasToolsService(
      { session: { findUnique: async () => null } } as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    await expect(svc.getAssetContractSnapshot({ sessionId: 'missing' })).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('只读零写路径：除 session.findUnique / shot.findMany 外不触碰任何 prisma 写面', async () => {
    const sessionUpdate = vi.fn()
    const shotUpdate = vi.fn()
    const { svc, sessionFindUnique, shotFindMany } = makeService([{ ...SNAPSHOT_NODE, data: { assetId: 'a1' } }], [
      { id: 'shot-1', durationMs: 1000, pinnedAssetId: null, materials: [] },
    ])
    const prisma = (svc as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma
    prisma.session.update = sessionUpdate as never
    prisma.shot.update = shotUpdate as never
    await svc.getAssetContractSnapshot({ sessionId: 's1' })
    expect(sessionFindUnique).toHaveBeenCalledTimes(1)
    expect(shotFindMany).toHaveBeenCalledTimes(1)
    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(shotUpdate).not.toHaveBeenCalled()
  })
})

describe('GetAssetContractSnapshotDto + controller 透传', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true })
  const meta = { type: 'body' as const, metatype: GetAssetContractSnapshotDto }

  it('sessionId 不被 whitelist 剥离；未知键剥离', async () => {
    expect(typeof GetAssetContractSnapshotDto).toBe('function')
    const result = await pipe.transform({ sessionId: 's1', hack: 'x' }, meta)
    expect(result.sessionId).toBe('s1')
    expect((result as Record<string, unknown>).hack).toBeUndefined()
  })

  it('缺 sessionId ⇒ ValidationPipe 拒绝', async () => {
    await expect(pipe.transform({}, meta)).rejects.toBeInstanceOf(BadRequestException)
  })

  it('controller 把 dto 透传给 service 并包成 {code:0,data}', async () => {
    const snapshot = vi.fn(async () => ({
      registeredIds: [],
      referencedIds: [],
      authorities: [],
      durationRows: [],
      skippedNodes: 0,
      limitations: ['text-references-not-derived'],
    }))
    const controller = new AgentCanvasToolsController(
      { getAssetContractSnapshot: snapshot } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const dto = { sessionId: 's1' }
    const out = await controller.getAssetContractSnapshot(dto)
    expect(snapshot).toHaveBeenCalledWith(dto)
    expect(out).toEqual({
      code: 0,
      message: 'ok',
      data: {
        registeredIds: [],
        referencedIds: [],
        authorities: [],
        durationRows: [],
        skippedNodes: 0,
        limitations: ['text-references-not-derived'],
      },
    })
  })
})
