/**
 * W1c（D1=A）前端纯函数 + 取数行为测试。
 * spec: docs/superpowers/specs/2026-11-12-sse-p2-web-interruption-state-design.md
 * plan: docs/superpowers/plans/2026-11-12-sse-p2-web-interruption-state.md §3 Task 2/3
 *
 * 覆盖：
 *  - fetchInterruptionState：fail-open 矩阵（非 200 / 坏 json / 形态不符 / 无 interruption）+ 成功路径 + 鉴权头 + no-store
 *  - reconcileTimelineInterruption：W1c-1（活门重建）/ W1c-2（终态卡）/ 单门语义 / 幂等
 *
 * 变异自检（手工改实现 ⇒ 对应断言 RED，见文件尾 describe 块）：
 *  M1 去掉 reconcileTimelineInterruption 里 `summary===null` 分支的翻 expired → W1c-1a RED
 *  M2 去掉 `isLive` 判定（只看 status） → W1c-2d RED
 *  M3 去掉终态分支的「无 part 补建」 → W1c-2e RED
 *  M4 去掉单门语义（其余 callId 活卡不翻 expired） → 单门语义测试 RED
 *  M5 去掉 fetchInterruptionState 的 `cache:'no-store'` → no-store 断言 RED
 *  M6 注释/代码写回 `thread-state` 字面量 → 撞 H1-c 退役守卫（本文件不含该字面量）
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createTurnTimeline,
  reconcileTimelineInterruption,
  type InterruptionSummary,
  type TimelinePart,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'
import { fetchInterruptionState } from '@/components/agent/interruptionState'

function makeTimelineWithQuestion(
  callId: string,
  status: 'pending_answer' | 'answered' | 'declined' | 'expired' = 'pending_answer',
  title = '需要你回答',
): TurnTimeline {
  const t = createTurnTimeline()
  t.parts.push({
    kind: 'question',
    id: `question:${callId}`,
    callId,
    title,
    status,
    questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A', value: 'A' }] }],
    startedAt: Date.now() - 1000,
  })
  return t
}

function fakeResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response
}

const NOW = 1_800_000_000_000
const liveSummary: InterruptionSummary = {
  callId: 'call-1',
  kind: 'ask_user',
  questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A', value: 'A' }] }],
  expiresAt: NOW + 120_000,
  status: 'pending',
}
const answeredSummary: InterruptionSummary = { ...liveSummary, status: 'answered' }
const expiredSummary: InterruptionSummary = { ...liveSummary, status: 'expired' }
const abortedSummary: InterruptionSummary = { ...liveSummary, status: 'aborted' }
const timedOutLiveSummary: InterruptionSummary = { ...liveSummary, expiresAt: NOW - 1 }

describe('fetchInterruptionState', () => {
  it('成功路径：返回归一化的 InterruptionSummary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ code: 0, message: 'ok', data: { interruption: liveSummary } }))
    const summary = await fetchInterruptionState('thread-A', { fetchImpl, tokenProvider: () => 'tok' })
    expect(summary).toEqual(liveSummary)
  })

  it('fail-open：非 200 ⇒ null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({}, false))
    expect(await fetchInterruptionState('t', { fetchImpl })).toBeNull()
  })

  it('fail-open：json 解析抛错 ⇒ null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad') } } as unknown as Response)
    expect(await fetchInterruptionState('t', { fetchImpl })).toBeNull()
  })

  it('fail-open：code !== 0 ⇒ null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ code: 1, data: { interruption: liveSummary } }))
    expect(await fetchInterruptionState('t', { fetchImpl })).toBeNull()
  })

  it('fail-open：data.interruption 缺失 ⇒ null（旧形状兼容，不抛）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ code: 0, data: {} }))
    expect(await fetchInterruptionState('t', { fetchImpl })).toBeNull()
  })

  it('fail-open：interruption.status 非法 ⇒ null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ code: 0, data: { interruption: { callId: 'c', status: 'weird' } } }))
    expect(await fetchInterruptionState('t', { fetchImpl })).toBeNull()
  })

  it('fail-open：fetch 抛网络错 ⇒ null', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'))
    expect(await fetchInterruptionState('t', { fetchImpl })).toBeNull()
  })

  it('带鉴权头：tokenProvider 返回 token ⇒ 附加 Authorization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ code: 0, data: { interruption: liveSummary } }))
    await fetchInterruptionState('thread-A', { fetchImpl, tokenProvider: () => 'abc' })
    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc')
  })

  it('M5 变异锚：请求带 cache: no-store（避免读到陈旧门状态）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ code: 0, data: { interruption: liveSummary } }))
    await fetchInterruptionState('t', { fetchImpl })
    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect(init.cache).toBe('no-store')
  })

  it('无 token ⇒ 不附加 Authorization 头（仍可用匿名态）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ code: 0, data: { interruption: liveSummary } }))
    await fetchInterruptionState('t', { fetchImpl, tokenProvider: () => null })
    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('reconcileTimelineInterruption · W1c-1（活门重建）', () => {
  it('W1c-1a: summary===null + 现有 pending_answer ⇒ 翻 expired（无权威证据即不可点）', () => {
    const t = makeTimelineWithQuestion('call-1', 'pending_answer')
    const changed = reconcileTimelineInterruption(t, null, NOW)
    expect(changed).toBe(true)
    expect((t.parts[0] as any).status).toBe('expired')
  })

  it('W1c-1b: summary===null + 无 question part（老会话）⇒ 零变更（阴性保证）', () => {
    const t = createTurnTimeline()
    const changed = reconcileTimelineInterruption(t, null, NOW)
    expect(changed).toBe(false)
    expect(t.parts).toHaveLength(0)
  })

  it('W1c-1c: summary 活门 + 无 part ⇒ 补建 pending_answer 卡', () => {
    const t = createTurnTimeline()
    const changed = reconcileTimelineInterruption(t, liveSummary, NOW)
    expect(changed).toBe(true)
    const q = t.parts.find((p) => p.kind === 'question')
    expect(q).toBeTruthy()
    expect((q as any).status).toBe('pending_answer')
    expect((q as any).callId).toBe('call-1')
  })

  it('W1c-1d: summary 活门 + 现有 pending_answer ⇒ 幂等（二次调用 changed=false）', () => {
    const t = makeTimelineWithQuestion('call-1', 'pending_answer')
    expect(reconcileTimelineInterruption(t, liveSummary, NOW)).toBe(false)
    // 二次调用仍 false
    expect(reconcileTimelineInterruption(t, liveSummary, NOW)).toBe(false)
    expect((t.parts[0] as any).status).toBe('pending_answer')
  })
})

describe('reconcileTimelineInterruption · W1c-2（终态卡）', () => {
  it('W1c-2a: summary answered ⇒ pending_answer 翻 answered', () => {
    const t = makeTimelineWithQuestion('call-1', 'pending_answer')
    expect(reconcileTimelineInterruption(t, answeredSummary, NOW)).toBe(true)
    expect((t.parts[0] as any).status).toBe('answered')
  })

  it('W1c-2b: summary expired ⇒ 翻 expired', () => {
    const t = makeTimelineWithQuestion('call-1', 'pending_answer')
    expect(reconcileTimelineInterruption(t, expiredSummary, NOW)).toBe(true)
    expect((t.parts[0] as any).status).toBe('expired')
  })

  it('W1c-2c: summary aborted ⇒ 翻 declined（取消/中止）', () => {
    const t = makeTimelineWithQuestion('call-1', 'pending_answer')
    expect(reconcileTimelineInterruption(t, abortedSummary, NOW)).toBe(true)
    expect((t.parts[0] as any).status).toBe('declined')
  })

  it('W1c-2d: summary status=pending 但已过期 ⇒ 按终态翻 expired（M2 变异点）', () => {
    const t = makeTimelineWithQuestion('call-1', 'pending_answer')
    expect(reconcileTimelineInterruption(t, timedOutLiveSummary, NOW)).toBe(true)
    expect((t.parts[0] as any).status).toBe('expired')
  })

  it('W1c-2e: 终态 summary + 无 part ⇒ 补建终态卡（M3 变异点）', () => {
    const t = createTurnTimeline()
    expect(reconcileTimelineInterruption(t, answeredSummary, NOW)).toBe(true)
    const q = t.parts.find((p) => p.kind === 'question')
    expect(q).toBeTruthy()
    expect((q as any).status).toBe('answered')
    expect((q as any).callId).toBe('call-1')
  })
})

describe('reconcileTimelineInterruption · 单门语义 + 幂等', () => {
  it('单门语义：只认 summary.callId 这一张，其余 callId 的活卡翻 expired（M4 变异点）', () => {
    const t = createTurnTimeline()
    t.parts.push({
      kind: 'question',
      id: 'question:call-A',
      callId: 'call-A',
      title: 'A',
      status: 'pending_answer',
      questions: [],
      startedAt: NOW,
    })
    t.parts.push({
      kind: 'question',
      id: 'question:call-B',
      callId: 'call-B',
      title: 'B',
      status: 'pending_answer',
      questions: [],
      startedAt: NOW,
    })
    // state 只说 call-A 活
    const summaryA: InterruptionSummary = { ...liveSummary, callId: 'call-A' }
    reconcileTimelineInterruption(t, summaryA, NOW)
    const statusOf = (id: string) =>
      (t.parts.find((p) => p.id === id)! as Extract<TimelinePart, { kind: 'question' }>).status
    expect(statusOf('question:call-A')).toBe('pending_answer')
    expect(statusOf('question:call-B')).toBe('expired')
  })

  it('幂等：终态 part 二次应用 changed=false（不重复建/翻）', () => {
    const t = makeTimelineWithQuestion('call-1', 'pending_answer')
    reconcileTimelineInterruption(t, answeredSummary, NOW)
    expect(reconcileTimelineInterruption(t, answeredSummary, NOW)).toBe(false)
  })
})
