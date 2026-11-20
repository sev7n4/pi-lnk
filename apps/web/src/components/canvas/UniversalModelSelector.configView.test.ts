// PC 锚定模型卡配置视图（2026-11-20）：与移动 Sheet 同规范的 popover 内二级页。
// configEnabled 未传 ⇒ 零变化（studio 宿主回归零）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { encodeChannelModel } from '@lnkpi/shared'
import UniversalModelSelector from './UniversalModelSelector.vue'

const here = dirname(fileURLToPath(import.meta.url))
const vueSrc = readFileSync(join(here, 'UniversalModelSelector.vue'), 'utf8')

const visionTextModel = encodeChannelModel('ch1', 'gpt-4o')

vi.mock('@/composables/useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({
    preferences: ref({
      selectableTextModels: [visionTextModel],
      selectableImageModels: [],
      selectableVideoModels: [],
      selectableAudioModels: [],
    }),
    allChannels: ref([{ id: 'ch1', name: 'BYOK' }]),
  }),
}))

vi.mock('@/composables/useModelHealth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useModelHealth')>()
  const { ref } = await import('vue')
  return { ...actual, useModelHealth: () => ref(null) }
})

async function openDropdown(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('button[title^="文本模型"]').trigger('click')
}

describe('UniversalModelSelector PC 配置视图', () => {
  it('configEnabled=false（缺省）→ 无配置入口，列表页无标题头（存量零变化）', async () => {
    const w = mount(UniversalModelSelector, { props: { modelValue: visionTextModel, type: 'text' } })
    await openDropdown(w)
    expect(w.find('[data-testid="pc-model-config-open"]').exists()).toBe(false)
    expect(w.text()).not.toContain('模型配置')
  })

  it('configEnabled → 列表页标题头 + 齿轮，点击进同 popover 配置页', async () => {
    const w = mount(UniversalModelSelector, {
      props: { modelValue: visionTextModel, type: 'text', configEnabled: true },
    })
    await openDropdown(w)
    expect(w.text()).toContain('选择模型')
    const gear = w.get('[data-testid="pc-model-config-open"]')
    expect(gear.attributes('aria-label')).toBe('模型配置')
    await gear.trigger('click')
    expect(w.text()).toContain('模型配置')
    expect(w.find('[data-testid="model-thinking-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="model-context-row"]').exists()).toBe(true)
  })

  it('配置页 → thinking 二级页 → 档位点击派发 set-thinking 并回配置页', async () => {
    const w = mount(UniversalModelSelector, {
      props: {
        modelValue: visionTextModel,
        type: 'text',
        configEnabled: true,
        thinkingSupported: true,
        thinkingLevel: '标准',
      },
    })
    await openDropdown(w)
    await w.get('[data-testid="pc-model-config-open"]').trigger('click')
    await w.get('[data-testid="model-thinking-row"]').trigger('click')
    expect(w.text()).toContain('思考强度')
    const opts = w.findAll('[data-testid="thinking-level-option"]')
    expect(opts.length).toBe(3)
    await opts.find((o) => o.text().includes('深入'))!.trigger('click')
    expect(w.emitted('set-thinking')?.[0]).toEqual(['深入'])
    // WorkBuddy 语义：选完回配置页
    expect(w.find('[data-testid="model-thinking-row"]').exists()).toBe(true)
  })

  it('上下文窗口二级页只读：有说明文案，无 input/select', async () => {
    const w = mount(UniversalModelSelector, {
      props: { modelValue: visionTextModel, type: 'text', configEnabled: true, contextLabel: '200K tokens' },
    })
    await openDropdown(w)
    await w.get('[data-testid="pc-model-config-open"]').trigger('click')
    await w.get('[data-testid="model-context-row"]').trigger('click')
    expect(w.text()).toContain('暂不可配置')
    expect(w.find('input').exists()).toBe(false)
    expect(w.find('select').exists()).toBe(false)
  })

  it('返回按钮逐级回退：thinking→config→list；选择模型/关弹层后视图复位', async () => {
    const w = mount(UniversalModelSelector, {
      props: { modelValue: visionTextModel, type: 'text', configEnabled: true },
    })
    await openDropdown(w)
    await w.get('[data-testid="pc-model-config-open"]').trigger('click')
    await w.get('[data-testid="model-thinking-row"]').trigger('click')
    // thinking → config
    await w.get('[data-testid="pc-model-back"]').trigger('click')
    expect(w.find('[data-testid="model-thinking-row"]').exists()).toBe(true)
    // config → list
    await w.get('[data-testid="pc-model-back"]').trigger('click')
    expect(w.findAll('.neo-popover-item').length).toBeGreaterThan(0)
    // config → list 后选择模型 → 弹层关 + 视图复位（重开回到列表）
    await w.findAll('.neo-popover-item')[0].trigger('click')
    expect(w.emitted('update:modelValue')).toBeDefined()
    await openDropdown(w)
    expect(w.find('[data-testid="model-thinking-row"]').exists()).toBe(false)
    expect(w.text()).toContain('选择模型')
  })

  it('齿轮 hover 触控/可见性：44px 触控区样式落在父组件作用域', () => {
    // PC 弹层内齿轮非插槽内容，样式随组件 scoped；断言源码含显式尺寸防 0×0 回归
    expect(vueSrc).toContain('.ums-gear {')
    const at = vueSrc.indexOf('.ums-gear {')
    const block = vueSrc.slice(at, at + 420)
    expect(block).toContain('width: 28px')
    expect(block).toContain('height: 28px')
  })
})
