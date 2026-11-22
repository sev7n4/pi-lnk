/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  finalizeTurnTimeline,
  reconcileTimelineInterruption,
  replayTimelineEvents,
  type TurnTimeline,
} from './turnTimeline'

/**
 * 时间线序列化卫生（2026-11-22 生产走查实证，会话 cmwrnm9ch0b2fo901p15oscif 85-part 回合）：
 *
 * F1 question 卡沉底：服务端账本只有 `waiting_user{toolName:'ask_user'}`（无独立 ask_user
 *    事件、也无旧 canvas_command 形态）⇒ replay 不建卡、`reconcileTimelineInterruption`
 *    安全网把卡 push 到整轮末尾（85-part 回合里 question 落 idx84，正文与 14 张产物卡之后）。
 *    ⇒ waiting_user 分支按 callId 原位 upsert question part，live/replay 同一条代码路径。
 * F2 todo 通知泛滥：task_list/task_update 无 nodeId 项每个事件 push 一条 notice，
 *    同一批任务文案在长回合重复渲染 3 组 10 行，且与轮首清单完全同文 ⇒ 抑制（进度由清单承载）。
 * F3 canvas_action 连排：connect_nodes 一次 13 条 add_edge ⇒ 13 行同文「连接画布节点」
 *    ⇒ 同 type+同 label 折叠为一行并带 ×N 计数。
 * F4 replay「用时 1ms」：finalizeTurnTimeline 用墙钟覆盖 turnEndedAt，replay 时
 *    start/end 都是重放瞬间 ⇒ 用事件自带 ts 推导，finalize 不覆盖已有值。
 */

const QUESTION = {
  id: 'q1',
  question: '短剧走哪种类型？',
  options: [
    { label: '逆袭爽剧', value: 'a' },
    { label: '荒诞喜剧', value: 'b' },
  ],
}

/** 生产账本同构片段（seq 语义省略，顺序即账本序）：ask_user 在第 2 个工具位 */
function productionShapedEvents() {
  return [
    { type: 'thinking', data: { status: 'running', summary: '用户要求创作短剧' }, ts: 1000 },
    { type: 'thinking', data: { status: 'done', summary: '用户要求创作短剧，先问清类型' }, ts: 1600 },
    { type: 'tool_call', data: { toolCallId: 'call_ask1', toolName: 'ask_user' }, ts: 1700 },
    {
      type: 'waiting_user',
      data: { status: 'waiting', toolName: 'ask_user', callId: 'call_ask1', timeoutMs: 120000 },
      ts: 1800,
    },
    {
      type: 'waiting_user',
      data: { status: 'resolved', toolName: 'ask_user', callId: 'call_ask1', reason: 'answered' },
      ts: 15000,
    },
    { type: 'tool_result', data: { toolCallId: 'call_ask1', toolName: 'ask_user', result: 'ok' }, ts: 15100 },
    { type: 'thinking', data: { status: 'done', summary: '用户选了逆袭爽剧，开始创作' }, ts: 15300 },
    { type: 'text', data: { text: '《粪金王的逆袭》已完成' }, ts: 95000 },
    { type: 'turn_settled', data: { credits: 1, model: 'platform::agnes-2.5-flash' }, ts: 96000 },
  ]
}

describe('F1 question 卡按账本位置重建（waiting_user 桥接，live/replay 同路径）', () => {
  it('replay：waiting_user{ask_user,waiting} 在其账本位置建 pending 卡，resolved 原位翻 answered', () => {
    const tl = replayTimelineEvents(productionShapedEvents() as never)
    const qIdx = tl.parts.findIndex((p) => p.kind === 'question')
    // 账本序：thinking → ask_user 工具卡 → notice:waiting → question 卡（live 同序）
    expect(qIdx, 'question 卡必须紧跟在 ask_user 工具卡与等待 notice 之后（账本位置）').toBe(3)
    const q = tl.parts[qIdx] as Extract<TurnTimeline['parts'][number], { kind: 'question' }>
    expect(q.id).toBe('question:call_ask1')
    expect(q.callId).toBe('call_ask1')
    expect(q.status, 'resolved 事件必须原位翻终态').toBe('answered')
  })

  it('replay 后 reconcile(answered) 不再追加任何 part（安全网退位，卡数不增）', () => {
    const tl = replayTimelineEvents(productionShapedEvents() as never)
    const before = tl.parts.length
    const changed = reconcileTimelineInterruption(tl, {
      kind: 'ask_user',
      callId: 'call_ask1',
      status: 'answered',
      questions: [QUESTION],
    } as never)
    expect(tl.parts.length, 'reconcile 不得在末尾补建卡').toBe(before)
    expect(changed).toBe(false)
  })

  it('live：applyTimelineEvent 直喂 waiting_user（不经 replay 归一化）同样原位建卡', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, {
      type: 'tool_call',
      data: { toolCallId: 'call_ask1', toolName: 'ask_user' },
    } as never)
    applyTimelineEvent(tl, {
      type: 'waiting_user',
      data: { status: 'waiting', toolName: 'ask_user', callId: 'call_ask1' },
    } as never)
    const qIdx = tl.parts.findIndex((p) => p.kind === 'question')
    expect(qIdx).toBe(2) // tool → notice:waiting → question（与 live 生产序一致）
    const q = tl.parts[qIdx] as Extract<TurnTimeline['parts'][number], { kind: 'question' }>
    expect(q.status).toBe('pending_answer')
  })

  it('事件自带 questions 时写入题面（不依赖 reconcile 补全）', () => {
    const tl = replayTimelineEvents([
      {
        type: 'waiting_user',
        data: { status: 'waiting', toolName: 'ask_user', callId: 'c2', questions: [QUESTION] },
      },
    ] as never)
    const q = tl.parts.find((p) => p.kind === 'question') as { questions?: unknown }
    expect(q?.questions).toEqual([QUESTION])
  })

  it('阴性：非 ask_user 的 waiting_user（如 propose）不建 question 卡', () => {
    const tl = replayTimelineEvents([
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', callId: 'c3' } },
    ] as never)
    expect(tl.parts.some((p) => p.kind === 'question')).toBe(false)
  })
})

describe('F2 task_list/task_update 无 nodeId 项不再洪水式发 notice', () => {
  /** replay 尾部 finalize 会补一条 notice:turn-summary（既有收口行为），不计入任务 notice 口径 */
  const taskNotices = (tl: TurnTimeline) =>
    tl.parts.filter((p) => p.kind === 'notice' && p.id !== 'notice:turn-summary')

  it('task_list 3 项（无 nodeId）+ task_update 2 次 ⇒ 0 条任务 notice part', () => {
    const tl = replayTimelineEvents([
      {
        type: 'task_list',
        data: {
          items: [
            { id: 't1', title: '创建原创定位节点', status: 'pending' },
            { id: 't2', title: '创建全剧大纲节点', status: 'pending' },
            { id: 't3', title: '逐集撰写剧本', status: 'pending' },
          ],
        },
      },
      { type: 'task_update', data: { id: 't1', title: '创建原创定位节点', status: 'running' } },
      { type: 'task_update', data: { id: 't1', title: '创建原创定位节点', status: 'done' } },
    ] as never)
    expect(taskNotices(tl)).toHaveLength(0)
  })

  it('带 nodeId 的 task 项仍走 artifact 对账通道（批量生成任务不回归）', () => {
    const tl = replayTimelineEvents([
      { type: 'task_update', data: { id: 't9', title: '生成海报', status: 'running', nodeId: 'node-9' } },
    ] as never)
    const art = tl.parts.find((p) => p.kind === 'artifact') as { nodeId?: string } | undefined
    expect(art?.nodeId).toBe('node-9')
    expect(taskNotices(tl)).toHaveLength(0)
  })
})

describe('F3 canvas_action 同型同文折叠为一行 ×N', () => {
  const edges = Array.from({ length: 13 }, (_, i) => ({
    type: 'canvas_action',
    data: { type: 'add_edge', payload: { id: `edge-${i}` } },
  }))

  it('13 条 add_edge ⇒ 恰 1 条 canvas part，label 带 ×13', () => {
    const tl = replayTimelineEvents(edges as never)
    const canvas = tl.parts.filter((p) => p.kind === 'canvas') as Array<{ label: string }>
    expect(canvas).toHaveLength(1)
    expect(canvas[0]!.label).toContain('连接画布节点')
    expect(canvas[0]!.label).toContain('13')
  })

  it('不同 label 的动作不合并（保留逐节点定位语义）', () => {
    const tl = replayTimelineEvents([
      { type: 'canvas_action', data: { type: 'add_edge', payload: { id: 'e1' } } },
      { type: 'canvas_action', data: { type: 'remove_node', payload: { id: 'n1', data: { title: '海报' } } } },
      { type: 'canvas_action', data: { type: 'remove_node', payload: { id: 'n2', data: { title: '大纲' } } } },
    ] as never)
    const canvas = tl.parts.filter((p) => p.kind === 'canvas') as Array<{ label: string }>
    expect(canvas).toHaveLength(3)
  })

  it('live 与 replay 同构：直喂 applyTimelineEvent 也折叠（幂等）', () => {
    const tl = createTurnTimeline()
    for (const e of edges) applyTimelineEvent(tl, e as never)
    expect(tl.parts.filter((p) => p.kind === 'canvas')).toHaveLength(1)
  })
})

describe('F4 replay 用事件 ts 推导回合时长（finalize 不覆盖）', () => {
  it('replay 后 turnStartedAt/turnEndedAt = 事件 ts 区间；finalize 不覆盖为墙钟', () => {
    const tl = replayTimelineEvents(productionShapedEvents() as never)
    expect(tl.turnStartedAt).toBe(1000)
    expect(tl.turnEndedAt).toBe(96000)
    finalizeTurnTimeline(tl)
    expect(tl.turnStartedAt).toBe(1000)
    expect(tl.turnEndedAt).toBe(96000)
  })

  it('无 ts 的旧账本：行为不变（finalize 用墙钟）', () => {
    const tl = replayTimelineEvents([{ type: 'text', data: { text: '旧数据无 ts' } }] as never)
    finalizeTurnTimeline(tl)
    const before = tl.turnEndedAt
    expect(typeof before).toBe('number')
    finalizeTurnTimeline(tl)
    expect(tl.turnEndedAt).toBe(before)
  })
})
