import { describe, expect, it } from 'vitest'
import { applyManualMap, classifyMemory, planBackfill } from './memory-scope-classify'

// 回填分类规则的回归锁（spec 2026-10-03-agent-memory-scope-isolation-design.md §7）。
// 生产基线：30 条记忆 / 6 userId，其中「暗号是紫罗兰七号」「蓝天四十九号」是凭据级内容，
// 回填后**必须留在 user 层**——它们现在任何画布都捞得到，是真实风险。

describe('classifyMemory', () => {
  it('凭据/暗号类 → user（优先于任何项目词）', () => {
    expect(classifyMemory('用户的暗号是“紫罗兰七号”').scope).toBe('user')
    expect(classifyMemory('暗号是：蓝天四十九号').scope).toBe('user')
    expect(classifyMemory('登录密码是 hunter2').scope).toBe('user')
    expect(classifyMemory('API 密钥放在 vault').scope).toBe('user')
    expect(classifyMemory('账号是 lnkpi@x.com').scope).toBe('user')
  })

  it('交付规格/偏好类 → user', () => {
    expect(classifyMemory('品牌色是 #0F4C81').scope).toBe('user')
    expect(classifyMemory('用户偏好深色主题').scope).toBe('user')
    expect(classifyMemory('视频分辨率固定 1080x1440').scope).toBe('user')
    expect(classifyMemory('以后都用 1440 尺寸').scope).toBe('user')
  })

  it('项目知识类 → canvas', () => {
    expect(classifyMemory('短剧《小熊和小爸爸》项目信息：主角小柚').scope).toBe('canvas')
    expect(classifyMemory('角色设定：女主 6 岁').scope).toBe('canvas')
    expect(classifyMemory('第 3 集分镜：客厅对峙').scope).toBe('canvas')
    expect(classifyMemory('回声鉴定所项目设定').scope).toBe('canvas')
  })

  it('判不出来 → user（保守，先不丢）', () => {
    expect(classifyMemory('随便一句项目相关的话').scope).toBe('user')
    expect(classifyMemory('').scope).toBe('user')
  })

  it('凭据词与项目词同时出现时，user 优先（安全侧优先）', () => {
    const r = classifyMemory('《小熊和小爸爸》项目：用户的暗号是紫罗兰七号')
    expect(r.scope).toBe('user')
    expect(r.reason).toMatch(/凭据/)
  })

  it('每条结果都带reason（供人工复核打印）', () => {
    expect(classifyMemory('品牌色 #0F4C81').reason).toBeTruthy()
  })
})

describe('planBackfill', () => {
  const rows = [
    { id: 'a', scope: 'canvas', sessionId: 'sess-1' },
    { id: 'b', scope: 'canvas', sessionId: 'sess-gone' }, // 画布已删
    { id: 'c', scope: 'canvas', sessionId: null }, // 悬空归属
  ]
  const liveSessions = new Set(['sess-1'])

  it('sessionId 指向已删画布 → 回退 user，不留悬空 canvas 行（Review Focus #5）', () => {
    const out = planBackfill(rows, liveSessions)
    const b = out.find((r) => r.id === 'b')!
    expect(b.scope).toBe('user')
    expect(b.sessionId).toBeNull()
    expect(b.reason).toMatch(/画布已不存在/)
  })

  it('sessionId 为空 → 回退 user', () => {
    const out = planBackfill(rows, liveSessions)
    expect(out.find((r) => r.id === 'c')!.scope).toBe('user')
  })

  it('sessionId 有效 → 保持 canvas', () => {
    const out = planBackfill(rows, liveSessions)
    const a = out.find((r) => r.id === 'a')!
    expect(a.scope).toBe('canvas')
    expect(a.sessionId).toBe('sess-1')
  })

  it('已是 user 作用域的行保持 user（幂等：重复跑结果不变）', () => {
    const out = planBackfill([{ id: 'd', scope: 'user', sessionId: null }], liveSessions)
    expect(out[0].scope).toBe('user')
    expect(out[0].changed).toBe(false)
  })

  it('changed 标记只在该行真的需要写库时为 true', () => {
    const out = planBackfill(rows, liveSessions)
    expect(out.find((r) => r.id === 'a')!.changed).toBe(false)
    expect(out.find((r) => r.id === 'b')!.changed).toBe(true)
  })

  it('行数守恒：输出条数 = 输入条数（不允许丢记忆，spec G4）', () => {
    const out = planBackfill(rows, liveSessions)
    expect(out).toHaveLength(rows.length)
  })
})

describe('applyManualMap（存量记忆没有 sessionId，只能人工给归属）', () => {
  const live = new Set(['sess-a', 'sess-b'])
  const rows = [
    { id: '1', judgedScope: 'canvas' as const, content: '短剧《小熊和小爸爸》项目信息：主角小柚' },
    { id: '2', judgedScope: 'canvas' as const, content: '《回声鉴定所》角色 bible：林昭' },
    { id: '3', judgedScope: 'user' as const, content: '暗号是紫罗兰七号' },
  ]

  it('按关键词子串把 canvas 行指到指定画布', () => {
    const m = applyManualMap(rows, { 小熊和小爸爸: 'sess-a', 回声鉴定所: 'sess-b' }, live)
    expect(m.get('1')).toBe('sess-a')
    expect(m.get('2')).toBe('sess-b')
  })

  it('user 行永不被映射（凭据类不该被塞进某个画布）', () => {
    const m = applyManualMap(rows, { 暗号: 'sess-a' }, live)
    expect(m.has('3')).toBe(false)
  })

  it('映射指向不存在的画布 → 抛错（拒绝悬空归属，不静默跳过）', () => {
    expect(() => applyManualMap(rows, { 小熊和小爸爸: 'sess-gone' }, live)).toThrow(/不存在/)
  })

  it('未命中任何关键词的行不进映射（保持无归属，由planBackfill 决定回退）', () => {
    const m = applyManualMap(rows, { 完全无关: 'sess-a' }, live)
    expect(m.size).toBe(0)
  })

  it('判定依据是 judgedScope（内容分类结果），不是 DB 里的旧 scope', () => {
    //回归锁：曾经用 `r.scope` 判读，调用方传的是 classifyMemory 结果（另一个字段），
    // 映射静默 0 命中——回填"看起来跑过了"却一条都没收紧。
    const misread = [
      { id: 'x', scope: 'canvas', judgedScope: 'canvas' as const, content: '小熊和小爸爸项目信息' },
    ] as never
    expect(applyManualMap(misread, { 小熊: 'sess-a' }, live).get('x')).toBe('sess-a')
  })
})
