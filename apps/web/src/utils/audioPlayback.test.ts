import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimAudioPlayback, releaseAudioPlayback, resetAudioPlaybackForTest } from './audioPlayback'

afterEach(() => {
  resetAudioPlaybackForTest()
  vi.restoreAllMocks()
})

describe('音频播放互斥协调器', () => {
  it('B 开始播放时暂停 A（磁贴与 viewer 不并发出声）', () => {
    const a = { pause: vi.fn() } as unknown as HTMLAudioElement
    const b = { pause: vi.fn() } as unknown as HTMLAudioElement
    claimAudioPlayback(a)
    claimAudioPlayback(b)
    expect(a.pause).toHaveBeenCalledTimes(1)
    expect(b.pause).not.toHaveBeenCalled()
  })

  it('同一实例重复 claim 不自我暂停', () => {
    const a = { pause: vi.fn() } as unknown as HTMLAudioElement
    claimAudioPlayback(a)
    claimAudioPlayback(a)
    expect(a.pause).not.toHaveBeenCalled()
  })

  it('旧实例 release 不误清新实例的播放权', () => {
    const a = { pause: vi.fn() } as unknown as HTMLAudioElement
    const b = { pause: vi.fn() } as unknown as HTMLAudioElement
    const c = { pause: vi.fn() } as unknown as HTMLAudioElement
    claimAudioPlayback(a)
    claimAudioPlayback(b) // a 被暂停
    releaseAudioPlayback(a) // a 的 @pause 迟到 ⇒ 不能把 b 的权清掉
    claimAudioPlayback(c)
    expect(b.pause).toHaveBeenCalledTimes(1)
    expect(c.pause).not.toHaveBeenCalled()
  })

  it('当前实例 release 后，下一次 claim 不再暂停谁', () => {
    const a = { pause: vi.fn() } as unknown as HTMLAudioElement
    const b = { pause: vi.fn() } as unknown as HTMLAudioElement
    claimAudioPlayback(a)
    releaseAudioPlayback(a)
    claimAudioPlayback(b)
    expect(a.pause).not.toHaveBeenCalled()
  })
})
