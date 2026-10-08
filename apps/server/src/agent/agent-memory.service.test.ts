import 'reflect-metadata'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { AgentMemoryService, MEMORY_SCAN_MAX, MEMORY_RECALL_CHAR_BUDGET, normalizeMemoryContent } from './agent-memory.service'
import { isSuppressed } from './memory-suppression'

describe('AgentMemoryService', () => {
  let svc: AgentMemoryService
  const create = vi.fn()
  const findMany = vi.fn()
  const findUnique = vi.fn()
  const count = vi.fn()
  const deleteMany = vi.fn()
  const update = vi.fn()
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
          && (w.sessionId === undefined || (r.sessionId ?? null) === w.sessionId)
          // M6b：source 过滤桩也要忠实执行（`{ not: 'promoted' }` 形态）——
          // 桩若放行 promoted 行，「晋升回灌不复活」这条判据就锁不住。
          && (w.source === undefined || (w.source?.not !== undefined ? r.source !== w.source.not : r.source === w.source)))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, args?.take ?? db.length)
        .map((r) => ({ ...r }))
    })
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentMemoryService,
        { provide: PrismaService, useValue: { agentMemory: { create, findMany, findUnique, count, deleteMany, update } } },
      ],
    }).compile()
    count.mockResolvedValue(0)
    deleteMany.mockResolvedValue({ count: 0 })
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

  // ── M6b：晋升候选队列（spec 2026-10-06-memory-promotion-m6b-design.md §2.1） ──

  describe('normalizeMemoryContent', () => {
    it('trim + 折叠空白 + 小写 + 去尾部标点（无损归一，不做语义）', () => {
      expect(normalizeMemoryContent('  主角叫林晚。 ')).toBe('主角叫林晚')
      expect(normalizeMemoryContent('A  B')).toBe('a b')
      expect(normalizeMemoryContent('你好！！')).toBe('你好')
      expect(normalizeMemoryContent('林晚。。.')).toBe('林晚')
      expect(normalizeMemoryContent('主角叫林晚')).toBe('主角叫林晚')
    })

    it('中间标点不动（只有尾部是噪音）', () => {
      expect(normalizeMemoryContent('林晚，女，14岁')).toBe('林晚，女，14岁')
    })
  })

  describe('promotionCandidates', () => {
    const row = (id: string, sessionId: string, content: string, at: string, extra?: Partial<{ source: string; userId: string }>) => ({
      id,
      userId: 'u1',
      scope: 'canvas',
      sessionId,
      content,
      source: 'agent_auto',
      createdAt: new Date(at),
      ...extra,
    })

    it('同 sessionId 同内容 3 行 → 1 候选 count=3，memoryIds 全量、firstSeen/lastSeen 两端', async () => {
      db = [
        row('m1', 'S1', '主角叫林晚', '2026-10-01T00:00:00.000Z'),
        row('m2', 'S1', '主角叫林晚', '2026-10-02T00:00:00.000Z'),
        row('m3', 'S1', '主角叫林晚', '2026-10-03T00:00:00.000Z'),
      ]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.scannedRows).toBe(3)
      expect(r.threshold).toBe(3)
      expect(r.candidates).toHaveLength(1)
      const c = r.candidates[0]
      expect(c.count).toBe(3)
      expect(c.sessionId).toBe('S1')
      expect(c.memoryIds).toEqual(['m1', 'm2', 'm3'])
      expect(c.firstSeenAt).toBe('2026-10-01T00:00:00.000Z')
      expect(c.lastSeenAt).toBe('2026-10-03T00:00:00.000Z')
      expect(c.sampleContents).toEqual(['主角叫林晚'])
    })

    it('2 行不进候选（阈值 3 是判据，不是拍的——§13.3）', async () => {
      db = [row('m1', 'S1', '重复两次的内容', '2026-10-01T00:00:00.000Z'), row('m2', 'S1', '重复两次的内容', '2026-10-02T00:00:00.000Z')]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.candidates).toHaveLength(0)
    })

    it('跨 sessionId 同内容不合并（「同一画布内」是判据的一半）', async () => {
      db = [
        row('m1', 'S1', '同一句', '2026-10-01T00:00:00.000Z'),
        row('m2', 'S1', '同一句', '2026-10-02T00:00:00.000Z'),
        row('m3', 'S1', '同一句', '2026-10-03T00:00:00.000Z'),
        row('m4', 'S2', '同一句', '2026-10-04T00:00:00.000Z'),
        row('m5', 'S2', '同一句', '2026-10-05T00:00:00.000Z'),
      ]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.candidates).toHaveLength(1)
      expect(r.candidates[0].sessionId).toBe('S1')
      expect(r.candidates[0].count).toBe(3)
    })

    it('归一化命中：尾部标点/空白/大小写差不分裂（近似改写也不许合并——字面判据宁漏勿错）', async () => {
      db = [
        row('m1', 'S1', '主角叫林晚', '2026-10-01T00:00:00.000Z'),
        row('m2', 'S1', '主角叫林晚。', '2026-10-02T00:00:00.000Z'),
        row('m3', 'S1', ' 主角叫林晚 ', '2026-10-03T00:00:00.000Z'),
        // 近义改写：不是重复（normalize 后仍不同），不进
        row('m4', 'S1', '主角叫做林晚', '2026-10-04T00:00:00.000Z'),
      ]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.candidates).toHaveLength(1)
      expect(r.candidates[0].count).toBe(3)
    })

    it("source='promoted' 的行不计入（晋升回灌不得复活候选）", async () => {
      db = [
        row('m1', 'S1', '已是规则', '2026-10-01T00:00:00.000Z'),
        row('m2', 'S1', '已是规则', '2026-10-02T00:00:00.000Z'),
        row('m3', 'S1', '已是规则', '2026-10-03T00:00:00.000Z', { source: 'promoted' }),
      ]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.candidates).toHaveLength(0)
    })

    it('count 降序、同级按 lastSeenAt 降序', async () => {
      db = [
        // A 组：3 次（旧）
        row('a1', 'S1', '甲', '2026-09-01T00:00:00.000Z'), row('a2', 'S1', '甲', '2026-09-02T00:00:00.000Z'), row('a3', 'S1', '甲', '2026-09-03T00:00:00.000Z'),
        // B 组：5 次
        ...Array.from({ length: 5 }, (_, i) => row(`b${i + 1}`, 'S2', '乙', `2026-09-1${i}T00:00:00.000Z`)),
        // C 组：3 次（更新）
        row('c1', 'S3', '丙', '2026-10-01T00:00:00.000Z'), row('c2', 'S3', '丙', '2026-10-02T00:00:00.000Z'), row('c3', 'S3', '丙', '2026-10-03T00:00:00.000Z'),
      ]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.candidates.map((c) => c.count)).toEqual([5, 3, 3])
      // 同级 lastSeenAt 降序：丙（10-03）比甲（09-03）新，排前
      expect(r.candidates[1].normalizedContent).toBe('丙')
      expect(r.candidates[2].normalizedContent).toBe('甲')
    })

    it('sampleContents：原文去重、≤3 条、单条截断 120 字', async () => {
      // 差异后缀必须完整落在 120 字窗口内（最长原文 = 116+4 = 120），否则切片同文被去重
      const long = '长'.repeat(116)
      // 原文各不相同但归一化同键（大小写/尾部标点差），凑满去重后的 3 条样本上限
      db = [
        row('m1', 'S1', long + 'ONE', '2026-10-01T00:00:00.000Z'),
        row('m2', 'S1', long + 'one。', '2026-10-02T00:00:00.000Z'),
        row('m3', 'S1', long + 'one', '2026-10-03T00:00:00.000Z'),
        row('m4', 'S1', long + 'one，', '2026-10-04T00:00:00.000Z'),
      ]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.candidates).toHaveLength(1)
      expect(r.candidates[0].sampleContents).toHaveLength(3)
      for (const s of r.candidates[0].sampleContents) expect(s.length).toBeLessThanOrEqual(120)
    })

    it('limit 参数收口返回条数（默认 20），但 count 排序后取最热', async () => {
      db = Array.from({ length: 25 }, (_, i) => [
        row(`x${i}a`, `S${i}`, `内容${i}`, '2026-10-01T00:00:00.000Z'),
        row(`x${i}b`, `S${i}`, `内容${i}`, '2026-10-02T00:00:00.000Z'),
        row(`x${i}c`, `S${i}`, `内容${i}`, '2026-10-03T00:00:00.000Z'),
      ]).flat()
      const r = await svc.promotionCandidates({ userId: 'u1', limit: 10 })
      expect(r.candidates).toHaveLength(10)
    })

    it('空库 → 空数组不抛', async () => {
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r).toEqual({ candidates: [], scannedRows: 0, threshold: 3, truncated: false })
    })

    it('user 作用域的行不进候选（§13.3：用户偏好不晋升）', async () => {
      db = [
        { id: 'p1', userId: 'u1', scope: 'user', sessionId: null, content: '喜欢暖色调', source: 'user_explicit', createdAt: new Date('2026-10-01T00:00:00.000Z') },
        { id: 'p2', userId: 'u1', scope: 'user', sessionId: null, content: '喜欢暖色调', source: 'user_explicit', createdAt: new Date('2026-10-02T00:00:00.000Z') },
        { id: 'p3', userId: 'u1', scope: 'user', sessionId: null, content: '喜欢暖色调', source: 'user_explicit', createdAt: new Date('2026-10-03T00:00:00.000Z') },
      ]
      const r = await svc.promotionCandidates({ userId: 'u1' })
      expect(r.candidates).toHaveLength(0)
      expect(r.scannedRows).toBe(0)
    })
  })



  // ── Phase 1（A 配额驱逐 / E 召回预算，spec 2026-10-08-pilnk-memory-product-adoption-scope.md）──
  describe('Phase1 A 配额驱逐 / E 召回预算', () => {
    beforeEach(() => {
      count.mockResolvedValue(0)
      deleteMany.mockResolvedValue({ count: 0 })
      findMany.mockImplementation(async (args: any) => {
        const w = args?.where ?? {}
        return db
          .filter((r) => (w.userId === undefined || r.userId === w.userId)
            && (w.scope === undefined || r.scope === w.scope)
            && (w.sessionId === undefined || (r.sessionId ?? null) === w.sessionId))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args?.take ?? db.length)
          .map((r) => ({ ...r }))
      })
    })

    it('A：超 per-scope 配额时驱逐最旧 excess 条（LRU by createdAt asc）', async () => {
      count.mockResolvedValue(500)
      findMany.mockImplementation(async (args: any) => {
        if (args?.orderBy?.createdAt === 'asc') {
          return [{ id: 'oldest-1', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '最旧', createdAt: new Date('2026-01-01') }]
        }
        return []
      })
      await svc.saveMemory({ userId: 'u1', content: '新记忆', sessionId: 'S1' })
      expect(count).toHaveBeenCalledWith({ where: { userId: 'u1', scope: 'canvas' } })
      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', scope: 'canvas' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true },
      })
      expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['oldest-1'] } } })
      expect(create).toHaveBeenCalledTimes(1)
    })

    it('A：驱逐链路异常时 fail-soft，仍完成写入（不抛、不丢记忆）', async () => {
      count.mockRejectedValue(new Error('db down'))
      const out = await svc.saveMemory({ userId: 'u1', content: '新记忆', sessionId: 'S1' })
      expect(out.scope).toBe('canvas')
      expect(create).toHaveBeenCalledTimes(1)
      expect(deleteMany).not.toHaveBeenCalled()
    })

    it('E：超字符预算时截断低相关尾部并标 truncated，高相关项仍在前列（G5）', async () => {
      db = Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`,
        userId: 'u1',
        scope: 'canvas',
        sessionId: 'S1',
        content: '记'.repeat(200),
        createdAt: new Date(2026, 0, 1 + i),
      }))
      const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', limit: 50 })
      expect(r.truncated).toBe(true)
      expect(r.items.length).toBeGreaterThan(0)
      const total = r.items.reduce((acc, it) => acc + it.content.length, 0)
      expect(total).toBeLessThanOrEqual(MEMORY_RECALL_CHAR_BUDGET + 200)
      expect(r.items[0].id).toBe('m49')
    })
  })

  // ── M6b：抑制标记入口（spec §2.2）——人工确认后的唯一标记链路 ──

  describe('suppressMemory', () => {
    /** 每条用例独立 id（模块级表不复位，与 memory-suppression.test.ts 同约定）。 */
    const uid = () => `mem-sup-${Math.random().toString(36).slice(2, 10)}`

    function stubFetch(impl: (...a: any[]) => Promise<any>) {
      vi.stubGlobal('fetch', vi.fn(impl))
    }

    it('标记后 Nest 侧 isSuppressed 命中 + 转发成功返回 forwarded:true', async () => {
      const id = uid()
      findUnique.mockResolvedValue({ id, userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '污染记忆', createdAt: new Date() })
      stubFetch(async () => ({ ok: true, status: 200 }))
      const prev = process.env.PI_RUNTIME_URL
      process.env.PI_RUNTIME_URL = 'http://127.0.0.1:30100'
      try {
        const r = await svc.suppressMemory({ userId: 'u1', memoryId: id, reason: '反复致错' })
        expect(isSuppressed(id)).toBe(true)
        expect(r.forwarded).toBe(true)
        // 转发体只带 memoryId + reason，不带别的
        const [url, init] = (fetch as any).mock.calls[0]
        expect(String(url)).toContain('/internal/memory-suppress')
        expect(JSON.parse(init.body)).toEqual({ memoryId: id, reason: '反复致错' })
      } finally {
        if (prev === undefined) delete process.env.PI_RUNTIME_URL
        else process.env.PI_RUNTIME_URL = prev
      }
    })

    it('id 不存在 → NotFoundException，且不标记不转发', async () => {
      findUnique.mockResolvedValue(null)
      stubFetch(async () => { throw new Error('不应被调用') })
      await expect(svc.suppressMemory({ userId: 'u1', memoryId: 'mem-nope', reason: 'x' })).rejects.toBeInstanceOf(NotFoundException)
      expect(isSuppressed('mem-nope')).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('别人的记忆不能标记（归属校验——最小权限）', async () => {
      const id = uid()
      findUnique.mockResolvedValue({ id, userId: 'u2', scope: 'canvas', sessionId: 'S1', content: '别人的', createdAt: new Date() })
      stubFetch(async () => ({ ok: true }))
      await expect(svc.suppressMemory({ userId: 'u1', memoryId: id, reason: 'x' })).rejects.toBeInstanceOf(NotFoundException)
      expect(isSuppressed(id)).toBe(false)
    })

    it('memoryId 空白 → BadRequest，不查库不标记', async () => {
      stubFetch(async () => ({ ok: true }))
      await expect(svc.suppressMemory({ userId: 'u1', memoryId: '  ', reason: 'x' })).rejects.toBeInstanceOf(BadRequestException)
      expect(findUnique).not.toHaveBeenCalled()
    })

    it('pi-runtime 不可达/抛错 → 仍成功（Nest 侧已生效），forwarded:false（fail-soft）', async () => {
      const id = uid()
      findUnique.mockResolvedValue({ id, userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '污染', createdAt: new Date() })
      stubFetch(async () => { throw new Error('ECONNREFUSED') })
      const r = await svc.suppressMemory({ userId: 'u1', memoryId: id, reason: 'x' })
      expect(isSuppressed(id)).toBe(true)
      expect(r.forwarded).toBe(false)
    })

    it('转发响应非 2xx → forwarded:false（但 Nest 侧标记仍生效）', async () => {
      const id = uid()
      findUnique.mockResolvedValue({ id, userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '污染', createdAt: new Date() })
      stubFetch(async () => ({ ok: false, status: 500 }))
      const r = await svc.suppressMemory({ userId: 'u1', memoryId: id, reason: 'x' })
      expect(isSuppressed(id)).toBe(true)
      expect(r.forwarded).toBe(false)
    })

    it('PI_RUNTIME_URL 未配置（维护态/未接）→ 不转发，forwarded:false，不抛', async () => {
      const id = uid()
      findUnique.mockResolvedValue({ id, userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '污染', createdAt: new Date() })
      const prev = process.env.PI_RUNTIME_URL
      delete process.env.PI_RUNTIME_URL
      try {
        const r = await svc.suppressMemory({ userId: 'u1', memoryId: id, reason: 'x' })
        expect(r.forwarded).toBe(false)
        expect(fetch).not.toHaveBeenCalled()
      } finally {
        if (prev !== undefined) process.env.PI_RUNTIME_URL = prev
      }
    })
  // ── Phase 2（B 策展蒸馏 / C 写入去重，spec 2026-10-08-pilnk-memory-product-adoption-scope.md）──
  describe('Phase2 B 策展蒸馏 / C 写入去重', () => {
    let seq: number
    beforeEach(() => {
      seq = 0
      // 真实内存 store：create 落库（自增 id + 记录 source）、update 改内容、findMany/count 忠实过滤
      create.mockImplementation(async ({ data }: any) => {
        const row: any = {
          id: 'gen' + (++seq),
          userId: data.userId,
          scope: data.scope ?? 'user',
          sessionId: data.sessionId ?? null,
          content: data.content,
          source: data.source ?? 'agent_auto',
          createdAt: new Date(),
        }
        db.push(row)
        return row
      })
      update.mockImplementation(async ({ where, data }: any) => {
        const row = db.find((r) => r.id === where.id)
        if (row && data?.content !== undefined) row.content = data.content
        return row
      })
      findMany.mockImplementation(async (args: any) => {
        const w = args?.where ?? {}
        return db
          .filter((r: any) => (w.userId === undefined || r.userId === w.userId)
            && (w.scope === undefined || r.scope === w.scope)
            && (w.sessionId === undefined || (r.sessionId ?? null) === w.sessionId)
            && (w.source === undefined || (w.source?.not !== undefined ? r.source !== w.source.not : r.source === w.source)))
          .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args?.take ?? db.length)
          .map((r: any) => ({ ...r }))
      })
      count.mockImplementation(async (args: any) => {
        const w = args?.where ?? {}
        return db.filter((r: any) => (w.userId === undefined || r.userId === w.userId)
          && (w.scope === undefined || r.scope === w.scope)
          && (w.sessionId === undefined || (r.sessionId ?? null) === w.sessionId)
          && (w.source === undefined || (w.source?.not !== undefined ? r.source !== w.source.not : r.source === w.source))).length
      })
      deleteMany.mockResolvedValue({ count: 0 })
    })

    it('C：13 条同画布字面重复 → 落库 1 行（G3，不出现 13 行重复）', async () => {
      for (let i = 0; i < 13; i++) {
        await svc.saveMemory({ userId: 'u1', content: '用户喜欢小熊', sessionId: 'S1' })
      }
      expect(create.mock.calls.length).toBe(1)
      expect(update.mock.calls.length).toBe(12)
    })

    it('C：不同原文但同归一化 ⇒ 更新不新增（内容被覆盖）', async () => {
      await svc.saveMemory({ userId: 'u1', content: '我喜欢小熊。', sessionId: 'S1' })
      await svc.saveMemory({ userId: 'u1', content: '我喜欢小熊', sessionId: 'S1' })
      expect(create.mock.calls.length).toBe(1)
      expect(update.mock.calls.length).toBe(1)
      const row = db.find((r) => r.userId === 'u1' && r.scope === 'canvas')
      expect(row?.content).toBe('我喜欢小熊')
    })

    it('C：不同归一化内容不误并（保守，宁漏勿错）', async () => {
      await svc.saveMemory({ userId: 'u1', content: '用户喜欢小熊', sessionId: 'S1' })
      await svc.saveMemory({ userId: 'u1', content: '用户讨厌小猫', sessionId: 'S1' })
      expect(create.mock.calls.length).toBe(2)
      expect(update.mock.calls.length).toBe(0)
    })

    it('B：30 条同会话原始 → 策展 1 条 curated，原始 30 仍在库（可回溯，G2）', async () => {
      for (let i = 0; i < 30; i++) {
        await svc.saveMemory({ userId: 'u1', content: `小熊第${i}次出现`, sessionId: 'S1' })
      }
      const res = await svc.consolidateMemory({ userId: 'u1', scope: 'canvas' })
      expect(res.created).toBe(1)
      const all = db.filter((r) => r.userId === 'u1')
      const curated = all.filter((r) => r.source === 'curated')
      expect(curated.length).toBe(1)
      expect(all.length).toBe(31) // 原始 30 + 策展 1，原始不删
      expect(curated[0].content).toContain('策展自 30 条原始记忆')
    })

    it('B：召回优先返回策展摘要、排除已被策展的原始行（G2）', async () => {
      for (let i = 0; i < 30; i++) {
        await svc.saveMemory({ userId: 'u1', content: `小熊第${i}次出现`, sessionId: 'S1' })
      }
      await svc.consolidateMemory({ userId: 'u1', scope: 'canvas' })
      const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', limit: 50 })
      expect(r.truncated).toBe(false)
      expect(r.items.length).toBe(1) // 30 原始被排除，仅 1 条策展摘要
      expect(r.items[0].content).not.toContain('策展自') // 溯源标记对模型透明（已剥离）
      expect(r.items[0].content).toContain('小熊第29次出现') // 摘要来自原始原文
    })

    it('B：策展幂等（二次调用不重复策展已引用的原始）', async () => {
      for (let i = 0; i < 30; i++) {
        await svc.saveMemory({ userId: 'u1', content: `小熊第${i}次出现`, sessionId: 'S1' })
      }
      const first = await svc.consolidateMemory({ userId: 'u1', scope: 'canvas' })
      const second = await svc.consolidateMemory({ userId: 'u1', scope: 'canvas' })
      expect(first.created).toBe(1)
      expect(second.created).toBe(0)
      expect(db.filter((r) => r.userId === 'u1' && r.source === 'curated').length).toBe(1)
    })

    it('B：user scope 不策展（保守，避免误并偏好）', async () => {
      for (let i = 0; i < 5; i++) {
        await svc.saveMemory({ userId: 'u1', content: `偏好${i}`, scope: 'user' })
      }
      const res = await svc.consolidateMemory({ userId: 'u1', scope: 'user' })
      expect(res.created).toBe(0)
      expect(db.filter((r) => r.userId === 'u1' && r.source === 'curated').length).toBe(0)
    })
  })

  })
})
