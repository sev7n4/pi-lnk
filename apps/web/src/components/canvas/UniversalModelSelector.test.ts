import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { encodeChannelModel } from '@lnkpi/shared'
import UniversalModelSelector from './UniversalModelSelector.vue'

const visionTextModel = encodeChannelModel('ch1', 'gpt-4o')
const nonVisionTextModel = encodeChannelModel('ch1', 'deepseek-v4-pro')
const visionImageModel = encodeChannelModel('ch1', 'gpt-4o')
const ttsModel = encodeChannelModel('platform', 'minimax-speech-2.8-hd')
const musicModel = encodeChannelModel('platform', 'stepaudio-3-music-preview')
/** 目录外模型（用户 BYOK 自定义音频模型）—— 按缺省判 voice。 */
const byokAudioModel = encodeChannelModel('ch1', 'my-custom-tts')

vi.mock('@/composables/useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({
    preferences: ref({
      selectableTextModels: [visionTextModel, nonVisionTextModel],
      selectableImageModels: [visionImageModel],
      selectableVideoModels: [],
      selectableAudioModels: [ttsModel, musicModel, byokAudioModel],
    }),
    allChannels: ref([{ id: 'ch1', name: 'BYOK' }]),
  }),
}))

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
