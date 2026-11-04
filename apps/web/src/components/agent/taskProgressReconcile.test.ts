/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { emptyTaskProgress, type AgentTaskProgressState } from './agentTaskProgress'
import {
  collectBackfillOwnableNodeIds,
  reconcileTaskProgress,
  shouldFinishTaskCard,
  synthesizeSummary,
} from './taskProgressReconcile'

describe('taskProgressReconcile', () => {
  it('maps completed+url to done and finishes when no generating images', () => {
    let state: AgentTaskProgressState = emptyTaskProgress()
    state = {
      ...state,
      items: [
        { id: 'banner', title: 'Banner', nodeId: 'i1', kind: 'image', status: 'running' },
        {
          id: 'copy_main',
          title: '主文案',
          nodeId: 't1',
          kind: 'text',
          status: 'needs_user',
          errorHint: '请确认主文案后写入',
        },
      ],
    }
    const nodes = [
      { id: 'i1', type: 'image', data: { status: 'completed', url: 'https://x/a.png' } },
      { id: 't1', type: 'text', data: { status: 'draft', content: '' } },
    ]
    state = reconcileTaskProgress(state, nodes)
    expect(state.items[0].status).toBe('done')
    expect(state.items[1].status).toBe('needs_user')
    expect(shouldFinishTaskCard(state, nodes)).toBe(true)
    const summary = synthesizeSummary(state)
    expect(summary.success).toBe(1)
    expect(summary.needsUser).toBe(1)
  })

  it('does not finish while an image is generating', () => {
    const state: AgentTaskProgressState = {
      ...emptyTaskProgress(),
      items: [{ id: 'banner', title: 'Banner', nodeId: 'i1', kind: 'image', status: 'running' }],
    }
    const nodes = [{ id: 'i1', type: 'image', data: { status: 'generating' } }]
    expect(shouldFinishTaskCard(state, nodes)).toBe(false)
  })
})

/**
 * 2026-11-05 真机修复 Q1：文本/HTML 产物不进交付条。
 * 根因 = reconcileFromNodes 归属预筛只认「已有 artifact part」，而文本产物
 * （自动审批无确认点 + 完成走 followUp 无 node_status）永远建不出 part ⇒
 * 归属集必须同时认 pendingNodeMeta（deferred 建卡），否则对账回填永远跳过。
 */
describe('collectBackfillOwnableNodeIds — 回填归属集', () => {
  it('收集 artifact part 的 nodeId 与 pendingNodeMeta 的 keys', () => {
    const messages = [
      { role: 'user', timeline: { parts: [{ kind: 'artifact', nodeId: 'u1' }], pendingNodeMeta: { u2: {} } } },
      { role: 'assistant', timeline: null },
      {
        role: 'assistant',
        timeline: {
          parts: [{ kind: 'artifact', nodeId: 'i1' }, { kind: 'text' }],
          pendingNodeMeta: { t1: { nodeType: 'text', title: '文案' } },
        },
      },
    ]
    const owned = collectBackfillOwnableNodeIds(messages as never)
    expect(owned.has('i1'), '已有 artifact part ⇒ 归属').toBe(true)
    expect(owned.has('t1'), 'pendingNodeMeta 暂存（文本产物唯一入口）⇒ 归属').toBe(true)
    expect(owned.has('u1'), 'user 消息不参与').toBe(false)
    expect(owned.has('u2'), 'user 消息的 meta 不参与').toBe(false)
    expect(owned.size).toBe(2)
  })

  it('无 timeline / 无 artifact 无 meta ⇒ 空集', () => {
    expect(collectBackfillOwnableNodeIds([]).size).toBe(0)
    expect(
      collectBackfillOwnableNodeIds([
        { role: 'assistant', timeline: { parts: [{ kind: 'text' }], pendingNodeMeta: {} } },
      ] as never).size,
    ).toBe(0)
  })
})
