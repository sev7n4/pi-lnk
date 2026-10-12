import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  DEFAULT_VIDEO_SETTINGS,
  resolveVideoModelCapabilities,
  videoBaselineAspectOptionsForCapabilities,
  videoBaselineResolutionOptionsForCapabilities,
} from '@lnkpi/shared'
import VideoSettingsSelector from './VideoSettingsSelector.vue'

async function openPopover(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('button[title="视频参数"]').trigger('click')
}

describe('VideoSettingsSelector', () => {
  it('shows a disabled generateAudio switch when model lacks native audio (agnes-video-v2.0)', async () => {
    const capabilities = resolveVideoModelCapabilities('agnes-video-v2.0', 'agnes-video-v2.0')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        capabilities,
        modelKey: 'agnes-video-v2.0',
      },
    })

    await openPopover(wrapper)
    const sw = wrapper.get('button[role="switch"]')
    expect(sw.attributes('disabled')).toBeDefined()
    expect(sw.attributes('title')).toBe('当前模型不支持生成音频')
  })

  it('disables generateAudio, hides seed and negative for minimax-h3', async () => {
    const capabilities = resolveVideoModelCapabilities('minimax-h3', 'MiniMax-H3')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        capabilities,
        modelKey: 'minimax-h3',
      },
    })

    await openPopover(wrapper)
    const text = wrapper.text()
    expect(wrapper.get('button[role="switch"]').attributes('disabled')).toBeDefined()
    expect(text).not.toContain('Seed')
    expect(text).not.toContain('排除内容')
  })

  it('shows seed and negative for Agnes, seed only for Seedance', async () => {
    const agnes = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        capabilities: resolveVideoModelCapabilities('agnes-video-v2.0', 'agnes-video-v2.0'),
        modelKey: 'agnes-video-v2.0',
      },
    })
    await openPopover(agnes)
    expect(agnes.text()).toContain('Seed')
    expect(agnes.text()).toContain('排除内容')

    const seedance = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        capabilities: resolveVideoModelCapabilities('seedance-2.0', 'doubao-seedance-2.0'),
        modelKey: 'seedance-2.0',
      },
    })
    await openPopover(seedance)
    expect(seedance.text()).toContain('Seed')
    expect(seedance.text()).not.toContain('排除内容')
  })

  it('does not inherit Agnes extras for unknown BYOK aliases', async () => {
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        modelKey: 'MinMax-H3',
      },
    })

    await openPopover(wrapper)
    expect(wrapper.text()).not.toContain('Seed')
    expect(wrapper.text()).not.toContain('排除内容')
    expect(wrapper.get('button[role="switch"]').attributes('disabled')).toBeDefined()
  })

  it('shows generateAudio for seedance models', async () => {
    const capabilities = resolveVideoModelCapabilities('seedance-2.0', 'doubao-seedance-2.0')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        capabilities,
        modelKey: 'seedance-2.0',
      },
    })

    await openPopover(wrapper)
    expect(wrapper.text()).toContain('生成音频')
  })

  it('hides crop when catalog crop disposition is metadataOnly', async () => {
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        modelKey: 'seedance-2.0',
      },
    })

    await openPopover(wrapper)
    expect(wrapper.text()).not.toContain('裁剪')
  })

  it('shows min duration hint when selected duration is below model minimum', async () => {
    const capabilities = resolveVideoModelCapabilities('agnes-video-v2.0', 'agnes-video-v2.0')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS, duration: 4 },
        capabilities,
        modelKey: 'agnes-video-v2.0',
      },
    })

    await openPopover(wrapper)
    expect(wrapper.text()).toContain('该模型最短 5 秒')
  })

  it('renders seedance baseline option set for seedance standard (all enabled)', async () => {
    const capabilities = resolveVideoModelCapabilities('seedance-2.0', 'doubao-seedance-2.0')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS },
        capabilities,
        modelKey: 'seedance-2.0',
      },
    })

    await openPopover(wrapper)
    const text = wrapper.text()
    expect(text).toContain('宽高比')
    expect(text).toContain('21:9')
    expect(text).toContain('4K')
    const arOpts = videoBaselineAspectOptionsForCapabilities(capabilities)
    const resOpts = videoBaselineResolutionOptionsForCapabilities(capabilities)
    for (const opt of arOpts) {
      expect(text).toContain(opt.value === 'adaptive' ? '自适应' : opt.value)
    }
    for (const opt of resOpts) {
      expect(text).toContain(opt.label)
    }
  })

  it('greys out unsupported baseline options for seedance mini', async () => {
    const capabilities = resolveVideoModelCapabilities('seedance-2.0-mini', 'doubao-seedance-2.0-mini')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS, resolution: '720p' },
        capabilities,
        modelKey: 'seedance-2.0-mini',
      },
    })

    await openPopover(wrapper)
    const disabled = wrapper.findAll('button[disabled]').map((b) => b.text())
    // 比例全集可用（mini 限制在分辨率），4K 置灰
    expect(disabled).toContain('4K')
    expect(disabled).not.toContain('16:9')
    const res4k = wrapper
      .findAll('button')
      .find((b) => b.text() === '4K')
    expect(res4k?.attributes('title')).toContain('不支持')
  })

  it('cogvideox: 全集置灰 + 时长离散为 5s/10s pill（无滑轨）+ 生成音频开关置灰', async () => {
    const capabilities = resolveVideoModelCapabilities('cogvideox-flash', 'cogvideox-flash')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS, duration: 10 },
        capabilities,
        modelKey: 'cogvideox-flash',
      },
    })

    await openPopover(wrapper)
    // 宽高比/分辨率整组置灰（模型自动处理）
    const disabledTexts = wrapper.findAll('button[disabled]').map((b) => b.text())
    for (const ratio of ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']) {
      expect(disabledTexts).toContain(ratio)
    }
    for (const res of ['480p', '720p', '1080p', '4K']) {
      expect(disabledTexts).toContain(res)
    }
    // 时长离散档位，无 range input
    expect(wrapper.find('input[type="range"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('5s')
    expect(wrapper.text()).toContain('10s')
    // 生成音频开关常驻但置灰（cogvideox 无原生音频）
    const sw = wrapper.get('button[role="switch"]')
    expect(sw.attributes('disabled')).toBeDefined()
    expect(sw.attributes('title')).toBe('当前模型不支持生成音频')
  })

  it('snaps invalid settings to nearest allowed on open (4k→1080p, 21:9→16:9)', async () => {
    const capabilities = resolveVideoModelCapabilities('agnes-video-v2.0', 'agnes-video-v2.0')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: {
          ...DEFAULT_VIDEO_SETTINGS,
          aspectRatio: '21:9' as typeof DEFAULT_VIDEO_SETTINGS.aspectRatio,
          resolution: '4k' as typeof DEFAULT_VIDEO_SETTINGS.resolution,
        },
        capabilities,
        modelKey: 'agnes-video-v2.0',
      },
    })

    await openPopover(wrapper)
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted?.length).toBeGreaterThan(0)
    const last = emitted!.at(-1)![0] as typeof DEFAULT_VIDEO_SETTINGS
    expect(last.aspectRatio).toBe('16:9')
    expect(last.resolution).toBe('1080p')
  })

  it('limits Agnes Video 2.5 Flash to 720p, 21:9, seed, and 4–12s', async () => {
    const capabilities = resolveVideoModelCapabilities('agnes-video-2.5-flash', 'agnes-video-2.5-flash')
    const wrapper = mount(VideoSettingsSelector, {
      props: {
        modelValue: { ...DEFAULT_VIDEO_SETTINGS, duration: 15, resolution: '1080p' },
        capabilities,
        modelKey: 'agnes-video-2.5-flash',
      },
    })

    await openPopover(wrapper)
    const text = wrapper.text()
    expect(text).toContain('21:9')
    expect(text).toContain('Seed')
    expect(text).not.toContain('排除内容')
    expect(text).toContain('分辨率')
    expect(text).toContain('720p')

    const range = wrapper.get('input[type="range"]')
    expect(range.attributes('min')).toBe('4')
    expect(range.attributes('max')).toBe('12')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted?.length).toBeGreaterThan(0)
    const last = emitted!.at(-1)![0] as typeof DEFAULT_VIDEO_SETTINGS
    expect(last.duration).toBe(12)
    expect(last.resolution).toBe('720p')
  })
})
