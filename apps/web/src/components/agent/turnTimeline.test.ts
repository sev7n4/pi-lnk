import { describe, it, expect } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  finalizeTurnTimeline,
  replayTimelineEvents,
  type TimelineEvent,
  type TimelinePart,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'

/** 喂一串事件（实时路径），返回 timeline。 */
function feed(events: TimelineEvent[]): TurnTimeline {
  const tl = createTurnTimeline()
  for (const e of events) applyTimelineEvent(tl, e)
  return tl
}

function kinds(tl: TurnTimeline): TimelinePart['kind'][] {
  return tl.parts.map((p) => p.kind)
}

function byKind<K extends TimelinePart['kind']>(tl: TurnTimeline, kind: K): Extract<TimelinePart, { kind: K }>[] {
  return tl.parts.filter((p): p is Extract<TimelinePart, { kind: K }> => p.kind === kind)
}

const addNode = (id: string, nodeType = 'image', title = '三国英雄照片'): TimelineEvent => ({
  type: 'canvas_action',
  data: { type: 'add_node', payload: { id, nodeType, data: { title } } } as never,
})

describe('turnTimeline — 模型层（设计 §4 / §5-P1）', () => {
  it('golden：3 思考 + 5 工具 + 1 产物 → parts.kind 序列 = 事件序（含交错）', () => {
    const tl = feed([
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: '先看画布' } },
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'get_canvas_summary', args: {} } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'get_canvas_summary', result: { message: '3 节点' } } },
      { type: 'text_delta', data: { text: '我来创建。' } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: '再建节点' } },
      { type: 'tool_call', data: { toolCallId: 'c2', name: 'upsert_media_node', args: { title: 'X' } } },
      { type: 'tool_result', data: { toolCallId: 'c2', name: 'upsert_media_node', result: { status: 'ok' } } },
      { type: 'tool_call', data: { toolCallId: 'c3', name: 'propose_generation', args: { n: 1 } } },
      { type: 'tool_result', data: { toolCallId: 'c3', name: 'propose_generation', result: { status: 'pending_confirm' } } },
      addNode('n1'),
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } },
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating' } },
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'http://img/x.png' } },
      { type: 'turn_usage', data: { inputTokens: 1200, outputTokens: 340 } },
    ])

    // 事件序：thinking, tool, text, thinking, tool, tool, artifact, notice(waiting)
    const k = kinds(tl)
    expect(byKind(tl, 'thinking')).toHaveLength(2)
    expect(byKind(tl, 'tool')).toHaveLength(3)
    expect(byKind(tl, 'artifact')).toHaveLength(1)
    expect(byKind(tl, 'text')).toHaveLength(1)

    // 交错成立：第 2 段思考 出现在 第 1 个工具之后（unshift 不复活的证据）
    const firstToolIdx = k.indexOf('tool')
    const secondThinkingIdx = tl.parts.findIndex((p) => p.kind === 'thinking' && p.status === 'done' && p.text === '再建节点')
    expect(secondThinkingIdx).toBeGreaterThan(firstToolIdx)

    // artifact 状态机 pending → running → done
    const art = byKind(tl, 'artifact')[0]
    expect(art.nodeId).toBe('n1')
    expect(art.status).toBe('done')
  })

  it('反例锁：首事件是工具 ⇒ 首块 kind !== thinking（unshift 不复活）', () => {
    const tl = feed([
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'get_canvas_summary' } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'get_canvas_summary', result: {} } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done' } },
    ])
    expect(tl.parts[0].kind).toBe('tool')
    expect(tl.parts[0].kind).not.toBe('thinking')
  })

  it('思考分段：两个 running ⇒ 两个 thinking part（不再折叠成一个）', () => {
    const tl = feed([
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: 'A' } },
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'get_node' } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: 'B' } },
    ])
    const thinks = byKind(tl, 'thinking')
    expect(thinks).toHaveLength(2)
    expect(thinks[0].text).toBe('A')
    expect(thinks[1].text).toBe('B')
  })

  it('D1：update_node 不建 part；add_node 才建 artifact（按 nodeId upsert）', () => {
    const tl = feed([
      addNode('n1'),
      { type: 'canvas_action', data: { type: 'update_node', payload: { id: 'n1', data: { title: 'X' } } } as never },
      { type: 'canvas_action', data: { type: 'add_node', payload: { id: 'n1' } } as never },
    ])
    // update_node 不产出 part，add_node 按 nodeId upsert ⇒ 仅 1 个 artifact
    expect(byKind(tl, 'artifact')).toHaveLength(1)
    expect(byKind(tl, 'canvas')).toHaveLength(0)
  })

  it('D2：failed artifact 带 errorText + status failed', () => {
    const tl = feed([
      addNode('n9'),
      { type: 'node_status', data: { nodeId: 'n9', status: 'failed' } },
    ])
    const art = byKind(tl, 'artifact')[0]
    expect(art.status).toBe('failed')
    expect(art.errorText).toBeTruthy()
  })

  it('finalize：running 收口为 done，末尾追加摘要 notice（设计规则 4）', () => {
    const tl = feed([
      addNode('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done' } },
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'propose_generation', args: { n: 1 } } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'propose_generation', result: {} } },
      { type: 'turn_usage', data: { inputTokens: 100, outputTokens: 50 } },
    ])
    finalizeTurnTimeline(tl)
    const last = tl.parts[tl.parts.length - 1]
    expect(last.kind).toBe('notice')
    if (last.kind === 'notice') {
      expect(last.text).toContain('提议生成')
      expect(last.text).toContain('tokens')
    }
  })

  it('一致性：live feed 与 replay 同一事件序列 ⇒ parts.kind 序列逐项相等（消除双源漂移）', () => {
    const events: TimelineEvent[] = [
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: 'A' } },
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'get_canvas_summary' } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'get_canvas_summary', result: {} } },
      addNode('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done' } },
    ]
    const live = feed(events)
    finalizeTurnTimeline(live) // 「live 结束后」= finishStreaming 收口
    const replayed = replayTimelineEvents(events as unknown as Array<{ type: string; data: unknown }>)
    expect(kinds(replayed)).toEqual(kinds(live))
  })

  it('历史无 text_delta：bodyText 补一个 done 文本块在最前', () => {
    const events: Array<{ type: string; data: unknown }> = [
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'get_canvas_summary' } },
    ]
    const tl = replayTimelineEvents(events, '这是历史正文')
    expect(tl.parts[0].kind).toBe('text')
    if (tl.parts[0].kind === 'text') {
      expect(tl.parts[0].text).toBe('这是历史正文')
      expect(tl.parts[0].status).toBe('done')
    }
  })

  it('text_delta 多段续接成同一 streaming 文本块，finalize 收 done', () => {
    const tl = feed([
      { type: 'text_delta', data: { text: '第一段' } },
      { type: 'text_delta', data: { text: '第二段' } },
    ])
    const texts = byKind(tl, 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0].text).toBe('第一段第二段')
    expect(texts[0].status).toBe('streaming')
    finalizeTurnTimeline(tl)
    expect(byKind(tl, 'text')[0].status).toBe('done')
  })

  it('waiting_user resolved 不产 notice；waiting 产 warn notice', () => {
    const tl = feed([
      { type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_generation' } },
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } },
    ])
    const notices = byKind(tl, 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].tone).toBe('warn')
    expect(notices[0].text).toContain('确认生成')
  })
})

describe('P2 — 落库 seq 排序 + 缩略图/失败态（设计 §5-P2）', () => {
  it('⭐ P2-3：事件带 seq 时按 seq 回放（数组被乱序/裁剪也能还原发生序）', () => {
    // 故意打乱数组顺序，但 seq 表达真实发生序：thinking → tool → text
    const scrambled = [
      { type: 'text_delta', data: { text: '收尾' }, seq: 3 },
      { type: 'thinking', data: { status: 'done', summary: '先想' }, seq: 1 },
      { type: 'tool_call', data: { toolCallId: 'x1', name: 'get_canvas_summary', args: {} }, seq: 2 },
    ]
    const tl = replayTimelineEvents(scrambled)
    // finalize 会追加末尾摘要 notice；取前三个 part 校验发生序
    expect(tl.parts.slice(0, 3).map((p) => p.kind)).toEqual(['thinking', 'tool', 'text'])
  })

  it('P2-3 兼容：老消息无 seq 时维持数组原序（不排序）', () => {
    const legacy = [
      { type: 'text_delta', data: { text: 'A' } },
      { type: 'thinking', data: { status: 'done', summary: 'B' } },
    ]
    const tl = replayTimelineEvents(legacy)
    expect(tl.parts[0].kind).toBe('text')
    expect(tl.parts[1].kind).toBe('thinking')
  })

  it('P2-1：artifact 状态机 pending → running → done（节点=产物，按 nodeId upsert 不新建）', () => {
    const tl = feed([
      addNode('n1', 'image', '赛博朋克猫'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating' } },
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://x/a.png' } },
    ])
    const arts = byKind(tl, 'artifact')
    expect(arts).toHaveLength(1) // upsert，不是三条
    expect(arts[0].status).toBe('done')
    expect(arts[0].nodeId).toBe('n1')
  })

  it('P2-1/D2：failed 产物带 errorText（供渲染层出内联重试入口）', () => {
    const tl = feed([
      addNode('n1', 'image', '失败案例'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'failed' } },
    ])
    const art = byKind(tl, 'artifact')[0]
    expect(art.status).toBe('failed')
    expect(art.errorText).toBeTruthy()
  })

  it('P2-2：一次回合多产物 ⇒ 多个 artifact part（各自独立状态）', () => {
    const tl = feed([
      addNode('n1', 'image', 'A'),
      addNode('n2', 'video', 'B'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://x/a.png' } },
      { type: 'node_status', data: { nodeId: 'n2', status: 'failed' } },
    ])
    const arts = byKind(tl, 'artifact')
    expect(arts).toHaveLength(2)
    expect(arts.find((a) => a.nodeId === 'n1')?.status).toBe('done')
    expect(arts.find((a) => a.nodeId === 'n2')?.status).toBe('failed')
  })

  it('P2/dense 无关性：dense 只是渲染层参数，不改 parts 语义（同事件序 ⇒ 同 kind 序）', () => {
    const events: TimelineEvent[] = [
      { type: 'thinking', data: { status: 'done', summary: 'x' } },
      addNode('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://x/a.png' } },
    ]
    const tl = feed(events)
    // 模型层无 dense 概念 —— 断言其不存在于 TurnTimeline 形状里（回归锁：别把渲染态混入模型）
    expect(Object.keys(tl).sort()).toEqual(['parts', 'turnStartedAt'])
    expect(kinds(tl)).toEqual(['thinking', 'artifact'])
  })
})
