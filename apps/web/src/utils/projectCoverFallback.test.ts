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
})
