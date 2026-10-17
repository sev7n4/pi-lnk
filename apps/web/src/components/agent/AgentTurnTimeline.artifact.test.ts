import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

/**
 * artifact 缩略图增强（2026-10-17 晚到回填体验补全）回归锁：
 * - part.url 直存时缩略图优先用它（晚到回填的产物，画布节点查找兜不到）；
 * - 无 part.url 回退 resolveNodeUrl（既有行为不回归）；
 * - 音频 url 不进 <img>/<video>（裂图），回退类型图标。
 */

type ArtifactPart = Extract<TimelinePart, { kind: 'artifact' }>

function artifactPart(overrides: Partial<ArtifactPart> = {}): TimelinePart {
  return {
    kind: 'artifact',
    id: 'artifact-1',
    nodeId: 'n1',
    nodeType: 'image',
    title: '主视觉海报',
    status: 'done',
    ...overrides,
  }
}

describe('AgentTurnTimeline — artifact 缩略图（晚到回填体验补全）', () => {
  it('part.url 直存 ⇒ 缩略图优先用它（无需 resolveNodeUrl）', () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [artifactPart({ url: 'https://cdn/a.png' })] },
    })
    const img = w.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://cdn/a.png')
  })

  it('无 part.url ⇒ 回退 resolveNodeUrl（既有行为不回归）', () => {
    const w = mount(AgentTurnTimeline, {
      props: {
        parts: [artifactPart()],
        resolveNodeUrl: (nodeId: string) =>
          nodeId === 'n1' ? 'https://canvas/a.png' : undefined,
      },
    })
    const img = w.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://canvas/a.png')
  })

  it('part.url 优先于 resolveNodeUrl（两者都在时直存赢）', () => {
    const w = mount(AgentTurnTimeline, {
      props: {
        parts: [artifactPart({ url: 'https://cdn/direct.png' })],
        resolveNodeUrl: () => 'https://canvas/lookup.png',
      },
    })
    expect(w.find('img').attributes('src')).toBe('https://cdn/direct.png')
  })

  it('音频产物不出 <img>/<video>（裂图防线），回退类型图标', () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [artifactPart({ nodeType: 'audio', url: 'https://cdn/bgm.mp3' })] },
    })
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('video').exists()).toBe(false)
  })

  it('视频产物出 <video> 预览（既有行为不回归）', () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [artifactPart({ nodeType: 'video', url: 'https://cdn/clip.mp4' })] },
    })
    const video = w.find('video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toBe('https://cdn/clip.mp4#t=0.1')
  })

  it('done 产物行出定位按钮；pending 不出（回填翻 done 后才可定位）', () => {
    const done = mount(AgentTurnTimeline, {
      props: { parts: [artifactPart({ url: 'https://cdn/a.png' })] },
    })
    expect(done.find('button[title="在画布中定位"]').exists()).toBe(true)

    const pending = mount(AgentTurnTimeline, {
      props: { parts: [artifactPart({ status: 'pending' })] },
    })
    expect(pending.find('button[title="在画布中定位"]').exists()).toBe(false)
  })
})
