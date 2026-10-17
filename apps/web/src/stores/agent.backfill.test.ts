import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CanvasAction } from '@lnkpi/shared'
import type { TimelinePart } from '@/components/agent/turnTimeline'
import { useAgentStore } from './agent'

/**
 * backfillTimelineNodeStatus（2026-10-17 晚到生成状态回填）回归锁。
 *
 * 背景：`node_status` SSE 事件当前无服务端生产者；回合流关闭后仍在生成的异步任务
 * （图片/视频常见），其终态没有任何通道进入时间线 ⇒ artifact part 永远停在
 * pending/running（无缩略图、无定位按钮）——「回合结束后产物消失」的根因之一。
 * useGenerationPolling 拿到权威终态后经本方法回填（SideRail 轮询回调接线）。
 */

const addNode = (id: string, nodeType = 'image', title = '开场视频'): CanvasAction =>
  ({
    type: 'add_node',
    payload: { id, nodeType, data: { title } },
  }) as CanvasAction

function assistantMessages(store: ReturnType<typeof useAgentStore>) {
  return store.messages.filter((m) => m.role === 'assistant')
}

describe('agent store — backfillTimelineNodeStatus（晚到生成状态回填）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('⭐ 回填归属「持有该 nodeId artifact part」的回合，不污染更新回合的时间线', () => {
    const store = useAgentStore()
    // 第一回合：建产物（pending）→ 回合收束（finalize，产物仍 pending）
    store.startAssistantMessage()
    store.addCanvasAction(addNode('n1', 'video', '开场视频'))
    store.finishStreaming()
    const firstTurn = assistantMessages(store).at(-1)!
    expect(firstTurn.timeline).toBeTruthy()
    expect(
      firstTurn.timeline!.parts.find((p) => p.kind === 'artifact' && p.nodeId === 'n1'),
    ).toBeTruthy()

    // 用户又发了一轮（新的 assistant 消息成为「最后一条」）
    store.startAssistantMessage()
    const secondTurn = assistantMessages(store).at(-1)!
    expect(secondTurn.id).not.toBe(firstTurn.id)

    // 流关闭后才拿到的权威终态 → 回填
    store.backfillTimelineNodeStatus({
      nodeId: 'n1',
      status: 'done',
      url: 'https://cdn/v.mp4',
    })

    const part = firstTurn.timeline!.parts.find(
      (p): p is Extract<TimelinePart, { kind: 'artifact' }> =>
        p.kind === 'artifact' && p.nodeId === 'n1',
    )
    expect(part?.status, '产物翻 done（定位按钮/缩略图的出现条件）').toBe('done')
    expect(part?.url).toBe('https://cdn/v.mp4')
    expect(
      secondTurn.timeline,
      '归属判定命中即 return，新回合不得被塞进别人的产物',
    ).toBeUndefined()
  })

  it('回合收束后回填会刷新摘要 notice（「已生成 N 个产物」补计晚到的 done）', () => {
    const store = useAgentStore()
    store.startAssistantMessage()
    store.addCanvasAction(addNode('n1'))
    store.finishStreaming()
    const turn = assistantMessages(store).at(-1)!
    const summaryNotice = turn.timeline!.parts.find(
      (p): p is Extract<TimelinePart, { kind: 'notice' }> =>
        p.id === 'notice:turn-summary',
    )
    expect(summaryNotice, 'finalize 追加的摘要 notice（稳定 id）').toBeTruthy()
    expect(summaryNotice!.text).not.toContain('已生成')

    store.backfillTimelineNodeStatus({ nodeId: 'n1', status: 'done' })
    expect(summaryNotice!.text).toContain('已生成 1 个产物')
  })

  it('找不到归属（timeline 无该 nodeId）⇒ 不伪造（不新建 part、不动任何消息）', () => {
    const store = useAgentStore()
    store.startAssistantMessage()
    store.addCanvasAction(addNode('n1'))
    store.finishStreaming()
    const turn = assistantMessages(store).at(-1)!
    const before = JSON.stringify(turn.timeline)

    store.backfillTimelineNodeStatus({ nodeId: 'ghost-node', status: 'done' })
    expect(JSON.stringify(turn.timeline)).toBe(before)
    expect(turn.timeline!.parts.some((p) => p.kind === 'artifact' && p.nodeId === 'ghost-node')).toBe(false)
  })

  it('非法入参（缺 nodeId/status）静默忽略', () => {
    const store = useAgentStore()
    store.startAssistantMessage()
    store.addCanvasAction(addNode('n1'))
    expect(() => {
      store.backfillTimelineNodeStatus({ nodeId: '', status: 'done' })
      store.backfillTimelineNodeStatus({ nodeId: 'n1', status: '' })
    }).not.toThrow()
  })
})
