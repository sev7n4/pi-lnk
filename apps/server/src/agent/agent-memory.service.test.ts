import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { AgentMemoryService, MEMORY_SCAN_MAX } from './agent-memory.service'

describe('AgentMemoryService', () => {
  let svc: AgentMemoryService
  const create = vi.fn()
  const findMany = vi.fn()
  /** findMany 桩的假库：mock 按 where 真过滤（作用域过滤下沉到 SQL，桩必须忠实执行）。 */
  let db: {
    id: string
    userId?: string
    scope?: string
    sessionId?: string | null
    content: string
    createdAt: Date
  }[]

  beforeEach(async () => {
    vi.clearAllMocks()
    db = []
    create.mockImplementation(async ({ data }: { data: { userId: string; content: string } }) => ({
      id: 'm1',
      userId: data.userId,
      content: data.content,
      scope: 'canvas',
      sessionId: null,
      createdAt: new Date('2026-09-29T01:00:00.000Z'),
    }))
    findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {}
      // 终审 M-1：桩要比真实 Prisma **严格**。原先 `r.userId === undefined 也放行`，
      // 让「用户隔离」这条锁在桩层面弱于真实库（真实 userId 是 TEXT NOT NULL，不会有undefined 行）。
      return db
        .filter((r) => (w.userId === undefined || r.userId === w.userId)
          && (w.scope === undefined || r.scope === w.scope)
          && (w.sessionId === undefined || (r.sessionId ?? null) === w.sessionId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, args?.take ?? db.length)
        .map((r) => ({ ...r }))
    })
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentMemoryService,
        { provide: PrismaService, useValue: { agentMemory: { create, findMany } } },
      ],
    }).compile()
    svc = moduleRef.get(AgentMemoryService)
  })

  it('saveMemory：trim + 2000 截断', async () => {
    const long = '  ' + '汉'.repeat(2100) + '  '
    const out = await svc.saveMemory({ userId: 'u1', content: long })
    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0][0].data as { userId: string; content: string }
    expect(body.userId).toBe('u1')
    expect(body.content.length).toBe(2000)
    // 预期变更：返回值多带实际落库作用域（默认 canvas，无 sessionId 时降级 user）
    expect(out).toEqual({ id: 'm1', createdAt: '2026-09-29T01:00:00.000Z', scope: 'user', sessionId: null })
  })

  it('saveMemory：空内容 → BadRequest', async () => {
    await expect(svc.saveMemory({ userId: 'u1', content: '   ' })).rejects.toBeInstanceOf(BadRequestException)
    expect(create).not.toHaveBeenCalled()
  })

  it('searchMemory：无 query → 只按 userId 过滤，倒序取 limit', async () => {
    findMany.mockResolvedValue([
      { id: 'm1', scope: 'user', sessionId: null, content: '品牌色 #0F4C81', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    const out = await svc.searchMemory({ userId: 'u1' })
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    // 预期变更（作用域隔离）：条目多出归属三字段
    expect(out.items).toEqual([
      { id: 'm1', content: '品牌色 #0F4C81', createdAt: '2026-09-29T01:00:00.000Z', scope: 'user', sessionId: null, crossCanvas: false },
    ])
  })

  it('searchMemory：有 query → JS 侧大小写不敏感子串过滤，扫描窗口 200 后按 limit 截断', async () => {
    // Review I-1：sqlite LIKE 对 ASCII 大小写不敏感（实测），故 query 语义 = 大小写不敏感子串。
    findMany.mockResolvedValue([
      { id: 'm1', content: 'Brand Color Is #0F4C81', createdAt: new Date('2026-09-29T01:00:00.000Z') },
      { id: 'm2', content: '无关记忆', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    const out = await svc.searchMemory({ userId: 'u1', query: 'brand color', limit: 999 })
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    expect(out.items.map((i) => i.id)).toEqual(['m1'])
    await svc.searchMemory({ userId: 'u1', limit: 0 })
    expect((findMany.mock.calls[1][0] as { take: number }).take).toBe(1)
  })

  it('searchMemory：query 含 % / _ 不当作 LIKE 通配符（Review I-2 回归锁）', async () => {
    findMany.mockResolvedValue([
      { id: 'm1', content: '折扣是 50% 起', createdAt: new Date('2026-09-29T01:00:00.000Z') },
      { id: 'm2', content: '折扣是 90% 起', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    const pct = await svc.searchMemory({ userId: 'u1', query: '%' })
    expect(pct.items.map((i) => i.id)).toEqual(['m1', 'm2'])
    const fifty = await svc.searchMemory({ userId: 'u1', query: '50%' })
    expect(fifty.items.map((i) => i.id)).toEqual(['m1'])
    findMany.mockResolvedValue([
      { id: 'm3', content: 'Brand Color Is #0F4C81', createdAt: new Date('2026-09-29T01:00:00.000Z') },
      { id: 'm4', content: 'Brand_and_x', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    // 子串语义：字面 'and_x' 命中 m4；而 'b_and' 在 LIKE 下会经 `_` 通配命中 'Brand'（旧行为），
    // 子串语义下应零命中——这正是 I-2 修复要证明的。
    const literal = await svc.searchMemory({ userId: 'u1', query: 'and_x' })
    expect(literal.items.map((i) => i.id)).toEqual(['m4'])
    const wildcardLike = await svc.searchMemory({ userId: 'u1', query: 'b_and' })
    expect(wildcardLike.items).toEqual([])
  })

  it('searchMemory：分词 OR 命中 + 计分排序（双词全中排前，零分过滤）（审计 #7）', async () => {
    findMany.mockResolvedValue([
      { id: 'm1', content: '用户偏好深色主题', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: 'm2', content: '深色主题与圆形节点', createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { id: 'm3', content: '喜欢圆形节点', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { id: 'm4', content: '无关记忆', createdAt: new Date('2026-01-04T00:00:00.000Z') },
    ])
    const out = await svc.searchMemory({ userId: 'u1', query: '深色 圆形', limit: 10 })
    // '深色 圆形' 分词 → ['深色', '圆形']；m2 两词全中排第一；m4 零分被过滤
    expect(out.items[0].id).toBe('m2')
    expect(out.items.map((i) => i.id)).toEqual(['m2', 'm1', 'm3'])
  })

  it('searchMemory：中文查询按 bigram 匹配（「整理」命中「整理画布」）（审计 #7）', async () => {
    findMany.mockResolvedValue([
      { id: 'm9', content: '自动整理画布节点', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ])
    const out = await svc.searchMemory({ userId: 'u1', query: '整理', limit: 10 })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].id).toBe('m9')
  })

  // ── 作用域隔离（spec docs/superpowers/specs/2026-10-03-agent-memory-scope-isolation-design.md）──

  it('saveMemory：默认写画布作用域（无 scope 时）', async () => {
    await svc.saveMemory({ userId: 'u1', content: '《小熊和小爸爸》角色设定', sessionId: 'S1' })
    const body = create.mock.calls[0][0].data as { scope: string; sessionId: string | null; source: string }
    expect(body.scope).toBe('canvas')
    expect(body.sessionId).toBe('S1')
    expect(body.source).toBe('agent_auto')
  })

  it('saveMemory：canvas 归属缺失（无 sessionId）→ 降级 user 且 source 留痕，不丢记忆', async () => {
    const out = await svc.saveMemory({ userId: 'u1', content: '归属不明的项目知识' })
    const body = create.mock.calls[0][0].data as { scope: string; sessionId: string | null; source: string }
    expect(body.scope).toBe('user')
    expect(body.sessionId).toBeNull()
    expect(body.source).toBe('user_explicit')
    // 降级事实回传给调用方，工具层据此把 note 写成「未确定归属」而不是骗模型「仅本画布」
    expect(out.scope).toBe('user')
  })

  it('saveMemory：sessionId 空白串等同缺失 → 同样降级 user', async () => {
    await svc.saveMemory({ userId: 'u1', content: '空白归属', sessionId: '   ' })
    const body = create.mock.calls[0][0].data as { scope: string; sessionId: string | null }
    expect(body.scope).toBe('user')
    expect(body.sessionId).toBeNull()
  })

  it('saveMemory：显式 scope=user 时 sessionId 写空、source=user_explicit', async () => {
    await svc.saveMemory({ userId: 'u1', content: '暗号是紫罗兰七号', scope: 'user', sessionId: 'S1' })
    const body = create.mock.calls[0][0].data as { scope: string; sessionId: string | null; source: string }
    expect(body.scope).toBe('user')
    expect(body.sessionId).toBeNull()
    expect(body.source).toBe('user_explicit')
  })

  it('searchMemory：默认（scope 省略 → any）仍按 userId 捞，但本画布记忆排前、带归属字段', async () => {
    db = [
      { id: 'other', userId: 'u1', scope: 'canvas', sessionId: 'S2', content: '别的画布项目知识', createdAt: new Date('2026-02-01T00:00:00.000Z') },
      { id: 'same', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布项目知识', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: 'pref', userId: 'u1', scope: 'user', sessionId: null, content: '暗号是紫罗兰七号', createdAt: new Date('2026-01-02T00:00:00.000Z') },
    ]
    const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1' })
    expect(r.items.map((i) => i.id)).toEqual(['same', 'pref', 'other'])
    expect(r.items.find((i) => i.id === 'same')!.crossCanvas).toBe(false)
    expect(r.items.find((i) => i.id === 'pref')!.crossCanvas).toBe(false)
    expect(r.items.find((i) => i.id === 'other')!.crossCanvas).toBe(true)
    expect(r.items.find((i) => i.id === 'other')!.scope).toBe('canvas')
    expect(r.items.find((i) => i.id === 'other')!.sessionId).toBe('S2')
  })

  it('searchMemory：scope=canvas 只回本画布（跨画布那条进不来）', async () => {
    db = [
      { id: 'same', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: 'other', userId: 'u1', scope: 'canvas', sessionId: 'S2', content: '别的画布', createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { id: 'pref', userId: 'u1', scope: 'user', sessionId: null, content: '暗号', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]
    const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', scope: 'canvas' })
    expect(r.items.map((i) => i.id)).toEqual(['same'])
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', scope: 'canvas', sessionId: 'S1' },
      orderBy: { createdAt: 'desc' },
      // 有当前画布 ⇒ 扫满窗口再排 tier（终审 I-1）
      take: MEMORY_SCAN_MAX,
    })
  })

  it('searchMemory：scope=user Explicit 时忽略 sessionId（跨会话偏好仍可达）', async () => {
    db = [
      { id: 'p1', userId: 'u1', scope: 'user', sessionId: null, content: '品牌色 #0F4C81', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: 'same', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布', createdAt: new Date('2026-01-02T00:00:00.000Z') },
    ]
    const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', scope: 'user' })
    expect(r.items.map((i) => i.id)).toEqual(['p1'])
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', scope: 'user' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
  })

  it('searchMemory：scope=canvas 但 sessionId 缺失 → 短路返回空（fail-closed，不做全用户降级）', async () => {
    db = [{ id: 'x', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布', createdAt: new Date() }]
    const r = await svc.searchMemory({ userId: 'u1', scope: 'canvas' })
    expect(r.items).toEqual([])
    expect(findMany).not.toHaveBeenCalled()
  })

  it('searchMemory：sessionId 空白串等同缺失（canvas 作用域 fail-closed）', async () => {
    db = [{ id: 'x', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布', createdAt: new Date() }]
    const r = await svc.searchMemory({ userId: 'u1', sessionId: '   ', scope: 'canvas' })
    expect(r.items).toEqual([])
    expect(findMany).not.toHaveBeenCalled()
  })

  it('searchMemory：无 sessionId 时跨画布判定不成立（crossCanvas 全 false，不误标）', async () => {
    db = [{ id: 'o1', userId: 'u1', scope: 'canvas', sessionId: 'S2', content: '别的画布', createdAt: new Date() }]
    const r = await svc.searchMemory({ userId: 'u1' })
    expect(r.items[0].crossCanvas).toBe(false)
  })

  /**
   * 终审 I-1回归锁：`take` 是 SQL LIMIT、tier 排序在 JS 侧。
   * 无 query 时 take=limit，若本画布记忆比 limit 更旧，它会在SQL 截断阶段就被切掉，
   * JS 再怎么排也救不回来——本画布上下文一条都拿不到，反而全是别画布的。
   */
  it('searchMemory：本画布记忆更旧但仍在窗口内时不被 take=limit 截掉（终审 I-1）', async () => {
    db = [
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `other${i}`,
        userId: 'u1',
        scope: 'canvas',
        sessionId: 'S2',
        content: `别画布知识 ${i}`,
        createdAt: new Date(`2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`),
      })),
      { id: 'mine', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布老记忆', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]
    const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', limit: 10 })
    expect(r.items[0].id).toBe('mine')
    expect(r.items).toHaveLength(10)
    // 扫描窗口必须放大到 MEMORY_SCAN_MAX，否则 SQL 阶段就切掉了本画布那条
    expect((findMany.mock.calls[0][0] as { take: number }).take).toBe(MEMORY_SCAN_MAX)
  })

  it('searchMemory：无当前画布时仍用 limit 取（不为不存在的排序付出全表扫）', async () => {
    db = [{ id: 'x', userId: 'u1', scope: 'user', sessionId: null, content: '偏好', createdAt: new Date() }]
    await svc.searchMemory({ userId: 'u1', limit: 5 })
    expect((findMany.mock.calls[0][0] as { take: number }).take).toBe(5)
  })

  it('searchMemory：userId 缺失的脏行也不该被捞上来（终审 M-1：桩须strict）', async () => {
    db = [
      { id: 'dirty', scope: 'canvas', sessionId: 'S1', content: '无 owner 的脏行', createdAt: new Date() },
      { id: 'mine', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '正常行', createdAt: new Date() },
    ]
    const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', scope: 'canvas' })
    expect(r.items.map((i) => i.id)).toEqual(['mine'])
  })

  it('searchMemory：别的 userId 的记忆永远进不来（作用域过滤不替代用户隔离）', async () => {
    db = [
      { id: 'mine', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '我的', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: 'theirs', userId: 'u2', scope: 'canvas', sessionId: 'S1', content: '别人的', createdAt: new Date('2026-01-02T00:00:00.000Z') },
    ]
    const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', scope: 'canvas' })
    expect(r.items.map((i) => i.id)).toEqual(['mine'])
  })
})
