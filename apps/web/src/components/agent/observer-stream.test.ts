/**
 * 旁听流的 SSE 帧解析与游标 URL 构造（multi-device Task 5 · Review Focus #1）。
 *
 * 背景（evidence.md R1）：Task 4 已让 Nest 给带 seq 的帧写 `id:` 行，浏览器
 * EventSource 靠它维护 Last-Event-ID；但本项目旁听流走 fetch + 手工解析
 * （要带 auth 头，不能用 EventSource）⇒ 游标必须自己维护。
 *
 * 本文件钉死三个可观测行为：
 *  ① `id:` 行必须被解析出来（丢了游标，续传就无从谈起）；
 *  ② 重连 URL 只在**有游标**时拼 `lastEventId=`（null 时空拼会让 pi-runtime
 *     落进 afterSeq=-1 全量重放 —— plan 已知坑，会刷屏且冲掉中间态）；
 *  ③ 帧切分在「半帧到达」时不得吃掉残帧（网络分片是常态）。
 */
import { describe, expect, it } from 'vitest'
import { buildObserverStreamUrl, extractSseFrames, parseSseFrameSeq } from './observer-stream'

describe('extractSseFrames（帧切分，multi-device Task 5）', () => {
  it('按 \\n\\n 切帧，返回剩余半帧', () => {
    const { frames, rest } = extractSseFrames('data: a\n\ndata: b\n\ndata: half')
    expect(frames).toEqual(['data: a', 'data: b'])
    expect(rest).toBe('data: half')
  })

  it('无分隔符时全部留在 rest（等下一块网络数据）', () => {
    const { frames, rest } = extractSseFrames('data: partial')
    expect(frames).toEqual([])
    expect(rest).toBe('data: partial')
  })

  it('空 buffer 返回空', () => {
    expect(extractSseFrames('')).toEqual({ frames: [], rest: '' })
  })
})

describe('parseSseFrameSeq（id 行解析，Task 4 的下游消费）', () => {
  it('id 行必须被解析为数字', () => {
    expect(parseSseFrameSeq('id: 42\ndata: {"type":"text_delta"}')).toBe(42)
  })

  it('无 id 行返回 undefined（宿主合成帧）', () => {
    expect(parseSseFrameSeq('data: {"type":"heartbeat"}')).toBeUndefined()
  })

  it('非数字 id 不得被当成游标（NaN 会让续传错位）', () => {
    expect(parseSseFrameSeq('id: abc\ndata: {}')).toBeUndefined()
    expect(parseSseFrameSeq('id: -1\ndata: {}')).toBeUndefined()
  })
})

describe('buildObserverStreamUrl（重连游标，Review Focus #1）', () => {
  const base = '/api/agent/runs/events?sessionId=s1&threadId=t1'

  it('有游标时必须拼 lastEventId（断线续传而非重放）', () => {
    expect(buildObserverStreamUrl(base, 110)).toBe(`${base}&lastEventId=110`)
  })

  it('无游标（null）时绝不拼 lastEventId= 空值（pi-runtime 会全量重放）', () => {
    expect(buildObserverStreamUrl(base, null)).toBe(base)
    expect(buildObserverStreamUrl(base, null)).not.toContain('lastEventId')
  })

  it('游标 0 也是合法 seq（边界）', () => {
    expect(buildObserverStreamUrl(base, 0)).toBe(`${base}&lastEventId=0`)
  })
})
