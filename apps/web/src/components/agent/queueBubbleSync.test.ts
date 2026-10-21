// 「pi 侧来了一条 user 消息」时前端对话流的落点判定（2026-10-21 回归锁）。
//
// 背景：插话（steer / followUp）走队列 API，被模型在**下一个 turn 边界**消费；
// 消费时 vendor 会发 `message_end`（携带那条 user 消息 + 队列条目的 entryId）。
// 前端此前只拿它挂 entryId ⇒ ① 对话流里没有用户气泡；② 还把上一条正常消息的
// fork 切点冲掉（「重新生成」会从插话那条分叉）。
//
// 本组用例锁**判定规则**（纯函数，行为级）：
//   - 命中前端登记的队列 entryId ⇒ 插话 ⇒ 补建气泡（本地本来没有）
//   - 未命中 ⇒ 本轮初始 prompt ⇒ 挂到本地已有气泡上
//   - **绝不覆盖**已有的 entryId（上一条消息的切点必须保住）
//   - 幂等：同一 entryId 只处理一次
import { describe, it, expect } from 'vitest'
import {
  applyPiUserMessageEvent,
  decideQueueBubbleSync,
  extractPiUserText,
  type QueueBubbleMessageLike,
} from './queueBubbleSync'

/** 造一条本地消息。 */
function msg(role: 'user' | 'assistant', entryId?: string): QueueBubbleMessageLike {
  return { role, ...(entryId ? { entryId } : {}) }
}

/** pi 侧 `message_end` 的载荷形状（vendor：{ message, entryId }）。 */
function piUserEnd(entryId: string, text: string) {
  return {
    entryId,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

describe('decideQueueBubbleSync —— 落点判定', () => {
  it('entryId 命中前端登记的队列集合 ⇒ 补建气泡（插话本地本来没有）', () => {
    const decision = decideQueueBubbleSync({
      entryId: 'e-queue-1',
      messages: [msg('user', 'e-normal'), msg('assistant')],
      queuedEntryIds: new Set(['e-queue-1']),
      queuedText: '再加个背景',
      piText: '再加个背景',
    })
    expect(decision).toEqual({ kind: 'insert', text: '再加个背景' })
  })

  it('插话但槽位已被「放弃」（本地没有原文）⇒ 仍补建，用 pi 侧文本兜底', () => {
    const decision = decideQueueBubbleSync({
      entryId: 'e-queue-2',
      messages: [msg('assistant')],
      queuedEntryIds: new Set(['e-queue-2']),
      // 槽位不在了 ⇒ queuedText 缺省
      piText: '被放弃的那句',
    })
    expect(decision).toEqual({ kind: 'insert', text: '被放弃的那句' })
  })

  it('未命中队列集合 ⇒ 初始 prompt ⇒ 挂到本地最后一条 user 气泡上', () => {
    const decision = decideQueueBubbleSync({
      entryId: 'e-prompt',
      messages: [msg('user'), msg('assistant')],
      queuedEntryIds: new Set(),
      piText: '你好',
    })
    expect(decision).toEqual({ kind: 'attach', index: 0 })
  })

  it('⭐ 绝不覆盖已有 entryId（上一条消息的 fork 切点必须保住）', () => {
    // 最后一条 user 消息**已经有**切点 ⇒ 不能拿它当落点
    const decision = decideQueueBubbleSync({
      entryId: 'e-prompt-2',
      messages: [msg('user', 'e-old'), msg('assistant')],
      queuedEntryIds: new Set(),
      piText: '第二条',
    })
    // 没有「还没有 entryId 的 user 消息」可挂 ⇒ 不动作（而不是覆盖 e-old）
    expect(decision).toEqual({ kind: 'skip' })
  })

  it('有多条 user 消息时，落到**最后一条没有 entryId 的**那条', () => {
    const decision = decideQueueBubbleSync({
      entryId: 'e-prompt-3',
      messages: [msg('user', 'e-1'), msg('user'), msg('assistant')],
      queuedEntryIds: new Set(),
      piText: '第三条',
    })
    expect(decision).toEqual({ kind: 'attach', index: 1 })
  })

  it('幂等：同一 entryId 已在某条消息上 ⇒ 不动作（断线重连会重放事件）', () => {
    const decision = decideQueueBubbleSync({
      entryId: 'e-dup',
      messages: [msg('user', 'e-dup'), msg('assistant')],
      queuedEntryIds: new Set(['e-dup']),
      queuedText: '重复',
    })
    expect(decision).toEqual({ kind: 'skip' })
  })

  it('没有 entryId ⇒ 不动作', () => {
    expect(
      decideQueueBubbleSync({ entryId: '', messages: [msg('user')], queuedEntryIds: new Set() }),
    ).toEqual({ kind: 'skip' })
  })
})

describe('applyPiUserMessageEvent —— 落点应用', () => {
  it('插话：补建气泡并带上 entryId 与冻结素材', () => {
    const messages: QueueBubbleMessageLike[] = [msg('user', 'e-normal'), msg('assistant')]
    const inserted: Array<{ text: string; entryId: string }> = []
    applyPiUserMessageEvent(piUserEnd('e-q', '插话内容'), {
      messages,
      queuedEntryIds: new Set(['e-q']),
      slots: [{ entryId: 'e-q', text: '插话内容' }],
      insertUserMessage: (text, extras) => {
        inserted.push({ text, entryId: extras.entryId })
        messages.push({ role: 'user', entryId: extras.entryId })
      },
    })
    expect(inserted).toEqual([{ text: '插话内容', entryId: 'e-q' }])
    // 上一条正常消息的切点没被动
    expect(messages[0]?.entryId).toBe('e-normal')
  })

  it('初始 prompt：把 entryId 挂到本地 user 消息上', () => {
    const messages: QueueBubbleMessageLike[] = [msg('user'), msg('assistant')]
    let inserted = 0
    applyPiUserMessageEvent(piUserEnd('e-p', '你好'), {
      messages,
      queuedEntryIds: new Set(),
      slots: [],
      insertUserMessage: () => {
        inserted += 1
      },
    })
    expect(inserted).toBe(0)
    expect(messages[0]?.entryId).toBe('e-p')
  })

  it('assistant 消息的事件一律不处理', () => {
    const messages: QueueBubbleMessageLike[] = [msg('user'), msg('assistant')]
    let inserted = 0
    applyPiUserMessageEvent(
      { entryId: 'e-a', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } },
      {
        messages,
        queuedEntryIds: new Set(['e-a']),
        slots: [],
        insertUserMessage: () => {
          inserted += 1
        },
      },
    )
    expect(inserted).toBe(0)
    expect(messages[0]?.entryId).toBeUndefined()
  })
})

describe('extractPiUserText —— pi 侧 user 正文抽取', () => {
  it('取 content 数组里的 text 段', () => {
    expect(
      extractPiUserText([
        { type: 'text', text: '第一段' },
        { type: 'image', data: 'xxx' },
        { type: 'text', text: '第二段' },
      ]),
    ).toBe('第一段\n第二段')
  })

  it('字符串形态直接取', () => {
    expect(extractPiUserText('  直接一段  ')).toBe('直接一段')
  })

  it('非文本 / 缺省 ⇒ 空串（不编造内容）', () => {
    expect(extractPiUserText(undefined)).toBe('')
    expect(extractPiUserText([{ type: 'image', data: 'xxx' }])).toBe('')
  })
})
