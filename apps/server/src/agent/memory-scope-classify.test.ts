import { describe, expect, it } from 'vitest'
import { applyManualMap, classifyMemory, planBackfill, type BackfillTargetRow } from './memory-scope-classify'

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

  /**
   * 终审 I-2 回归锁：偏好词（以后/永远/喜欢/默认用）不能把**项目知识**降级成跨画布 user，
   * 否则 G1 反向违反——小柚的设定被判成跨画布可见，事故形态原样保留。
   * 凭据类仍必须 user（安全侧优先），所以让位的只是「偏好」这一档。
   */
  it('项目词 + 偏好词同句 ⇒ canvas（偏好让位给项目归属）', () => {
    expect(classifyMemory('《小熊和小爸爸》主角小柚以后都用齐刘海低马尾').scope).toBe('canvas')
    expect(classifyMemory('《回声鉴定所》角色林昭喜欢 1080x1440 画幅').scope).toBe('canvas')
    expect(classifyMemory('剧本第 3 集场景：实验室，以后按这个设定走').scope).toBe('canvas')
  })

  it('纯偏好（无项目词）仍判 user', () => {
    expect(classifyMemory('以后都用深色主题').scope).toBe('user')
    expect(classifyMemory('喜欢圆形节点').scope).toBe('user')
  })

  it('「合集/集合」等泛化词不再误判为项目知识（终审 I-2：`集` 字过宽）', () => {
    expect(classifyMemory('用户的素材集合按时间排列').scope).toBe('user')
    expect(classifyMemory('参考素材的合集放在共享盘').scope).toBe('user')
  })

  it('「第 N 集」这类真正的集数表述仍判 canvas', () => {
    expect(classifyMemory('第 3 集：客厅对峙').scope).toBe('canvas')
    expect(classifyMemory('EP01-EP10 共 10 集').scope).toBe('canvas')
  })
})

/** 把「单scope 形态」的旧用例转成新签名：DB 现状与目标一致（已落库态）。 */
const asTargets = (rows: Array<{ id: string; scope: string; sessionId: string | null }>): BackfillTargetRow[] =>
  rows.map((r) => ({
    id: r.id,
    dbScope: r.scope,
    dbSessionId: r.sessionId,
    targetScope: r.scope as 'canvas' | 'user',
    targetSessionId: r.sessionId,
  }))

describe('planBackfill', () => {
  const rows = [
    { id: 'a', scope: 'canvas', sessionId: 'sess-1' },
    { id: 'b', scope: 'canvas', sessionId: 'sess-gone' }, // 画布已删
    { id: 'c', scope: 'canvas', sessionId: null }, // 悬空归属
  ]
  const liveSessions = new Set(['sess-1'])

  it('sessionId 指向已删画布 → 回退 user，不留悬空 canvas 行（Review Focus #5）', () => {
    const out = planBackfill(asTargets(rows), liveSessions)
    const b = out.find((r) => r.id === 'b')!
    expect(b.scope).toBe('user')
    expect(b.sessionId).toBeNull()
    expect(b.reason).toMatch(/画布已不存在/)
  })

  it('sessionId 为空 → 回退 user', () => {
    const out = planBackfill(asTargets(rows), liveSessions)
    expect(out.find((r) => r.id === 'c')!.scope).toBe('user')
  })

  it('sessionId 有效 → 落 canvas', () => {
    const out = planBackfill(asTargets(rows), liveSessions)
    const a = out.find((r) => r.id === 'a')!
    expect(a.scope).toBe('canvas')
    expect(a.sessionId).toBe('sess-1')
  })

  it('目标与 DB 值一致 → changed=false（幂等：重复跑不写库）', () => {
    const out = planBackfill([{ id: 'd', dbScope: 'user', dbSessionId: null, targetScope: 'user', targetSessionId: null }], liveSessions)
    expect(out[0].scope).toBe('user')
    expect(out[0].changed).toBe(false)
  })

  it('changed 标记只在该行真的需要写库时为 true', () => {
    // DB 与目标同源时：a（归属有效）无需写；b（画布已删）必须写——它要落回 user 才不留悬空
    const settled = planBackfill(asTargets(rows), liveSessions)
    expect(settled.find((r) => r.id === 'a')!.changed).toBe(false)
    expect(settled.find((r) => r.id === 'b')!.changed).toBe(true)
    // 目标归属也全丢（模拟存量：DB 与目标都是 user）⇒ 全部已是目标态，一行都不写。
    // 这正是终审C-2 的病根：调用方曾把「判定值」当 DB 旧值传进来，于是永远得出"没变"。
    const fresh = planBackfill(
      rows.map((r) => ({ id: r.id, dbScope: 'user', dbSessionId: null, targetScope: 'user' as const, targetSessionId: null })),
      liveSessions,
    )
    expect(fresh.every((r) => !r.changed)).toBe(true)
    // 而DB 是 user、目标要落 canvas（sess-1有效）⇒ 这一行必须被标出来。
    const tighten = planBackfill(
      rows.map((r) => ({
        id: r.id,
        dbScope: 'user',
        dbSessionId: null,
        targetScope: 'canvas' as const,
        targetSessionId: r.sessionId,
      })),
      liveSessions,
    )
    expect(tighten.find((r) => r.id === 'a')!.changed).toBe(true)
  })

  it('行数守恒：输出条数 = 输入条数（不允许丢记忆，spec G4）', () => {
    expect(planBackfill(asTargets(rows), liveSessions)).toHaveLength(rows.length)
  })
})

/**
 * 终审 C-2 回归锁：`dbScope` 必须是**DB 真实值**，`targetScope` 才是分类判定值。
 * 原实现只有一个 `scope` 入参，被当「旧值」比较，而调用方传的是「新判定值」⇒
 * 有完整映射时 changed 恒为 0，`--apply` 一行都不写，目标态只存在于打印输出里。
 */
describe('planBackfill：dbScope 与 targetScope 必须分开（终审 C-2）', () => {
  const live = new Set(['sess-a'])

  it('DB 现状 user + 判定 canvas + 有归属 ⇒ changed=true（这正是要写库的那批）', () => {
    const out = planBackfill([{ id: 'x', dbScope: 'user', dbSessionId: null, targetScope: 'canvas', targetSessionId: 'sess-a' }], live)
    expect(out[0].changed).toBe(true)
    expect(out[0].scope).toBe('canvas')
    expect(out[0].sessionId).toBe('sess-a')
  })

  it('DB 已是 canvas 且归属一致 ⇒ changed=false（幂等，重复跑不写）', () => {
    const out = planBackfill([{ id: 'x', dbScope: 'canvas', dbSessionId: 'sess-a', targetScope: 'canvas', targetSessionId: 'sess-a' }], live)
    expect(out[0].changed).toBe(false)
  })

  it('DB 已是 canvas 但归属变了（画布换了）⇒ changed=true', () => {
    const out = planBackfill([{ id: 'x', dbScope: 'canvas', dbSessionId: 'sess-a', targetScope: 'canvas', targetSessionId: 'sess-b' }], new Set(['sess-a', 'sess-b']))
    expect(out[0].changed).toBe(true)
  })

  it('DB 是 canvas 但目标画布已删 ⇒ changed=true 且落回 user（不留悬空）', () => {
    const out = planBackfill([{ id: 'x', dbScope: 'canvas', dbSessionId: 'sess-a', targetScope: 'canvas', targetSessionId: 'sess-gone' }], live)
    expect(out[0].changed).toBe(true)
    expect(out[0].scope).toBe('user')
    expect(out[0].sessionId).toBeNull()
  })

  it('DB 是 user + 判定 user ⇒ changed=false', () => {
    const out = planBackfill([{ id: 'x', dbScope: 'user', dbSessionId: null, targetScope: 'user', targetSessionId: null }], live)
    expect(out[0].changed).toBe(false)
  })

  it('生产实况回归：30 条 DB 全user + 完整映射 ⇒ changed 恰为 18（项目知识那批）', () => {
    const rows: BackfillTargetRow[] = [
      ...Array.from({ length: 18 }, (_, i) => ({ id: `c${i}`, dbScope: 'user', dbSessionId: null, targetScope: 'canvas', targetSessionId: 'sess-a' })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, dbScope: 'user', dbSessionId: null, targetScope: 'user', targetSessionId: null })),
    ]
    const out = planBackfill(rows, live)
    expect(out.filter((r) => r.changed)).toHaveLength(18)
    expect(out.filter((r) => r.scope === 'canvas')).toHaveLength(18)
    expect(out).toHaveLength(30)
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
