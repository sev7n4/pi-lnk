import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeHistoryMessages } from './historySanitize'

// ⚠️ 不用 `new URL('./AgentSideRail.vue', import.meta.url)`：vitest 环境下相对
// URL 解析抛 "The URL must be of scheme file"，与 AgentSideRail.historyRetryCard.test.ts
// 同款 dirname/join 模式对齐。
const here = dirname(fileURLToPath(import.meta.url))

const row = (over: Partial<{ id: string; role: string; content: string; metadata: string | null }>) => ({
  id: 'm',
  role: 'assistant',
  content: '正文',
  metadata: null,
  ...over,
})

describe('sanitizeHistoryMessages（规格 H1-d / §8 / 验收 S8）', () => {
  it('metadata 损坏 ⇒ 行保留并列入 degradedIds（D15：与「本来就没有过程」可区分）', () => {
    const r = row({ id: 'm1', metadata: '{oops' })
    const s = sanitizeHistoryMessages([r])
    expect(s.rows).toHaveLength(1)
    expect(s.degradedIds.has('m1')).toBe(true)
  })
  it('空 assistant 行（无正文无 metadata）⇒ 剔除并计数（D16：不干扰任务卡恢复定位）', () => {
    const s = sanitizeHistoryMessages([row({ id: 'm1', content: '' })])
    expect(s.rows).toHaveLength(0)
    expect(s.droppedEmptyAssistant).toBe(1)
  })
  it('纯机器载荷 user 行（__new_task__）⇒ 剔除（K4；DB 原文不动，回合分类不受影响）', () => {
    const s = sanitizeHistoryMessages([
      row({ id: 'm1', role: 'user', content: '__new_task__' }),
      row({ id: 'm2', role: 'user', content: '帮我把这张图改成夜景' }),
    ])
    expect(s.rows.map((r) => r.id)).toEqual(['m2'])
  })
  it('恢复定位取最后一条非空 assistant（D16/D17）', () => {
    const s = sanitizeHistoryMessages([
      row({ id: 'm1', role: 'user', content: 'q' }),
      row({ id: 'm2', role: 'assistant', content: '' }),
      row({ id: 'm3', role: 'assistant', content: '完成' }),
    ])
    expect(s.lastRenderableAssistantIndex).toBe(2)
  })
  it('全畸形输入得空结果而非抛错（Review Focus #4）', () => {
    const s = sanitizeHistoryMessages([
      row({ id: 'm1', content: '', metadata: '{oops' }),
      row({ id: 'm2', content: '' }),
    ])
    expect(s.rows).toHaveLength(0)
    expect(s.lastRenderableAssistantIndex).toBe(-1)
  })

  it('AgentSideRail 恢复锚点消费非空 assistant（§8④ 消费点：防空行 metadata 污染任务卡恢复）', () => {
    const rail = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')
    expect(rail).toContain("find((m) => m.role === 'assistant' && m.content?.trim())")
  })
})
