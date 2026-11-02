import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import { CANVAS_NODE_CANCEL_KEY } from '@/composables/canvasNodeActions'
import type { TimelinePart } from './turnTimeline'
import type { ProposalCanvasNode } from '@/composables/useProposalNodeData'

/**
 * artifact 卡演进两阶段：
 * - 2026-10-17 缩略图回归锁：part.url 直存优先 / resolveNodeUrl 兜底 / 音频不进
 *   <img>/<video> / done 才出定位（pending 不出）。
 * - 2026-11-02 卡片 UX 优化：执行面增强——running 墨滴进度 + 停止生成
 *   （CANVAS_NODE_CANCEL_KEY inject，null 兜底不渲染）+ 预扣积分；done 查看结果↗
 *   回链 + 消耗积分 + 画布段点亮；failed 重试（emit retryNode）+ 未扣减删除线。
 *   品牌三联轨道由根 state-* 类驱动（R-A 表：running=.55 / done=1 / failed=.5）。
 *
 * ledger R1/R2：积分经 `canvasNodes` prop 纯解析（服务端 creditCost 优先，
 * 本地估算兜底），不读 store / 不用 Pinia。
 */

type ArtifactPart = Extract<TimelinePart, { kind: 'artifact' }>

const seedNode: ProposalCanvasNode = {
  id: 'n1',
  type: 'image',
  data: {
    label: '产品主图',
    imageModel: 'realism-v2',
    imageAspect: '1:1',
    imageResolution: '1K',
    imageCount: 1,
  },
}

function artifactPart(over: Partial<ArtifactPart> = {}): TimelinePart {
  return {
    kind: 'artifact',
    id: 'artifact:n1',
    nodeId: 'n1',
    nodeType: 'image',
    title: '产品主图',
    status: 'running',
    ...over,
  }
}

function mountCard(
  parts: TimelinePart[],
  opts: {
    cancel?: (id: string) => void
    resolveNodeUrl?: (nodeId: string) => string | undefined
  } = {},
) {
  return mount(AgentTurnTimeline, {
    props: {
      parts,
      canvasNodes: [seedNode],
      resolveNodeUrl: opts.resolveNodeUrl,
    },
    global: opts.cancel
      ? { provide: { [CANVAS_NODE_CANCEL_KEY as symbol]: opts.cancel } }
      : undefined,
  })
}

describe('AgentTurnTimeline — artifact 执行卡（2026-11-02）', () => {
  it('running：显停止生成，点击调 inject 的 cancelGeneration(nodeId)', async () => {
    const cancel = vi.fn()
    const w = mountCard([artifactPart()], { cancel })
    await w.find('[data-test="stop"]').trigger('click')
    expect(cancel).toHaveBeenCalledWith('n1')
  })

  it('running：无 inject（独立渲染场景）不渲染停止钮，优雅降级不报错', () => {
    const w = mountCard([artifactPart()])
    expect(w.find('[data-test="stop"]').exists()).toBe(false)
    expect(w.find('[data-test="artifact-card"]').exists()).toBe(true)
  })

  it('running：锚轨是唯一进度载体（墨滴条已退役）+ 预扣积分 pill + 「生成中」，不误报失败', () => {
    const w = mountCard([artifactPart({ progressElapsedMs: 125_000 })])
    expect(w.find('.trilink-rail').exists()).toBe(true)
    expect(w.find('.inkfill').exists()).toBe(false)
    expect(w.text()).toMatch(/预扣\s*\d+\s*积分/)
    expect(w.text()).toContain('生成中')
    expect(w.text()).not.toContain('生成失败')
    expect(w.text()).toContain('2m05s')
  })

  it('running：根类 state-running（三联轨道 --p 由 CSS R-A 表驱动）', () => {
    const w = mountCard([artifactPart()])
    expect(w.find('[data-test="artifact-card"]').classes()).toContain('state-running')
    expect(w.find('.trilink-rail').exists()).toBe(true)
  })

  it('done：查看结果↗ 回链（emit focusNode）+ 消耗积分', async () => {
    const w = mountCard([artifactPart({ status: 'done', url: 'https://cdn/a.png' })])
    expect(w.find('[data-test="view-result"]').exists()).toBe(true)
    await w.find('[data-test="view-result"]').trigger('click')
    expect(w.emitted('focusNode')?.[0]).toEqual(['n1'])
    expect(w.text()).toMatch(/消耗\s*\d+\s*积分/)
    expect(w.find('[data-test="artifact-card"]').classes()).toContain('state-done')
  })

  it('failed：重试 emit retryNode + 未扣减 + 错误文案 + 定位仍可用 + state-failed', async () => {
    const w = mountCard([artifactPart({ status: 'failed', errorText: '生成超时' })])
    await w.find('[data-test="retry"]').trigger('click')
    expect(w.emitted('retryNode')?.[0]).toEqual(['n1'])
    expect(w.text()).toContain('未扣减')
    expect(w.text()).toContain('生成超时')
    expect(w.find('button[title="在画布中定位"]').exists()).toBe(true)
    expect(w.find('[data-test="artifact-card"]').classes()).toContain('state-failed')
  })

  it('pending：不渲染执行面动作（尚未确认，无停止/重试/查看/定位）', () => {
    const w = mountCard([artifactPart({ status: 'pending' })])
    expect(w.find('[data-test="stop"]').exists()).toBe(false)
    expect(w.find('[data-test="retry"]').exists()).toBe(false)
    expect(w.find('[data-test="view-result"]').exists()).toBe(false)
    expect(w.find('button[title="在画布中定位"]').exists()).toBe(false)
  })
})

describe('AgentTurnTimeline — artifact 缩略图（晚到回填体验补全回归锁）', () => {
  it('part.url 直存 ⇒ 缩略图优先用它（无需 resolveNodeUrl）', () => {
    const w = mountCard([artifactPart({ status: 'done', url: 'https://cdn/a.png' })])
    const img = w.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://cdn/a.png')
  })

  it('无 part.url ⇒ 回退 resolveNodeUrl（既有行为不回归）', () => {
    const w = mountCard([artifactPart({ status: 'done' })], {
      resolveNodeUrl: (nodeId) => (nodeId === 'n1' ? 'https://canvas/a.png' : undefined),
    })
    const img = w.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://canvas/a.png')
  })

  it('part.url 优先于 resolveNodeUrl（两者都在时直存赢）', () => {
    const w = mountCard([artifactPart({ status: 'done', url: 'https://cdn/direct.png' })], {
      resolveNodeUrl: () => 'https://canvas/lookup.png',
    })
    expect(w.find('img').attributes('src')).toBe('https://cdn/direct.png')
  })

  it('音频产物不出 <img>/<video>（裂图防线），回退类型图标', () => {
    const w = mountCard([artifactPart({ status: 'done', nodeType: 'audio', url: 'https://cdn/bgm.mp3' })])
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('video').exists()).toBe(false)
  })

  it('视频产物出 <video> 预览（既有行为不回归）', () => {
    const w = mountCard([artifactPart({ status: 'done', nodeType: 'video', url: 'https://cdn/clip.mp4' })])
    const video = w.find('video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toBe('https://cdn/clip.mp4#t=0.1')
  })

  it('done 产物行出定位按钮；pending 不出（回填翻 done 后才可定位）', () => {
    const done = mountCard([artifactPart({ status: 'done', url: 'https://cdn/a.png' })])
    expect(done.find('button[title="在画布中定位"]').exists()).toBe(true)

    const pending = mountCard([artifactPart({ status: 'pending' })])
    expect(pending.find('button[title="在画布中定位"]').exists()).toBe(false)
  })
})
