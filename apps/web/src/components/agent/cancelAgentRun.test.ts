import { describe, expect, it, vi } from 'vitest'
import { cancelAgentRun, cancelledCalloutTextFromProgress, recoveredQueueText } from './cancelAgentRun'

describe('cancelAgentRun', () => {
  it('calls API then abort even if API fails', async () => {
    const abort = vi.fn()
    const postCancel = vi.fn().mockRejectedValue(new Error('network'))
    const result = await cancelAgentRun({
      threadId: 't1',
      sessionId: 's1',
      abort,
      postCancel,
    })
    expect(postCancel).toHaveBeenCalledWith({ threadId: 't1', sessionId: 's1', reason: 'user' })
    expect(abort).toHaveBeenCalled()
    expect(result.apiOk).toBe(false)
  })

  it('reports skipped when runtime skips non-PV', async () => {
    const abort = vi.fn()
    const postCancel = vi.fn().mockResolvedValue({
      code: 0,
      data: { ok: true, skipped: true, reason: 'flow_not_supported' },
    })
    const result = await cancelAgentRun({
      threadId: 't1',
      sessionId: 's1',
      abort,
      postCancel,
    })
    expect(result.apiOk).toBe(true)
    expect(result.skipped).toBe(true)
    expect(abort).toHaveBeenCalled()
  })

  it('treats a response without ok:true as failure', async () => {
    const abort = vi.fn()
    const postCancel = vi.fn().mockResolvedValue({ code: 500, message: 'boom' })
    const result = await cancelAgentRun({
      threadId: 't1',
      sessionId: 's1',
      abort,
      postCancel,
    })
    expect(result.apiOk).toBe(false)
    expect(abort).toHaveBeenCalled()
  })

  it('surfaces gen progress and preserved gate from the cancel response', async () => {
    const postCancel = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        ok: true,
        phase: 'cancelled',
        completedTasks: 2,
        totalTasks: 5,
        gatePreserved: false,
      },
    })
    const result = await cancelAgentRun({
      threadId: 't1',
      sessionId: 's1',
      abort: vi.fn(),
      postCancel,
    })
    expect(result).toMatchObject({
      apiOk: true,
      completedTasks: 2,
      totalTasks: 5,
      gatePreserved: false,
    })
  })
})

describe('cancelledCalloutTextFromProgress', () => {
  it('renders the completed / total progress line', () => {
    expect(cancelledCalloutTextFromProgress(2, 5)).toBe(
      '已停止出图（完成 2/5）。直接说修改意见，或点「发起新任务」。',
    )
  })

  it('returns null without usable task counts', () => {
    expect(cancelledCalloutTextFromProgress(undefined, undefined)).toBeNull()
    expect(cancelledCalloutTextFromProgress(0, 0)).toBeNull()
  })
})

describe('⭐ recovered：abort 销毁的插队消息必须还给用户（2026-10-20 P0-2）', () => {
  it('透出服务端吐回的队列内容', async () => {
    const abort = vi.fn()
    const postCancel = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        ok: true,
        recovered: [
          { kind: 'steer', text: '再亮一点' },
          { kind: 'followUp', text: '然后导出九宫格' },
        ],
      },
    })
    const result = await cancelAgentRun({ threadId: 't1', sessionId: 's1', abort, postCancel })
    expect(result.recovered).toEqual([
      { kind: 'steer', text: '再亮一点' },
      { kind: 'followUp', text: '然后导出九宫格' },
    ])
  })

  it('老服务端不返回 recovered ⇒ 空数组（向后兼容，不是错误）', async () => {
    const abort = vi.fn()
    const postCancel = vi.fn().mockResolvedValue({ code: 0, data: { ok: true } })
    const result = await cancelAgentRun({ threadId: 't1', sessionId: 's1', abort, postCancel })
    expect(result.recovered).toEqual([])
  })

  it('⭐ 形状不合法的项一律丢弃（不把脏数据塞进用户输入框）', async () => {
    const abort = vi.fn()
    const postCancel = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        ok: true,
        recovered: [
          { kind: 'steer', text: '好的' },
          { kind: 'unknown-kind', text: '不该出现' },
          { kind: 'steer' },
          { text: '缺 kind' },
          null,
        ],
      },
    })
    const result = await cancelAgentRun({ threadId: 't1', sessionId: 's1', abort, postCancel })
    expect(result.recovered).toEqual([{ kind: 'steer', text: '好的' }])
  })

  it('请求失败 ⇒ recovered 为空（不能凭空造出内容）', async () => {
    const abort = vi.fn()
    const postCancel = vi.fn().mockRejectedValue(new Error('network'))
    const result = await cancelAgentRun({ threadId: 't1', sessionId: 's1', abort, postCancel })
    expect(result.apiOk).toBe(false)
    expect(result.recovered ?? []).toEqual([])
  })
})

describe('recoveredQueueText（还原成可回灌的文本）', () => {
  it('多条用空行分隔，保留分段感', () => {
    expect(recoveredQueueText([{ kind: 'steer', text: '第一条' }, { kind: 'followUp', text: '第二条' }]))
      .toBe('第一条\n\n第二条')
  })

  it('空文本的消息被跳过（回灌空白没有意义）', () => {
    expect(recoveredQueueText([{ kind: 'steer', text: '   ' }, { kind: 'steer', text: '有内容' }]))
      .toBe('有内容')
  })

  it('无内容 ⇒ 空串（正常取消路径：队列根本没被删）', () => {
    expect(recoveredQueueText([])).toBe('')
    expect(recoveredQueueText(undefined)).toBe('')
  })
})
