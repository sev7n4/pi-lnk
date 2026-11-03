/**
 * P1 Task 5（多端一致性 · 统一传输）：主流改走 GET /runs/events 的**纯逻辑面**。
 *
 * 传输交换后主流的事件消费从 POST 响应体换成权威通道（带 id: 帧 + 游标续传）。
 * 本模块把「ack 解析 + GET 流消费循环」抽成可注入依赖的纯函数 —— 循环/游标/
 * 终止判定可以在 Node 里直接断言（plan Task 5 Step 1：帧含 id: 被解析、事件进
 * reducer、终止 = turn 收束、off 分支不受影响）。
 *
 * ⛔ 复用既有 `extractSseFrames`/`parseSseFrameSeq`（规格全局约束：禁止第二套
 *   split('\n') 解析器）。
 */
import { describe, expect, it } from 'vitest'
import {
  consumeMainTurnStream,
  isMainTurnTerminal,
  parseConversationAck,
  type MainTurnAck,
} from './main-turn-channel'

function readerFrom(chunks: string[], onRead?: () => void, onCancel?: () => void) {
  let i = 0
  return {
    read: async () => {
      onRead?.()
      if (i < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[i++]) }
      return { done: true, value: undefined }
    },
    cancel: async () => {
      onCancel?.()
    },
  }
}

describe('parseConversationAck（Task 4 ack 契约的消费侧）', () => {
  it('合法 accepted ack：字段齐全', () => {
    const ack = parseConversationAck({
      code: 0,
      data: { accepted: true, threadId: 't1', sinceSeq: 9 },
    })
    expect(ack).not.toBeNull()
    expect(ack!.accepted).toBe(true)
    expect(ack!.threadId).toBe('t1')
    expect(ack!.sinceSeq).toBe(9)
    expect(ack!.forkedThreadId).toBeUndefined()
  })

  it('fork ack：forkedThreadId 透传', () => {
    const ack = parseConversationAck({
      code: 0,
      data: { accepted: true, threadId: 'fork-1', sinceSeq: 0, forkedThreadId: 'fork-1' },
    })
    expect(ack!.forkedThreadId).toBe('fork-1')
  })

  it('闸门拒绝（accepted=false + reason）如实透传', () => {
    const ack = parseConversationAck({
      code: 0,
      data: { accepted: false, reason: 'not_idle' },
    })
    expect(ack!.accepted).toBe(false)
    expect(ack!.reason).toBe('not_idle')
  })

  it('畸形载荷（null / 缺 data / 缺 threadId）⇒ null（调用方走异常路径）', () => {
    expect(parseConversationAck(null)).toBeNull()
    expect(parseConversationAck({ code: 0 })).toBeNull()
    expect(parseConversationAck({ code: 0, data: { accepted: true } })).toBeNull()
  })
})

describe('isMainTurnTerminal（Task 6：on 路径终止语义 = 回合收束帧，与 [DONE] 无关）', () => {
  it('done / turn_ack / error / turn_not_submitted ⇒ true', () => {
    for (const t of ['done', 'turn_ack', 'error', 'turn_not_submitted']) {
      expect(isMainTurnTerminal(t)).toBe(true)
    }
  })
  it('text_delta / canvas_action / heartbeat / thread_forked / turn_suspended ⇒ false', () => {
    for (const t of [
      'text_delta',
      'canvas_action',
      'heartbeat',
      'thread_forked',
      'turn_suspended',
    ]) {
      expect(isMainTurnTerminal(t)).toBe(false)
    }
  })
})

describe('consumeMainTurnStream（GET /runs/events 消费循环）', () => {
  it('id: 帧被解析为游标（onCursor），data 帧进 onEvent（顺序保持）', async () => {
    const cursors: number[] = []
    const events: Array<{ type: string }> = []
    const res = await consumeMainTurnStream({
      reader: readerFrom([
        'id: 3\ndata: {"type":"text_delta","data":{"text":"a"}}\n\n',
        'id: 4\ndata: {"type":"canvas_action","data":{"op":"add_node"}}\n\n',
        'data: {"type":"heartbeat"}\n\n',
      ]),
      onEvent: (e) => events.push(e as { type: string }),
      onCursor: (seq) => cursors.push(seq),
    })
    expect(cursors).toEqual([3, 4])
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'canvas_action', 'heartbeat'])
    expect(res.lastSeq).toBe(4)
    // 流 clean end 但没等到回合收束帧 ⇒ 非自然终局（调用方走断流对账路径）
    expect(res.endedNaturally).toBe(false)
  })

  it('回合收束帧（done）⇒ endedNaturally=true 且立刻停（后续帧不再消费，reader 被 cancel）', async () => {
    let cancelled = false
    let readCount = 0
    const res = await consumeMainTurnStream({
      reader: readerFrom(
        [
          'id: 1\ndata: {"type":"agent_start","data":{}}\n\n',
          'id: 2\ndata: {"type":"done","data":{}}\n\n',
          'id: 3\ndata: {"type":"text_delta","data":{"text":"不该被消费"}}\n\n',
        ],
        () => {
          readCount += 1
        },
        () => {
          cancelled = true
        },
      ),
      onEvent: () => {},
      onCursor: () => {},
    })
    expect(res.endedNaturally).toBe(true)
    expect(res.lastSeq).toBe(2)
    expect(cancelled).toBe(true)
    void readCount
  })

  it('data: [DONE] 不是 on 路径的终止信号（GET 通道不产生它；出现也不该被当成帧解析崩）', async () => {
    const events: Array<{ type: string }> = []
    const res = await consumeMainTurnStream({
      reader: readerFrom(['data: [DONE]\n\n', 'id: 5\ndata: {"type":"done","data":{}}\n\n']),
      onEvent: (e) => events.push(e as { type: string }),
      onCursor: () => {},
    })
    // [DONE] 行 JSON.parse 失败 ⇒ 跳过不抛；真正的终局来自 done 事件
    expect(events.map((e) => e.type)).toEqual(['done'])
    expect(res.endedNaturally).toBe(true)
  })

  it('JSON 解析失败的帧跳过不抛，游标仍然先落（解析失败不丢断点）', async () => {
    const cursors: number[] = []
    const res = await consumeMainTurnStream({
      reader: readerFrom([
        'id: 7\ndata: {broken json\n\n',
        'id: 8\ndata: {"type":"done","data":{}}\n\n',
      ]),
      onEvent: () => {},
      onCursor: (seq) => cursors.push(seq),
    })
    expect(cursors).toEqual([7, 8])
    expect(res.endedNaturally).toBe(true)
    expect(res.lastSeq).toBe(8)
  })

  it('signal 已中止 ⇒ 立即返回（endedNaturally=false，不消费任何帧）', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await consumeMainTurnStream({
      reader: readerFrom(['id: 1\ndata: {"type":"text_delta","data":{"text":"x"}}\n\n']),
      onEvent: () => {},
      onCursor: () => {},
      signal: ac.signal,
    })
    expect(res.endedNaturally).toBe(false)
    expect(res.lastSeq).toBeNull()
  })
})

describe('ack 契约与 follow-up-tail 终止集合的一致性（plan Task 5/6 接缝）', () => {
  it('MainTurnAck 形状字段与服务端 ConversationAck 对齐（threadId/sinceSeq 必备）', () => {
    const ok: MainTurnAck = { accepted: true, threadId: 'x', sinceSeq: 0 }
    expect(ok.threadId).toBe('x')
  })
})
