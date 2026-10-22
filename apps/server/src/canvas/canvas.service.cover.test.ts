/**
 * A3 回访作品带 · 后端 list 封面字段（2026-10-22）
 *
 * 目标：`GET /agent/canvas/list` 在只返回卡片元数据的前提下，额外给出
 * - `coverUrl`   最近生成的产物图 URL（无产物时为 null ⇒ 前端用墨鱼默认封面）
 * - `coverNodeId` 该产物节点 id（前端据此跨项目定位到那张图）
 * - `title`     无标题时兜底为「画布 N」（按时间倒序编号）—— 一排「未命名画布」
 *                等于没有识别线索，而封面图的唯一识别价值就在这儿。
 *
 * 事实依据（2026-10-22 生产库实测，apps/server 侧 canvasData 结构）：
 * - 产物节点 = `data.status === 'completed'` 且 `data.url` 非空
 *   （`status:'error'` / `'draft'` / `'idle'` 的节点 url 均为空）
 * - 时间序 = `data.generationStartedAt`（ISO 8601 字符串，如
 *   "2026-10-21T20:11:22.307Z"）；部分节点另有 `data.createdAt`
 * - `data.mediaInfo` = { kind, width, height, bytes, aspectRatio }
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { CanvasService } from './canvas.service'

const SESSION = {
  id: 's1',
  title: '大闸蟹礼盒',
  userId: 'u1',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-22T10:00:00Z'),
}

function canvasData(nodes: unknown[]) {
  return JSON.stringify({ nodes, edges: [] })
}

describe('CanvasService.list → 回访作品带封面字段（A3）', () => {
  let svc: CanvasService
  let findMany: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    findMany = vi.fn(async () => [])
    const moduleRef = await Test.createTestingModule({
      providers: [
        CanvasService,
        { provide: PrismaService, useValue: { session: { findMany } } },
      ],
    }).compile()
    svc = moduleRef.get(CanvasService)
  })

  it('取最近生成的产物图：按 generationStartedAt 倒序取第一个 completed+url 的节点', async () => {
    findMany.mockResolvedValue([
      {
        ...SESSION,
        canvasData: canvasData([
          { id: 'n-old', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', url: 'https://x/old.png', generationStartedAt: '2026-10-20T10:00:00.000Z' } },
          { id: 'n-new', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', url: 'https://x/new.png', generationStartedAt: '2026-10-21T10:00:00.000Z' } },
        ]),
      },
    ])

    const rows = await svc.list('u1')
    expect(rows[0].coverUrl).toBe('https://x/new.png')
    expect(rows[0].coverNodeId).toBe('n-new')
  })

  it('跳过未完成 / 无 url 的节点（error / draft / idle）', async () => {
    findMany.mockResolvedValue([
      {
        ...SESSION,
        canvasData: canvasData([
          { id: 'n-err', type: 'image', position: { x: 0, y: 0 }, data: { status: 'error', url: '', errorMessage: 'x', generationStartedAt: '2026-10-22T10:00:00.000Z' } },
          { id: 'n-draft', type: 'image', position: { x: 0, y: 0 }, data: { status: 'draft', url: '', generationStartedAt: '2026-10-22T09:00:00.000Z' } },
          // ⚠️ 关键用例：**status 非 completed 但 url 非空**。
          // 若测试只用「未完成 ⇒ url 为空」的组合，判据里 status 与 url 两道防线
          // 会互相顶替（去掉任一道，另一道仍能拦住）⇒ 判据永远绿、测不到真意图。
          // 必须构造「两道防线各自单独生效」的用例。
          { id: 'n-stale', type: 'image', position: { x: 0, y: 0 }, data: { status: 'error', url: 'https://x/stale.png', generationStartedAt: '2026-10-22T11:00:00.000Z' } },
          // ⚠️ 对称用例：**status 合法但 url 为空**（生成完成却没落 URL）。
          // 少了它，去掉 url 判据时这个节点会被选中（coverUrl 变成空串而非 null），
          // 而 status 判据仍在 ⇒ 测不出来。
          { id: 'n-nourl', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', url: '', generationStartedAt: '2026-10-22T12:00:00.000Z' } },
          { id: 'n-ok', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', url: 'https://x/ok.png', generationStartedAt: '2026-10-21T10:00:00.000Z' } },
        ]),
      },
    ])

    const rows = await svc.list('u1')
    // 时间上更晚的 n-stale 也不该被选（status 不对）
    expect(rows[0].coverUrl).toBe('https://x/ok.png')
    expect(rows[0].coverNodeId).toBe('n-ok')
  })

  it('无产物时 coverUrl/coverNodeId 均为 null（前端用墨鱼默认封面）', async () => {
    findMany.mockResolvedValue([
      {
        ...SESSION,
        canvasData: canvasData([
          { id: 'n-txt', type: 'text', position: { x: 0, y: 0 }, data: { content: '大纲' } },
        ]),
      },
    ])

    const rows = await svc.list('u1')
    expect(rows[0].coverUrl).toBeNull()
    expect(rows[0].coverNodeId).toBeNull()
  })

  it('canvasData 为 null / 非法 JSON 时不抛错，封面字段为 null', async () => {
    findMany.mockResolvedValue([
      { ...SESSION, canvasData: null },
      { ...SESSION, id: 's2', canvasData: '{not json' },
    ])

    const rows = await svc.list('u1')
    expect(rows).toHaveLength(2)
    expect(rows[0].coverUrl).toBeNull()
    expect(rows[1].coverUrl).toBeNull()
  })

  it('标题兜底：空标题按时间倒序编号为「画布 N」（识别线索不能是一排「未命名画布」）', async () => {
    findMany.mockResolvedValue([
      { ...SESSION, id: 's1', title: '', canvasData: null },
      { ...SESSION, id: 's2', title: '   ', canvasData: null },
      { ...SESSION, id: 's3', title: '有名字的', canvasData: null },
    ])

    const rows = await svc.list('u1')
    // list 按 updatedAt desc 返回 ⇒ 第 1 个是最新的，编号从 1 起
    expect(rows[0].title).toBe('画布 1')
    expect(rows[1].title).toBe('画布 2')
    expect(rows[2].title).toBe('有名字的')
  })

  it('响应体不带原始 canvasData（列表瘦身不被破坏）', async () => {
    findMany.mockResolvedValue([{ ...SESSION, canvasData: canvasData([]) }])
    const rows = await svc.list('u1')
    expect(rows[0]).not.toHaveProperty('canvasData')
  })

  it('封面取值必须只查必要的列：select 里含 canvasData 但响应不含', async () => {
    findMany.mockResolvedValue([])
    await svc.list('u1')
    const args = findMany.mock.calls[0]?.[0] as { select?: Record<string, boolean> }
    expect(args?.select?.canvasData).toBe(true)
  })
})
