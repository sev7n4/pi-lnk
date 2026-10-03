import { describe, expect, it } from 'vitest'
import { planContentCleanup } from './message-content-cleanup'

/**
 * 存量助手消息 content 清洗的纯逻辑。
 *
 * 生产取证（2026-10-03，部署 Q2 修复前）：
 *   assistant 消息 10199 条
 *     首部空白 283（2.77%）→ 剥后有正文 205 /剥后全空 78
 *     尾部空白 89
 *     纯空白 69 条 —— **全部带 metadata.executionEvents**（模型只吐
 *                     thinking/toolCalls 而没吐正文），属正常状态，**不能删**。
 *
 * 清洗口径（与 text-normalize 同一套规则，避免两套实现漂移）：
 *   - 首部空行 / 尾部空行剥掉
 *   - 剥完为空的**保留行**（content 置空串），因为这些行靠executionEvents /
 *     presentation 才有价值，删行= 丢思考链与工具轨迹
 *   - 首部不是空白的行**一个字节都不动**（含 5 条 len=1/codepoint=32 的旧兜底残留，
 *     它们首部是空格，严格说该剥；但 content 为纯空白时剥完是空串，
 *     与「保留行置空」是同一结果，不会误伤正文）
 */
describe('planContentCleanup（存量 content 清洗，纯逻辑）', () => {
  const row = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
    id,
    content,
    hasExecutionEvents: false,
    hasPresentation: false,
    hasToolCalls: false,
    ...extra,
  })

  it('无脏数据 → 不产出任何变更', () => {
    const plan = planContentCleanup([row('a', '普通回复'), row('b', '多行\n回复')])
    // total 是输入行数（= 2），changed 才是需要变更的行数
    expect(plan).toEqual({ total: 2, changed: 0, toEmpty: 0, toText: 0, dropped: 0, ids: [] })
  })

  it('空输入 → 全零计划', () => {
    expect(planContentCleanup([])).toEqual({
      total: 0, changed: 0, toEmpty: 0, toText: 0, dropped: 0, ids: [],
    })
  })

  it('首部空行 + 尾部空行一起剥（生产 205 条那类）', () => {
    const plan = planContentCleanup([row('a', '\n\n\n实际回答\n\n\n')])
    expect(plan.total).toBe(1)
    expect(plan.changed).toBe(1)
    expect(plan.toText).toBe(1)
    expect(plan.ids).toEqual(['a'])
  })

  it('剥完为空的行 → 置空 content 而非删行，且不依赖 payload 标记', () => {
    // 关键：不能因为「text 空」就认为该删。这些行携带 executionEvents。
    const plan = planContentCleanup([
      row('a', '\n\n\n', { hasExecutionEvents: true }),
      row('b', ' \n', { hasExecutionEvents: true }),
      row('c', ' ', {}),
    ])
    expect(plan.changed).toBe(3)
    expect(plan.toEmpty).toBe(3)
    expect(plan.toText).toBe(0)
    expect(plan.ids.sort()).toEqual(['a', 'b', 'c'])
  })

  it('删除整行：仅当行既无 content 又无任何结构载荷时（0 命中，防御性口径）', () => {
    const plan = planContentCleanup([row('a', '\n\n', {})])
    // 保守：即便无载荷也只置空不删行——删行会改变对话轮次编号，风险高于收益。
    expect(plan.toEmpty).toBe(1)
    expect(plan.dropped).toBe(0)
  })

  it('【防误伤】正文内部结构一字不动：markdown 段落/ 列表 / 缩进代码块', () => {
    const bodies = [
      '第一段\n\n第二段',
      '- a\n- b\n- c',
      '  ```\n  code\n  ```',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '正文里本来就有的空行\n\n以及后续',
    ]
    for (const body of bodies) {
      const plan = planContentCleanup([row('x', body)])
      expect(plan.changed, `body=${JSON.stringify(body)}`).toBe(0)
    }
  })

  it('【防误伤】无前置空行但尾部有空行 → 该行确实需要改，且只改尾部', () => {
    const plan = planContentCleanup([row('a', '正文\n\n\n')])
    expect(plan.changed).toBe(1)
    expect(plan.toText).toBe(1)
  })

  it('【防误伤】CRLF 正文：中间 CRLF 保留', () => {
    const plan = planContentCleanup([row('a', '\r\n\r\n正文\r\n第二行\r\n\r\n')])
    expect(plan.changed).toBe(1)
    expect(plan.toText).toBe(1)
  })

  it('【防误伤】中英文/emoji/全角空格内容不受影响', () => {
    const bodies = ['普通回复 ✓', 'emoji 🌸 内容', '全角　空格在正文里', 'English only']
    for (const body of bodies) {
      expect(planContentCleanup([row('x', body)]).changed, body).toBe(0)
    }
  })

  it('幂等：对已清洗结果再跑一次 → 0 变更（可安全重跑）', () => {
    const once = planContentCleanup([row('a', '\n\n\n实际回答\n\n\n')])
    expect(once.changed).toBe(1)
    // 模拟 apply 后再跑：内容已是'实际回答'
    expect(planContentCleanup([row('a', '实际回答')]).changed).toBe(0)
  })

  it('多行批量：toText / toEmpty 分类计数正确', () => {
    const plan = planContentCleanup([
      row('a', '\n\n正文A'),
      row('b', '\n\n正文B\n\n'),
      row('c', '\n\n', { hasExecutionEvents: true }),
      row('d', '干净'),
    ])
    expect(plan.total).toBe(4)
    expect(plan.changed).toBe(3)
    expect(plan.toText).toBe(2)
    expect(plan.toEmpty).toBe(1)
    expect(plan.dropped).toBe(0)
  })
})
