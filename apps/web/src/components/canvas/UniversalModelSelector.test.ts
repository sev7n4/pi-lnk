import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { encodeChannelModel } from '@lnkpi/shared'
import UniversalModelSelector from './UniversalModelSelector.vue'
import type { ModelHealthSummary } from '@/composables/useModelHealth'

const visionTextModel = encodeChannelModel('ch1', 'gpt-4o')
const nonVisionTextModel = encodeChannelModel('ch1', 'deepseek-v4-pro')
const visionImageModel = encodeChannelModel('ch1', 'gpt-4o')
const ttsModel = encodeChannelModel('platform', 'minimax-speech-2.8-hd')
const musicModel = encodeChannelModel('platform', 'stepaudio-3-music-preview')
/** 目录外模型（用户 BYOK 自定义音频模型）—— 按缺省判 voice。 */
const byokAudioModel = encodeChannelModel('ch1', 'my-custom-tts')

/** S1-3：平台三态条目（unavailable / available / 旧数据缺字段）。 */
const ghostModel = encodeChannelModel('platform', 'minimax-ghost')
const okModel = encodeChannelModel('platform', 'minimax-ok')
const oldFormatModel = encodeChannelModel('platform', 'minimax-old-format')

vi.mock('@/composables/useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({
    preferences: ref({
      selectableTextModels: [visionTextModel, nonVisionTextModel, ghostModel, okModel, oldFormatModel],
      selectableImageModels: [visionImageModel],
      selectableVideoModels: [],
      selectableAudioModels: [ttsModel, musicModel, byokAudioModel],
    }),
    allChannels: ref([
      { id: 'ch1', name: 'BYOK' },
      {
        id: 'platform',
        name: '平台服务',
        models: [
          { name: 'minimax-ghost', capability: 'text', availability: 'unavailable' },
          { name: 'minimax-ok', capability: 'text', availability: 'available' },
          { name: 'minimax-old-format', capability: 'text' },
        ],
      },
    ]),
  }),
}))

/**
 * S1-3：健康投影模块只替换 `useModelHealth` 的触发行为（不真实发 HTTP），
 * 保留 availabilityOfModel / healthDotOfModel 原实现，测试注入走 `__healthRef`。
 */
vi.mock('@/composables/useModelHealth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useModelHealth')>()
  const { ref } = await import('vue')
  const healthRef = ref<ModelHealthSummary | null>(null)
  return {
    ...actual,
    useModelHealth: () => healthRef,
    __healthRef: healthRef,
  }
})

import * as modelHealthModule from '@/composables/useModelHealth'

/** 测试注入口（mock 工厂挂载的共享 ref）。 */
const healthRef = (
  modelHealthModule as unknown as { __healthRef: { value: ModelHealthSummary | null } }
).__healthRef

function setHealth(rows: ModelHealthSummary['rows'] | null, generatedAt = '2026-10-10T02:00:00.000Z') {
  healthRef.value = rows ? { generatedAt, windowHours: 24, rows } : null
}

async function openDropdown(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('button[title="文本模型"]').trigger('click')
}

describe('UniversalModelSelector', () => {
  it('shows 可识图 for vision-capable text models only', async () => {
    const wrapper = mount(UniversalModelSelector, {
      props: { modelValue: visionTextModel, type: 'text' },
    })

    await openDropdown(wrapper)
    const text = wrapper.text()
    expect(text).toContain('可识图')
    expect(text.match(/可识图/g)?.length).toBe(1)
    expect(text).toContain('deepseek-v4-pro')
  })

  it('does not show 可识图 for image modality', async () => {
    const wrapper = mount(UniversalModelSelector, {
      props: { modelValue: visionImageModel, type: 'image' },
    })

    await wrapper.get('button[title="图像模型"]').trigger('click')
    expect(wrapper.text()).not.toContain('可识图')
  })
})

// 🔴 这条过滤是防错而非锦上添花：服务端 `assertAudioKindMatchesModel` 对
// 「声明 music 却拿着 TTS 模型」显式 400，所以下拉列错模型 = 用户必撞 400。
describe('UniversalModelSelector 音频按 kind 过滤', () => {
  function mountAudio(audioKind?: 'voice' | 'design' | 'music', modelValue = ttsModel) {
    return mount(UniversalModelSelector, {
      props: { modelValue, type: 'text', modality: 'audio', audioKind },
    })
  }

  async function openAudioDropdown(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('button[title="音频模型"]').trigger('click')
  }

  /** 只取下拉候选列表的文本（不含「当前模型已停用」那一条头部）。 */
  function listedModels(wrapper: ReturnType<typeof mount>): string {
    return wrapper.findAll('.neo-popover-item').map((el) => el.text()).join('|')
  }

  it('选了 music 就只列音乐模型（不列 TTS）', async () => {
    // 切分类时 `setAudioKind` 会把模型换成该分类首选，所以这里 modelValue 也是音乐模型
    const wrapper = mountAudio('music', musicModel)
    await openAudioDropdown(wrapper)
    expect(listedModels(wrapper)).toContain('stepaudio-3-music-preview')
    expect(listedModels(wrapper)).not.toContain('minimax-speech-2.8-hd')
  })

  it('选了 voice 时目录外 BYOK 音频模型仍然列出（缺省视作 voice）', async () => {
    const wrapper = mountAudio('voice')
    await openAudioDropdown(wrapper)
    const listed = listedModels(wrapper)
    expect(listed).toContain('minimax-speech-2.8-hd')
    expect(listed).toContain('my-custom-tts')
    expect(listed).not.toContain('stepaudio-3-music-preview')
  })

  it('未传 audioKind 时不过滤（存量调用零变化）', async () => {
    const wrapper = mountAudio(undefined)
    await openAudioDropdown(wrapper)
    const listed = listedModels(wrapper)
    expect(listed).toContain('minimax-speech-2.8-hd')
    expect(listed).toContain('stepaudio-3-music-preview')
    expect(listed).toContain('my-custom-tts')
  })

  it('audioKind 对非 audio 模态无影响', async () => {
    const wrapper = mount(UniversalModelSelector, {
      props: { modelValue: visionTextModel, type: 'text', audioKind: 'music' },
    })
    await openDropdown(wrapper)
    expect(wrapper.text()).toContain('deepseek-v4-pro')
  })
})

// ── S1-3：探活灰显（A3）与健康角标（A4）────────────────────────────────────

describe('UniversalModelSelector 探活灰显（A3）', () => {
  /** 取下拉里 modelKey 对应的候选按钮。 */
  function optionButton(wrapper: ReturnType<typeof mount>, modelKey: string) {
    return wrapper.findAll('.neo-popover-item').find((el) => el.text().includes(modelKey))
  }

  it('unavailable → disabled + 「暂不可用」角标，点击不派发 update:modelValue', async () => {
    const wrapper = mount(UniversalModelSelector, {
      props: { modelValue: visionTextModel, type: 'text' },
    })
    await openDropdown(wrapper)
    const btn = optionButton(wrapper, 'minimax-ghost')!
    expect(btn.text()).toContain('暂不可用')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('unknown / 缺字段照常可选（不灰显、无角标）', async () => {
    const wrapper = mount(UniversalModelSelector, {
      props: { modelValue: visionTextModel, type: 'text' },
    })
    await openDropdown(wrapper)
    for (const key of ['minimax-ok', 'minimax-old-format']) {
      const btn = optionButton(wrapper, key)!
      expect(btn.text()).not.toContain('暂不可用')
      expect(btn.attributes('disabled')).toBeUndefined()
    }
  })

  it('灰显条目 hover 携带最近探活统计时间（若健康响应携带 generatedAt）', async () => {
    setHealth([], '2026-10-10T02:00:00.000Z')
    try {
      const wrapper = mount(UniversalModelSelector, {
        props: { modelValue: visionTextModel, type: 'text' },
      })
      await openDropdown(wrapper)
      const btn = optionButton(wrapper, 'minimax-ghost')!
      expect(btn.attributes('title')).toContain('暂不可用')
      expect(btn.attributes('title')).toContain('最近探活')
    } finally {
      setHealth(null)
    }
  })
})

describe('UniversalModelSelector 健康角标（A4 抽行）', () => {
  function optionButton(wrapper: ReturnType<typeof mount>, modelKey: string) {
    return wrapper.findAll('.neo-popover-item').find((el) => el.text().includes(modelKey))
  }

  it('0.4 → 红点 + hover「近24h 成功率 4/10」；0.7 → 黄点', async () => {
    setHealth([
      { model: 'minimax-ok', channelId: 'platform', windowHours: 24, total: 10, completed: 4, failed: 6, fallbackPending: 0, refunded: 0, successRate: 0.4 },
    ])
    try {
      const wrapper = mount(UniversalModelSelector, {
        props: { modelValue: visionTextModel, type: 'text' },
      })
      await openDropdown(wrapper)
      const redDot = optionButton(wrapper, 'minimax-ok')!.find('.model-health-dot')
      expect(redDot.exists()).toBe(true)
      expect(redDot.classes()).toContain('bg-red-500/90')
      expect(redDot.attributes('title')).toBe('近24h 成功率 4/10')
    } finally {
      setHealth(null)
    }

    setHealth([
      { model: 'minimax-ok', channelId: 'platform', windowHours: 24, total: 10, completed: 7, failed: 3, fallbackPending: 0, refunded: 0, successRate: 0.7 },
    ])
    try {
      const wrapper = mount(UniversalModelSelector, {
        props: { modelValue: visionTextModel, type: 'text' },
      })
      await openDropdown(wrapper)
      const dot = optionButton(wrapper, 'minimax-ok')!.find('.model-health-dot')
      expect(dot.classes()).toContain('bg-amber-400/90')
    } finally {
      setHealth(null)
    }
  })

  it('0.95 / null / 无健康数据 → 无角标；BYOK 模型不误挂平台行角标', async () => {
    setHealth([
      { model: 'minimax-ok', channelId: 'platform', windowHours: 24, total: 20, completed: 19, failed: 1, fallbackPending: 0, refunded: 0, successRate: 0.95 },
      { model: 'gpt-4o', channelId: 'platform', windowHours: 24, total: 2, completed: 0, failed: 2, fallbackPending: 0, refunded: 0, successRate: 0 },
    ])
    try {
      const wrapper = mount(UniversalModelSelector, {
        props: { modelValue: visionTextModel, type: 'text' },
      })
      await openDropdown(wrapper)
      expect(optionButton(wrapper, 'minimax-ok')!.find('.model-health-dot').exists()).toBe(false)
      // BYOK（ch1）gpt-4o 只匹配本人 BYOK 行（无）⇒ 平台行 0 成功率不误挂
      const byokBtn = optionButton(wrapper, 'gpt-4o')!
      expect(byokBtn.find('.model-health-dot').exists()).toBe(false)
    } finally {
      setHealth(null)
    }
  })
})
