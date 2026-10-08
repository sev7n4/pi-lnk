import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import PromptDockPanel from './PromptDockPanel.vue'

vi.mock('@/composables/useModelProviderSettings', () => ({
  useModelProviderSettings: () => ({
    getConfig: () => ({ apiKey: '', baseUrl: '', model: 'test-text-model' }),
  }),
}))

vi.mock('@/composables/useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({
    allChannels: ref([{ id: 'platform', name: '平台' }]),
    preferences: ref(null),
  }),
}))

vi.mock('@/composables/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    listening: ref(false),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}))

vi.mock('@/components/canvas/dock-studio/shared/useDockLocalImageUpload', () => ({
  useDockLocalImageUpload: () => ({
    inputRef: ref(null),
    uploading: ref(false),
    uploadError: ref(''),
    pick: vi.fn(),
    onFileChange: vi.fn(),
  }),
}))

function createNode(data: Record<string, unknown> = {}): EditableFlowNode {
  return { id: 'prompt-1', type: 'prompt', position: { x: 0, y: 0 }, data }
}

function mountPanel(node: EditableFlowNode) {
  return mount(PromptDockPanel, {
    props: {
      node,
      upstream: {} as never,
      refs: [],
    },
  })
}

/**
 * 🔴 回归守卫（2026-10-08）：dock 曾内嵌「生成结果预览卡」（`v-if="generatedContent"`）。
 * 结果展示是画布节点卡 + 双击沉浸编辑层的职责，dock 只留「参数 + 动作」——
 * 内嵌卡是对 dock 的视觉污染，且与节点卡重复同一份 `buildPromptNodeCardPreview`。
 * 这组断言锁住「提示词节点带 content 时，dock 里不得再出现结果内容」。
 */
describe('PromptDockPanel 不再内嵌生成结果卡（2026-10-08 下线）', () => {
  const node = createNode({
    prompt: '生成一份商业品牌分镜表',
    content: '【阶段三】分镜表\n- 逐镜拆解（镜号/景别/角度/运镜/时长）',
    promptMode: 'commercial_storyboard',
  })

  it('节点 content 非空时，dock 不渲染结果内容与旧引导文案', () => {
    const wrapper = mountPanel(node)
    const text = wrapper.text()

    expect(text).not.toContain('【阶段三】分镜表')
    expect(text).not.toContain('双击画布节点可打开表格编辑器')
    // 旧卡片标题兜底文案（「生成结果」）也一并消失
    expect(text).not.toContain('生成结果')
  })

  it('去掉结果卡后，dock 的「参数 + 动作」仍在（提示词输入 + 生成按钮）', () => {
    const wrapper = mountPanel(node)

    expect(wrapper.find('textarea, input[type="text"]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'DockGenerateButton' }).exists()).toBe(true)
  })
})
