import { describe, expect, it } from 'vitest'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'
import {
  describeCompletedWithoutOutput,
  settleDeadlineExceeded,
  DEFAULT_SETTLE_TIMEOUT_MS,
} from './generationPollGate'

// U6 回归锁。审计 §2.6 记的是「三处 while(true) 轮询无墙钟上限」，
// 实测只有 1 处 `for (;;)`（useNodeGeneration.ts:745waitForRunGroupMemberSettled）
// + 1 处独立轮询模块（useGenerationPolling.ts）—— **审计的函数名/形态记错了**，
// 但「无墙钟上限」这个结论成立。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.6

describe('settleDeadlineExceeded', () => {
  it('returns false before the deadline', () => {
    // ⚠️ 必须显式传 now：startedAt:0 是 1970 年，配Date.now() 必然已超时
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 1000, now: 999 })).toBe(false)
  })

  it('returns true after the deadline', () => {
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 1000, now: 1001 })).toBe(true)
  })

  it('treats exactly-at-deadline as exceeded (>=, not >)', () => {
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 1000, now: 1000 })).toBe(true)
  })

  it('is false when no timeout is configured (opt-out)', () => {
    // 必须允许「显式不设上限」—— 否则测试与某些长任务会被误杀
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: undefined, now: 9_999_999 })).toBe(
      false,
    )
    expect(settleDeadlineExceeded({ startedAt: 0, now: 9_999_999 })).toBe(false)
  })

  it('handles a 0 or negative timeout as immediately exceeded', () => {
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 0, now: 0 })).toBe(true)
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: -1, now: 0 })).toBe(true)
  })
  it('uses Date.now() when now is not supplied', () => {
    expect(settleDeadlineExceeded({ startedAt: Date.now(), timeoutMs: 60_000 })).toBe(false)
  })
})

describe('DEFAULT_SETTLE_TIMEOUT_MS', () => {
  it('exceeds the server-side video poll timeout (1_260_000)', () => {
    // 前端墙钟必须 > 服务端 VIDEO_POLL_TIMEOUT_MS(1_260_000)，
    // 否则服务端刚判超时、客户端已经先放弃 ⇒ 拿不到最后的错误信息。
    // 取 1_320_000 = 服务端 + 60s。
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBeGreaterThan(1_260_000)
  })
})

describe('describeCompletedWithoutOutput', () => {
  it('flags a media record that completed but has no usable url', () => {
    const msg = describeCompletedWithoutOutput({
      type: 'audio',
      url: '',
      metadata: JSON.stringify({ url: '' }),
    })
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/音频/)
  })

  it('returns null when the record has a url', () => {
    expect(
      describeCompletedWithoutOutput({ type: 'audio', url: 'https://cdn/a.mp3', metadata: null }),
    ).toBeNull()
  })

  it('returns null for a url that only exists in metadata', () => {
    expect(
      describeCompletedWithoutOutput({
        type: 'audio',
        url: null,
        metadata: JSON.stringify({ url: 'https://cdn/a.mp3' }),
      }),
    ).toBeNull()
  })

  it('returns null for text/prompt records (no url expected)', () => {
    // 文本没有 url 是正常的，不能误报
    expect(describeCompletedWithoutOutput({ type: 'text', url: '', metadata: null })).toBeNull()
    expect(describeCompletedWithoutOutput({ type: 'prompt', url: '', metadata: null })).toBeNull()
  })

  it('flags an image/video record with no url', () => {
    expect(describeCompletedWithoutOutput({ type: 'image', url: '', metadata: null })).toMatch(/图片/)
    expect(describeCompletedWithoutOutput({ type: 'video', url: '', metadata: null })).toMatch(/视频/)
  })

  it('tolerates malformed metadata instead of throwing', () => {
    expect(describeCompletedWithoutOutput({ type: 'audio', url: '', metadata: '{' })).toMatch(/音频/)
  })
})

describe('completed 无产物时的节点状态', () => {
  it('应判为 error 而非 completed（否则 UI 永久显示生成中）', () => {
    // 复现 applyStudioRecord 的缺陷：completed 无条件设status=completed，
    // 音频 url 为空时 patch.url='' ⇒ 节点永远「生成中」但没有任何产物。
    const record = { type: 'audio', status: NODE_GENERATION_STATUS.completed, url: '' }
    const notice = describeCompletedWithoutOutput(record)
    const shouldBeError = Boolean(notice)
    expect(shouldBeError).toBe(true)
  })
})
