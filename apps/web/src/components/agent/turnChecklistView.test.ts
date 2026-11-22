import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'
import { deriveTurnChecklistView, isTurnFinalized } from './turnChecklistView'

const P = (over: Partial<AgentTaskProgressState> = {}): AgentTaskProgressState => ({
  items: [], finished: false, ...over,
} as AgentTaskProgressState)

describe('deriveTurnChecklistView', () => {
  it('items 空 / null → null（不留 0/0 空壳）', () => {
    expect(deriveTurnChecklistView(null)).toBeNull()
    expect(deriveTurnChecklistView(P())).toBeNull()
  })

  it('状态词与 AgentTaskProgressCard 逐字一致，字段原样保留', () => {
    const v = deriveTurnChecklistView(P({ items: [
      { id: '1', title: '写脚本', activeForm: '正在写脚本', status: 'running' },
      { id: '2', title: '生成分镜', status: 'done', nodeId: 'node-2' },
      { id: '3', title: '导出', status: 'skipped', errorHint: '无需导出' },
      { id: '4', title: '重试', status: 'failed' },
    ] } as AgentTaskProgressState))!
    const byId = (id: string) => v.items.find((i) => i.id === id)!
    expect(byId('1').statusLabel).toBe('进行中')
    expect(byId('2').statusLabel).toBe('完成')
    expect(byId('3').statusLabel).toBe('已跳过')
    expect(byId('4').statusLabel).toBe('失败')
    expect(byId('2').nodeId).toBe('node-2')
    expect(byId('3').errorHint).toBe('无需导出')
  })

  it('done 计数只算 done/skipped', () => {
    const v = deriveTurnChecklistView(P({ items: [
      { id: '1', status: 'running', title: 'a' },
      { id: '2', status: 'done', title: 'b' },
      { id: '3', status: 'skipped', title: 'c' },
      { id: '4', status: 'failed', title: 'd' },
      { id: '5', status: 'needs_user', title: 'e' },
    ] } as AgentTaskProgressState))!
    expect(v.doneCount).toBe(2)
    expect(v.total).toBe(5)
  })
})

describe('checklistItemView（Codex 一手：排序 + 完成态字形单源）', () => {
  it('排序：进行中/重试 → 等待/失败/需处理 → 完成，进行中置顶完成沉底', () => {
    const v = deriveTurnChecklistView(P({ items: [
      { id: 'd', title: '已完成', status: 'done' },
      { id: 'p', title: '等待', status: 'pending' },
      { id: 'r', title: '进行中', status: 'running' },
      { id: 's', title: '跳过', status: 'skipped' },
      { id: 'rt', title: '重试', status: 'retrying' },
    ] } as AgentTaskProgressState))!
    expect(v.items.map((i) => i.id)).toEqual(['r', 'rt', 'p', 'd', 's']) // 同组内稳定保持原序
  })

  it('完成项带 ✓ 与删除线标记，未完成项无', () => {
    const v = deriveTurnChecklistView(P({ items: [
      { id: 'd', title: '已完成', status: 'done' },
      { id: 's', title: '跳过', status: 'skipped' },
      { id: 'r', title: '进行中', status: 'running' },
      { id: 'p', title: '等待', status: 'pending' },
    ] } as AgentTaskProgressState))!
    const byId = (id: string) => v.items.find((i) => i.id === id)!
    expect(byId('d').glyph).toBe('✓')
    expect(byId('d').done).toBe(true)
    expect(byId('s').glyph).toBe('✓')
    expect(byId('r').glyph).toBe('□')
    expect(byId('r').done).toBe(false)
    expect(byId('p').glyph).toBe('□')
  })
})

describe('isTurnFinalized（从旧模块迁入，判据不变）', () => {
  it('只认稳定 id notice:turn-summary', () => {
    expect(isTurnFinalized([])).toBe(false)
    expect(isTurnFinalized([{ kind: 'text', id: 'x', text: 'a', status: 'done' }])).toBe(false)
    expect(isTurnFinalized([{ kind: 'notice', id: 'notice:turn-summary', text: 'x' } as TimelinePart])).toBe(true)
  })
})

it('纯派生不得引计时/阶段分类/写操作', () => {
  const src = readFileSync('src/components/agent/turnChecklistView.ts', 'utf8')
  expect(src).not.toMatch(/Date\.now|setInterval|turnStatusLine|phaseForToolName|\.push\(/)
})
