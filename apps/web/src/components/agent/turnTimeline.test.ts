import { describe, it, expect } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  finalizeTurnTimeline,
  refreshTimelineSummary,
  replayTimelineEvents,
  summarizeTimeline,
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

    // 2026-10-17：waiting_user 恢复单条 notice（双粒度：原因在 notice，倒计时在 dock 状态行）
    const waitingNotices = byKind(tl, 'notice')
    expect(waitingNotices).toHaveLength(1)
    expect(waitingNotices[0].id).toBe('notice:waiting')
    expect(waitingNotices[0].text).toBe('等待你在画布上确认生成，确认后继续输出')
    expect(waitingNotices[0].tone).toBe('warn')

    // 交错成立：第 2 段思考 出现在 第 1 个工具之后（unshift 不复活的证据）
    const firstToolIdx = k.indexOf('tool')
    const secondThinkingIdx = tl.parts.findIndex((p) => p.kind === 'thinking' && p.status === 'done' && p.text === '再建节点')
    expect(secondThinkingIdx).toBeGreaterThan(firstToolIdx)

    // artifact 状态机 pending → running → done
    const art = byKind(tl, 'artifact')[0]
    expect(art.nodeId).toBe('n1')
    expect(art.status).toBe('done')
  })

  it('TURN-IDENTITY PR3：孤儿 tool_result（无前置 tool_call）⇒ 出 notice，不伪造工具行', () => {
    // 生产漂移签名：订阅切片的首事件就是 tool_result，此前被 push 成 parts[0]
    // ⇒「提议生成」卡片顶到思考和工具消息之前。
    const tl = feed([
      { type: 'tool_result', data: { toolCallId: 'c9', name: 'propose_generation', result: {} } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: '思考' } },
    ])

    expect(byKind(tl, 'tool')).toHaveLength(0)
    const notices = byKind(tl, 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].tone).toBe('info')
    // 关键：不再占据首位（卡片漂移的直接成因）
    expect(kinds(tl)[0]).not.toBe('tool')
  })

  it('TURN-IDENTITY PR3：重复孤儿 tool_result 只出一条 notice（不刷屏）', () => {
    const tl = feed([
      { type: 'tool_result', data: { toolCallId: 'c9', name: 'propose_generation', result: {} } },
      { type: 'tool_result', data: { toolCallId: 'c9', name: 'propose_generation', result: {} } },
    ])
    expect(byKind(tl, 'notice')).toHaveLength(1)
  })

  it('TURN-IDENTITY PR3：partial 账本重放 ⇒ 顶部置一条缺口标注（不冒充完整过程）', () => {
    const events: TimelineEvent[] = [
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'propose_generation', args: {} } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'propose_generation', result: {} } },
    ]
    const tl = replayTimelineEvents(events as never[], '正文', { partial: true })
    expect(tl.parts[0]?.kind).toBe('notice')
    expect((tl.parts[0] as { text?: string }).text).toContain('前半段')

    // 对照：不传 partial ⇒ 不出**缺口**标注（键不出现纪律）
    // （回合收尾本身可能产生别的 notice，故只锁「缺口文案」这一条）
    const plain = replayTimelineEvents(events as never[], '正文')
    const gapNotices = byKind(plain, 'notice').filter((n) => n.text.includes('前半段'))
    expect(gapNotices).toHaveLength(0)
  })

  it('D2（Task 2）：truncated 账本重放 ⇒ 顶部置一条「尾部未捕获」标注（方向与 partial 相反）', () => {
    const events: TimelineEvent[] = [
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'propose_generation', args: {} } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'propose_generation', result: {} } },
    ]
    const tl = replayTimelineEvents(events as never[], '正文', { truncated: true })
    expect(tl.parts[0]?.kind).toBe('notice')
    expect((tl.parts[0] as { text?: string }).text).toContain('未捕获到生成结束')

    // 对照：不传 truncated ⇒ 不出「尾部缺口」标注（键不出现纪律）
    const plain = replayTimelineEvents(events as never[], '正文')
    const tailNotices = byKind(plain, 'notice').filter((n) => n.text.includes('未捕获到生成结束'))
    expect(tailNotices).toHaveLength(0)
  })

  it('D2（Task 2）：partial（头部缺口）与 truncated（尾部缺口）必须分别标注，不混用', () => {
    const events: TimelineEvent[] = [
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'propose_generation', args: {} } },
    ]
    // 两者同时为真（两头都不齐）⇒ 两条标注都在，且文案互不串味
    const both = replayTimelineEvents(events as never[], '正文', { partial: true, truncated: true })
    const notices = byKind(both, 'notice').map((n) => n.text)
    expect(notices.some((t) => t.includes('前半段'))).toBe(true)
    expect(notices.some((t) => t.includes('未捕获到生成结束'))).toBe(true)

    // ⛔ 反例锁：只有 partial 时**不得**出现尾部缺口文案（否则会说谎：尾部其实看到了）
    const headOnly = replayTimelineEvents(events as never[], '正文', { partial: true })
    const headNotices = byKind(headOnly, 'notice').map((n) => n.text)
    expect(headNotices.some((t) => t.includes('未捕获到生成结束'))).toBe(false)
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

  it('Q2：turn_usage 带预估积分 → 摘要「≈N 积分（预估）」，USD 内部成本口径不再透出', () => {
    const tl = feed([
      { type: 'turn_usage', data: { inputTokens: 8200, outputTokens: 400, cost: 0.0112, estimatedCredits: 8 } },
    ])
    finalizeTurnTimeline(tl)
    const last = tl.parts[tl.parts.length - 1]
    expect(last.kind).toBe('notice')
    if (last.kind === 'notice') {
      expect(last.text).toContain('≈8 积分（预估）')
      expect(last.text).not.toContain('费用')
    }
  })

  it('Q2：无预估积分（渠道未配 pricing）→ 摘要只显示 tokens，绝不显示 0 积分假象', () => {
    const tl = feed([{ type: 'turn_usage', data: { inputTokens: 100, outputTokens: 50 } }])
    finalizeTurnTimeline(tl)
    const last = tl.parts[tl.parts.length - 1]
    if (last.kind === 'notice') {
      expect(last.text).toContain('tokens')
      expect(last.text).not.toContain('积分')
    }
  })

  it('P2 T5：turn_usage 带 cache tokens → usage 透传 + 摘要合计 = input+cache+output（总量不缩水）；旧形态（无 cache 字段）不炸', () => {
    const tl = feed([
      { type: 'turn_usage', data: { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 30 } },
    ])
    expect(tl.usage).toEqual({
      inputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      outputTokens: 30,
    })
    expect(summarizeTimeline(tl)).toContain('消耗 380 tokens')

    const legacy = feed([{ type: 'turn_usage', data: { inputTokens: 100, outputTokens: 50 } }])
    expect(summarizeTimeline(legacy)).toContain('消耗 150 tokens')
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

  it('⭐ Fix 1+2：非文本事件收口 streaming 文本块 ⇒ text→tool→text 各成段、按序归位', () => {
    // 生产实证：live 路径此前不收口，所有 text_delta 堆进第一块文本、工具被压到下方（时序倒挂）
    const tl = feed([
      { type: 'text_delta', data: { text: '先说点什么。' } },
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'get_canvas_summary', args: {} } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'get_canvas_summary', result: {} } },
      { type: 'text_delta', data: { text: '工具跑完再说。' } },
    ])
    const texts = byKind(tl, 'text')
    expect(texts).toHaveLength(2)
    expect(texts[0].text).toBe('先说点什么。')
    expect(texts[1].text).toBe('工具跑完再说。')
    // 顺序：text[0] → tool → text[1]（工具穿插在两段文本之间，不前置、不后置）
    expect(kinds(tl)).toEqual(['text', 'tool', 'text'])
    // 收口：第一段在工具事件后已翻 done，第二段直到 finalize 才收
    expect(texts[0].status).toBe('done')
    expect(texts[1].status).toBe('streaming')
    finalizeTurnTimeline(tl)
    expect(byKind(tl, 'text')[1].status).toBe('done')
  })

  it('⭐ 落库 text 段按发生位置归位（2026-10-14 时序倒挂修复）：thinking → text → tool ⇒ text 在中间', () => {
    // 生产实证场景：ask_user 后 agent 的回复正文（「用户选择了…」）此前只存整条
    // message.content，重放时 unshift 到最前 ⇒ 跑到 ask/工具行上面。服务端现在把
    // 正文按段落库为 text 事件，重放必须按事件序插入，不前置。
    const events: Array<{ type: string; data: unknown }> = [
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: '用户已选择风格' } },
      { type: 'text', data: { text: '用户选择了皮克斯风格，我现在开始生成。' } },
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'propose_generation' } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'propose_generation' } },
    ]
    const tl = replayTimelineEvents(events)
    expect(kinds(tl)).toEqual(['thinking', 'text', 'tool', 'notice'])
    const textPart = tl.parts.find((p) => p.kind === 'text')
    if (textPart && textPart.kind === 'text') {
      expect(textPart.text).toBe('用户选择了皮克斯风格，我现在开始生成。')
      expect(textPart.status).toBe('done')
    }
  })

  it('⭐ 已有 text 落库段时 bodyText 不再 unshift（防「段文本 + 整条正文」双份渲染）', () => {
    const events: Array<{ type: string; data: unknown }> = [
      { type: 'text', data: { text: '分段落库的正文' } },
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'get_canvas_summary' } },
    ]
    const tl = replayTimelineEvents(events, '整条 message.content 的正文')
    const texts = byKind(tl, 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0].text).toBe('分段落库的正文')
    // text 在 tool 之前按事件序归位，而不是被 bodyText unshift 到最前之外再加一份
    expect(kinds(tl)[0]).toBe('text')
    expect(kinds(tl)[1]).toBe('tool')
  })

  it('⭐ 2026-10-17 双粒度：waiting_user 产单条 notice（稳定 id upsert，重复 waiting 不追加）', () => {
    const tl = feed([
      { type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_generation' } },
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } },
      // 重复 waiting（重放/多段等待）：只改文案，绝不刷屏（10-14「重复」反馈不回归）
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } },
    ])
    const notices = byKind(tl, 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].id).toBe('notice:waiting')
    expect(notices[0].text).toBe('等待你在画布上确认生成，确认后继续输出')
    expect(notices[0].tone).toBe('warn')
  })

  it('⭐ resolved 只改同一条 notice 文案（不新增不删除；⏸→· 表等待已解除）', () => {
    const tl = feed([
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } },
      { type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_generation' } },
    ])
    const notices = byKind(tl, 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toBe('已继续执行')
    expect(notices[0].tone).toBe('info')
  })

  it('ask_user 形态：reason 进 notice 文案（toolName 缺失也可见）', () => {
    const tl = feed([
      { type: 'waiting_user', data: { status: 'waiting', reason: '请选择风格' } },
    ])
    const notices = byKind(tl, 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toBe('等待你确认：请选择风格')
  })

  it('resolved 先于 waiting（乱序/重放）：无 notice 可改时不新建', () => {
    const tl = feed([
      { type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_generation' } },
    ])
    expect(byKind(tl, 'notice')).toHaveLength(0)
    expect(tl.parts).toHaveLength(0)
  })

  it('⭐ 重放（历史 executionEvents）兼容：waiting→resolved 序列收口为一条 info notice', () => {
    const tl = replayTimelineEvents([
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } },
      { type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_generation' } },
    ] as never[])
    // 只锁等待 notice 这一条（replay 末尾还可能追加回合摘要 notice，互不干扰）
    const waiting = byKind(tl, 'notice').filter((n) => n.id === 'notice:waiting')
    expect(waiting).toHaveLength(1)
    expect(waiting[0].text).toBe('已继续执行')
    expect(waiting[0].tone).toBe('info')
  })

  it('⭐ 2026-10-14 累积快照差分：存量 done.summary 带前文时按前缀差分出段增量，不再整段重复', () => {
    // 复刻生产实测形态：4 段 summary len 220/758/822/963，head 完全相同（累积快照）
    const seg1 = '用户想要图标库。'
    const seg2 = `${seg1}需要先查画布再建节点。`
    const seg3 = `${seg2}节点ID不对，重新操作。`
    const tl = feed([
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: seg1 } },
      { type: 'tool_call', data: { toolCallId: 't1', name: 'get_canvas_summary', args: {} } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: seg2 } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: seg3 } },
    ])
    const blocks = byKind(tl, 'thinking')
    expect(blocks).toHaveLength(3)
    expect(blocks[0].text).toBe(seg1)
    expect(blocks[1].text).toBe('需要先查画布再建节点。') // 差分增量，而非整段 seg2
    expect(blocks[2].text).toBe('节点ID不对，重新操作。')
  })

  it('⭐ Q1 流式思考（2026-10-14 对齐 WorkBuddy）：running 快照实时更新文本，done 权威替换不追加重', () => {
    const tl = feed([
      { type: 'thinking', data: { status: 'running' } },
      // 服务端节流透传的累积快照（transient 只影响落库，模型层照常消费）
      { type: 'thinking', data: { status: 'running', summary: '用户已选择' } },
      { type: 'thinking', data: { status: 'running', summary: '用户已选择风格，开始' } },
      { type: 'thinking', data: { status: 'done', summary: '用户已选择风格，开始生成' } },
    ])
    const blocks = byKind(tl, 'thinking')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('用户已选择风格，开始生成')
    expect(blocks[0].status).toBe('done')
  })

  it('⭐ 增量形态（服务端修复后）不受差分逻辑影响：done.summary 即段原文', () => {
    const tl = feed([
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: '第一段' } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: '第二段' } },
    ])
    const blocks = byKind(tl, 'thinking')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toBe('第一段')
    expect(blocks[1].text).toBe('第二段')
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
    // lastRawThinking：2026-10-14 累积快照差分游标（replay 内存态，不落库、不进事件契约）
    expect(Object.keys(tl).sort()).toEqual(['lastRawThinking', 'parts', 'turnStartedAt'])
    expect(kinds(tl)).toEqual(['thinking', 'artifact'])
  })
})

describe('turnTimeline — 晚到生成状态回填（2026-10-17 产物体验补全）', () => {
  it('node_status done 携带 url ⇒ 直存 artifact part.url（缩略图不依赖画布节点查找）', () => {
    const tl = feed([
      addNode('n1', 'image', '海报'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating' } },
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://cdn/a.png' } },
    ])
    const art = byKind(tl, 'artifact')[0]
    expect(art.status).toBe('done')
    expect(art.url).toBe('https://cdn/a.png')
  })

  it('failed 态不把 url 存成媒体地址（url 沿用既有「错误文案」语义）', () => {
    const tl = feed([
      addNode('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'failed', url: '渠道超时' } },
    ])
    const art = byKind(tl, 'artifact')[0]
    expect(art.status).toBe('failed')
    expect(art.url).toBeUndefined()
    expect(art.errorText).toBe('渠道超时')
  })

  it('node_status 无前置 add_node 的占位 artifact 也带 url', () => {
    const tl = feed([
      { type: 'node_status', data: { nodeId: 'n9', status: 'done', url: 'https://cdn/b.png' } },
    ])
    const art = byKind(tl, 'artifact')[0]
    expect(art.status).toBe('done')
    expect(art.url).toBe('https://cdn/b.png')
  })

  it('⭐ 回合收束后回填翻 done：refreshTimelineSummary 原地刷新摘要 notice（产物计数 0→1）', () => {
    const tl = feed([addNode('n1')])
    finalizeTurnTimeline(tl)
    const summaryNotice = tl.parts.find(
      (p): p is Extract<TimelinePart, { kind: 'notice' }> => p.id === 'notice:turn-summary',
    )
    expect(summaryNotice, 'finalize 追加的摘要 notice 用稳定 id').toBeTruthy()
    expect(summaryNotice!.text, 'pending 不计入产物').not.toContain('已生成')

    // 轮询回填终态（产物晚于回合收束完成）⇒ 摘要随之补计
    applyTimelineEvent(tl, {
      type: 'node_status',
      data: { nodeId: 'n1', status: 'done', url: 'https://cdn/a.png' },
    })
    refreshTimelineSummary(tl)
    expect(summaryNotice!.text).toContain('已生成 1 个产物')
  })

  it('⭐ 产物口径（2026-10-17 用户裁定）：连线等画布过程动作不是产物，不进摘要统计', () => {
    const tl = feed([
      addNode('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://x/a.png' } },
      // 画布过程动作：连线（旧口径会被 canvas part 计数成「节点」）
      { type: 'canvas_action', data: { type: 'add_edge', payload: { id: 'e1', source: 'n1', target: 'n2' } } as never },
      { type: 'canvas_action', data: { type: 'set_viewport', payload: { viewport: { x: 0, y: 0, zoom: 1 } } } as never },
    ])
    finalizeTurnTimeline(tl)
    // 连线/视口仍作为过程行存在（时间线 = 过程视图），但摘要只数产物
    expect(byKind(tl, 'canvas')).toHaveLength(2)
    const summaryNotice = tl.parts.find(
      (p): p is Extract<TimelinePart, { kind: 'notice' }> => p.id === 'notice:turn-summary',
    )
    expect(summaryNotice!.text).toContain('已生成 1 个产物')
    expect(summaryNotice!.text).not.toContain('2 个产物')
    expect(summaryNotice!.text).not.toContain('节点')
  })

  it('refreshTimelineSummary 不动无关 notice：未收束 / 摘要 notice 不存在时静默跳过', () => {
    // 未收束：turnEndedAt 为空 ⇒ 不刷
    const live = feed([addNode('n1')])
    applyTimelineEvent(live, {
      type: 'node_status',
      data: { nodeId: 'n1', status: 'done', url: 'https://cdn/a.png' },
    })
    expect(() => refreshTimelineSummary(live)).not.toThrow()
    expect(live.parts.some((p) => p.kind === 'notice' && p.id === 'notice:turn-summary')).toBe(false)

    // 已收束但摘要 notice 缺席（summarize 为 null 的空回合）⇒ 不崩、不新增
    const empty = createTurnTimeline()
    finalizeTurnTimeline(empty)
    const count = empty.parts.length
    refreshTimelineSummary(empty)
    expect(empty.parts).toHaveLength(count)
  })

  it('finalize 的摘要 notice 稳定 id 与 waiting/孤儿/partial notice 不冲突', () => {
    const tl = feed([
      addNode('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://x/a.png' } },
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation' } },
    ])
    finalizeTurnTimeline(tl)
    const ids = byKind(tl, 'notice').map((n) => n.id)
    expect(ids).toContain('notice:waiting')
    expect(ids).toContain('notice:turn-summary')
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('generation_progress — run_* / propose 阻塞期活体进度（2026-10-18 上游对齐①）', () => {
  it('running 产物收进度拍 ⇒ progressElapsedMs 更新；终态后收拍不复活（status 守卫）', () => {
    const tl = feed([
      addNode('n1', 'image', '圣诞帽'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating' } },
      { type: 'generation_progress', data: { nodeId: 'n1', elapsedMs: 30_000 } },
    ])
    const art = byKind(tl, 'artifact')[0]
    expect(art.status).toBe('running')
    expect(art.progressElapsedMs).toBe(30_000)

    // 终态后到达的迟到进度拍：不回改 done 态、不写 progressElapsedMs
    applyTimelineEvent(tl, { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://cdn/a.png' } })
    applyTimelineEvent(tl, { type: 'generation_progress', data: { nodeId: 'n1', elapsedMs: 60_000 } })
    expect(art.status).toBe('done')
    expect(art.progressElapsedMs).toBe(30_000)
  })

  it('单调不减：晚到旧拍不回退新拍（SSE 重连补发/乱序防护）', () => {
    const tl = feed([
      addNode('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating' } },
      { type: 'generation_progress', data: { nodeId: 'n1', elapsedMs: 90_000 } },
      { type: 'generation_progress', data: { nodeId: 'n1', elapsedMs: 30_000 } },
    ])
    expect(byKind(tl, 'artifact')[0].progressElapsedMs).toBe(90_000)
  })

  it('无前置 add_node / 非 running 态 / 非法 elapsedMs ⇒ 静默忽略不建 part', () => {
    // 无 artifact：进度拍不新建 part（part 由 canvas_action/node_status 负责）
    const orphan = feed([{ type: 'generation_progress', data: { nodeId: 'ghost', elapsedMs: 1000 } }])
    expect(orphan.parts).toHaveLength(0)

    // pending 态（仅 add_node、未开始生成）：不写
    const pending = feed([addNode('n2'), { type: 'generation_progress', data: { nodeId: 'n2', elapsedMs: 1000 } }])
    expect(byKind(pending, 'artifact')[0].progressElapsedMs).toBeUndefined()

    // 非法数值：NaN/负数/Infinity 不写
    const tl = feed([addNode('n3'), { type: 'node_status', data: { nodeId: 'n3', status: 'generating' } }])
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      applyTimelineEvent(tl, { type: 'generation_progress', data: { nodeId: 'n3', elapsedMs: bad } })
    }
    expect(byKind(tl, 'artifact')[0].progressElapsedMs).toBeUndefined()
  })

  it('进度拍不改变 parts 结构（活体显示专用，不新增不删除）', () => {
    const tl = feed([addNode('n1'), { type: 'node_status', data: { nodeId: 'n1', status: 'generating' } }])
    const before = kinds(tl)
    applyTimelineEvent(tl, { type: 'generation_progress', data: { nodeId: 'n1', elapsedMs: 45_000 } })
    expect(kinds(tl)).toEqual(before)
  })
})
