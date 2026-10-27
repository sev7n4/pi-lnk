import { describe, it, expect } from 'vitest'
import { projectCoverFallback } from './projectCoverFallback'

describe('projectCoverFallback', () => {
  it('coverUrl 非空 → image', () =>
    expect(projectCoverFallback({ coverUrl: 'u' })).toEqual({
      type: 'image',
      value: 'u',
    }))

  it('coverUrl 空串 → 兜底（画布墨点纸纹，非头像位语言——见 home-profile-p3 守卫）', () =>
    expect(projectCoverFallback({ coverUrl: '' })).toEqual({
      type: 'fallback',
    }))

  it('coverUrl null → 兜底', () =>
    expect(projectCoverFallback({ coverUrl: null })).toEqual({
      type: 'fallback',
    }))

  // v2.4（生产取证实证）：历史数据存在 .wav / .mp4 封面（音频/视频节点产物），
  // <img> 解码失败只剩裂图 ⇒ 统一落墨点兜底。
  it('coverUrl 是音频（.wav）→ 兜底，不进 <img> 出裂图', () =>
    expect(projectCoverFallback({ coverUrl: 'http://x/api/uploads/u/1-0399355e.wav' })).toEqual({
      type: 'fallback',
    }))

  it('coverUrl 是视频（.mp4）→ 兜底', () =>
    expect(projectCoverFallback({ coverUrl: 'https://x/videos/task_x.mp4' })).toEqual({
      type: 'fallback',
    }))

  it('图片扩展名不受影响（含查询串）', () =>
    expect(projectCoverFallback({ coverUrl: 'https://x/images/t2i/a.png?token=1' })).toEqual({
      type: 'image',
      value: 'https://x/images/t2i/a.png?token=1',
    }))

  it('图片 URL 路径里含 mp4 字样不误伤（只看扩展名段）', () =>
    expect(projectCoverFallback({ coverUrl: 'https://x/mp4-cover/image.png' })).toEqual({
      type: 'image',
      value: 'https://x/mp4-cover/image.png',
    }))
})
