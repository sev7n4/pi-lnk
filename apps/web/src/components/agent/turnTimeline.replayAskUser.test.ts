/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { applyTimelineEvent, createTurnTimeline, replayTimelineEvents } from './turnTimeline'

// P0-A（SSE 会话恢复）：历史回放必须把服务端落库形态 `canvas_command{ask_user}`
// 收敛为时间线原生 `ask_user`，否则确认卡片在历史重放中撞 `default: return` 被吞。
// 直接调用真实 replayTimelineEvents / applyTimelineEvent 跑，不抄逻辑。

type QT = { kind: 'question'; status: string; callId?: string }

function questionPart(tl: ReturnType<typeof createTurnTimeline>): QT | undefined {
  return tl.parts.find((p) => p.kind === 'question') as QT | undefined
}

describe('replayTimelineEvents：canvas_command{ask_user} 历史回放重建确认卡片', () => {
  // 服务端真实落库形态（生产实证：近期会话 ask_user 计数全为 0，全是 canvas_command）
  const persistedEvents = [
    { type: 'text', data: { text: '我来帮你做这个知识教学视频' } },
    {
      type: 'canvas_command',
      data: {
        type: 'ask_user',
        callId: 'ask-1',
        title: '风格选择',
        questions: [{ id: 'q1', question: '选哪种风格？', options: [{ label: 'A', value: 'a' }] }],
      },
    },
  ]

  it('P0-A 正向：落库 canvas_command{ask_user} 经归一化重建出 pending_answer 的 question part', () => {
    const tl = replayTimelineEvents(persistedEvents as never, '我来帮你做这个知识教学视频')
    const q = questionPart(tl)
    expect(q, '历史回放必须重建确认卡片').not.toBeUndefined()
    expect(q?.status).toBe('pending_answer')
    expect(q?.callId).toBe('ask-1')
  })

  it('同构证明：原生 ask_user 事件也重建出等价 part（两路径同形，归一化只是桥接）', () => {
    const tl = replayTimelineEvents(
      [
        {
          type: 'ask_user',
          data: {
            callId: 'ask-1',
            title: '风格选择',
            questions: [{ id: 'q1', question: '选哪种风格？', options: [{ label: 'A', value: 'a' }] }],
          },
        },
      ] as never,
      '我来帮你做这个知识教学视频',
    )
    const q = questionPart(tl)
    expect(q?.status).toBe('pending_answer')
    expect(q?.callId).toBe('ask-1')
  })

  it('机制证明：不经过归一化、直接 applyTimelineEvent 喂原始 canvas_command ⇒ 不建 part（证归一化是必需桥接，非偶然）', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(
      tl,
      { type: 'canvas_command', data: { type: 'ask_user', callId: 'ask-1', questions: [] } } as never,
    )
    expect(questionPart(tl), '原始 canvas_command 必须被 default 吞掉（无归一化则卡片丢失）').toBeUndefined()
  })

  it('阴性对照：不含 ask_user 的样本 ⇒ 无 question part（防误建）', () => {
    const tl = replayTimelineEvents([{ type: 'text', data: { text: '普通回复' } }] as never, '普通回复')
    expect(questionPart(tl)).toBeUndefined()
  })
})
