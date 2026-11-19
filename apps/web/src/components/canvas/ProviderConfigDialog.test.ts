import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import ProviderConfigDialog from './ProviderConfigDialog.vue'

const here = dirname(fileURLToPath(import.meta.url))

// attachTo 的 teleport 弹层卸载后偶发残留 DOM，污染后续用例 ⇒ 每条测试后强制清空。
afterEach(() => {
  document.body.innerHTML = ''
})

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>()
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  }
})

vi.mock('@/composables/useProviderBootstrap', async () => {
  const { computed, ref } = await import('vue')
  const models = Array.from({ length: 300 }, (_, i) => ({
    name: `model-${i}`,
    capability: i % 2 === 0 ? ('text' as const) : ('image' as const),
  }))
  const platformChannel = {
    id: 'platform',
    name: '平台',
    apiFormat: 'openai' as const,
    baseUrl: '',
    models: [
      { name: 'agnes-ghost', capability: 'text' as const, availability: 'unavailable' as const },
      { name: 'agnes-image', capability: 'image' as const },
    ],
    hasApiKey: true,
    readOnly: true,
    createdAt: '',
    updatedAt: '',
  }
  const userChannel = {
    id: 'ch1',
    name: 'BYOK',
    apiFormat: 'openai' as const,
    baseUrl: 'https://api.example.com/v1',
    models,
    hasApiKey: true,
    readOnly: false,
    createdAt: '',
    updatedAt: '',
  }
  const preferences = {
    selectableImageModels: [],
    selectableVideoModels: [],
    selectableTextModels: [],
    selectableAudioModels: [],
    defaultImageModel: '',
    defaultVideoModel: '',
    defaultTextModel: '',
    defaultAudioModel: '',
    canvasImageCount: 1,
    defaultImageAspect: '16:9',
    defaultImageResolution: '1K',
    defaultVideoAspect: '16:9',
    defaultVideoDuration: 5,
    defaultVideoResolution: '720p',
    defaultVideoCrop: 'none',
    audioVoice: 'female-shaonv',
    audioFormat: 'mp3',
    audioSpeed: 1,
    audioInstructions: null,
    systemPrompt: null,
  }
  const webdav = {
    url: '',
    directory: '',
    username: '',
    hasPassword: false,
    connectionMode: 'proxy' as const,
    lastSyncedAt: null,
  }
  const allChannels = ref([platformChannel, userChannel])
  return {
    useProviderBootstrap: () => ({
      load: vi.fn().mockResolvedValue({
        platformChannel,
        channels: [userChannel],
        preferences,
        webdav,
      }),
      loading: ref(false),
      allChannels: computed(() => allChannels.value),
      preferences: ref(preferences),
      webdav: ref(webdav),
      patchChannel: vi.fn(),
      patchPreferences: vi.fn(),
      patchWebdav: vi.fn(),
      setBootstrap: vi.fn(),
    }),
  }
})

describe('ProviderConfigDialog', () => {
  it('window-renders channel models and capability-filters selectable options', async () => {
    const wrapper = mount(ProviderConfigDialog, {
      props: { modelValue: false },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    const rows = wrapper.findAll('.channel-model-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(40)
    expect(wrapper.findAll('.el-select').length).toBeLessThan(10)

    const modelTab = wrapper.findAll('.el-tabs__item').find((item) => item.text() === '模型')
    expect(modelTab).toBeTruthy()
    await modelTab!.trigger('click')
    await flushPromises()

    const selects = wrapper.findAllComponents({ name: 'ElSelectV2' })
    expect(selects.length).toBe(4)
    const imageOptions = selects[0].props('options') as Array<{ value: string }>
    expect(imageOptions.some((opt) => opt.value.endsWith('agnes-image'))).toBe(true)
    expect(imageOptions.some((opt) => opt.value.endsWith('model-1'))).toBe(true)
    expect(imageOptions.some((opt) => opt.value.endsWith('model-0'))).toBe(false)
    expect(imageOptions.length).toBeLessThan(200)
  })

  it('S1-3：平台渠道 unavailable 条目灰显标注「暂不可用」，正常条目不标注', async () => {
    const wrapper = mount(ProviderConfigDialog, {
      props: { modelValue: false },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    const ghostRow = wrapper.findAll('.channel-model-row').find((el) => el.text().includes('agnes-ghost'))
    expect(ghostRow).toBeTruthy()
    expect(ghostRow!.text()).toContain('暂不可用')

    const okRow = wrapper.findAll('.channel-model-row').find((el) => el.text().includes('agnes-image'))
    expect(okRow).toBeTruthy()
    expect(okRow!.text()).not.toContain('暂不可用')
  })

  it('设置域令牌已迁移：弹层无任何 --neo-* 残留', () => {
    const sfc = readFileSync(join(here, 'ProviderConfigDialog.vue'), 'utf8')
    expect(sfc.match(/--neo-/g) ?? []).toHaveLength(0)
  })

  it('弹层有可访问名：自定义标题 id 被真实引用，内层 dialog 的 aria-labelledby 不悬空', async () => {
    const wrapper = mount(ProviderConfigDialog, {
      props: { modelValue: true },
      global: { plugins: [ElementPlus] },
      attachTo: document.body,
    })
    await flushPromises()

    // Element Plus 把 attrs 透传到内层 .el-dialog（role=dialog 外层的 aria-labelledby
    // 是库自身生成的 el-id-*，自定义 header 时会悬空——属上游行为，不由本项目修）。
    // 本项目职责：提供一个真实存在的标题，并让内层 dialog 的 aria-labelledby 指向它。
    const title = document.getElementById('provider-config-title')
    expect(title).toBeTruthy()
    expect(title!.textContent).toContain('配置与用户偏好')

    const inner = document.body.querySelector('.el-dialog')
    expect(inner).toBeTruthy()
    const labelId = inner!.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId!)).toBe(title)

    // role=dialog 与 aria-modal 由上游保证
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy()
    wrapper.unmount()
  })
})
