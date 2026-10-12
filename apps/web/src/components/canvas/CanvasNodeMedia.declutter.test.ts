import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'

/**
 * 媒体节点 hover 收敛回归锁（2026-10-12 用户口径）。
 *
 * ① 有任务记录（generationRecordId）的节点 hover 只留 ⓘ 详情 —— 下载/存资产库/
 * 替换统一收进详情抽屉（重叠根因：音频 hover 按钮定位父级只包住原生 audio
 * 控件，按钮直接叠在播放条上）；② 无记录的本地上传节点保留原按钮兜底
 * （此时抽屉不可达，删掉 = 功能无处可去）；③ 音频卡片下的 prompt 文本删除
 * （音频是唯一有媒体后仍显示 prompt 的节点，与图片/视频不对齐）。
 */

vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }) }))

vi.mock('@vue-flow/core', () => ({
  Handle: defineComponent({
    name: 'Handle',
    setup: (_, { slots }) => () => h('div', { class: 'mock-handle' }, slots.default?.()),
  }),
  Position: { Top: 'top', Bottom: 'bottom' },
  useNode: () => ({ id: 'node-1' }),
}))

vi.mock('@/components/canvas/NeoBaseNode.vue', () => ({
  default: defineComponent({
    name: 'NeoBaseNode',
    setup: (_, { slots }) => () => h('div', { class: 'mock-base-node' }, slots.default?.()),
  }),
}))

vi.mock('@/components/canvas/NodeTaskCornerActions.vue', () => ({
  default: defineComponent({ name: 'NodeTaskCornerActions', setup: () => () => null }),
}))

vi.mock('@/components/canvas/NodeStatusInfoButton.vue', () => ({
  default: defineComponent({ name: 'NodeStatusInfoButton', setup: () => () => null }),
}))

vi.mock('@/components/media/MediaInfoSummary.vue', () => ({
  default: defineComponent({ name: 'MediaInfoSummary', setup: () => () => null }),
}))

vi.mock('@/composables/useNodeMediaUpload', () => ({
  useNodeMediaUpload: () => ({
    accept: '*/*',
    dragOver: { value: false },
    rejectFlash: { value: false },
    fileInput: { value: null },
    openPicker: vi.fn(),
    onFileChange: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
  }),
}))

vi.mock('@/composables/useNodeMediaInfoFooter', () => ({
  useNodeMediaInfoFooter: () => ({ applyDurationSec: vi.fn() }),
}))

const openInspector = vi.fn()
vi.mock('@/composables/useMediaInspector', () => ({
  useMediaInspector: () => ({ openInspector }),
}))

vi.mock('@/composables/useCanvasMedia', () => ({
  downloadMediaFile: vi.fn(),
  isUpstreamMediaUrl: () => false,
  mediaDownloadName: (url: string) => url,
  UPSTREAM_MEDIA_DOWNLOAD_HINT: 'hint',
}))

vi.mock('@/composables/useAssetLibrary', () => ({
  saveAssetToLibrary: vi.fn(),
}))

vi.mock('@/services/api-base', () => ({
  getApiBaseUrl: () => 'http://localhost:3001',
  resolveMediaUrl: (u: string) => u,
}))

import CanvasNodeAudio from './CanvasNodeAudio.vue'
import CanvasNodeVideo from './CanvasNodeVideo.vue'
import CanvasNodeImage from './CanvasNodeImage.vue'

const baseData = {
  url: '/files/a.mp3',
  status: 'completed',
  prompt: '皮克斯风格蚂蚁短剧音频设计：多角色对话 + 环境音 + BGM',
}

function mountNode(comp: typeof CanvasNodeAudio, data: Record<string, unknown>) {
  return mount(comp, {
    props: { id: 'node-1', data: data as never },
    global: { plugins: [createPinia()] },
  })
}

beforeEach(() => openInspector.mockClear())
afterEach(() => openInspector.mockClear())

describe('CanvasNodeAudio：hover 收敛 + prompt 文本删除', () => {
  it('有效性前置：mock 链路下节点能渲染出音频卡', () => {
    const w = mountNode(CanvasNodeAudio, { ...baseData })
    expect(w.find('.neo-audio-card').exists(), '音频卡必须渲染').toBe(true)
    expect(w.find('audio').exists()).toBe(true)
    w.unmount()
  })

  it('有任务记录 → 替换/下载/存资产库退场，只留 ⓘ', () => {
    const w = mountNode(CanvasNodeAudio, { ...baseData, generationRecordId: 'g1' })
    expect(w.find('.neo-node-replace-btn').exists(), '替换按钮应退场').toBe(false)
    expect(w.find('.neo-node-download-btn').exists(), '下载按钮应退场').toBe(false)
    expect(w.find('.neo-node-save-btn').exists(), '存资产库按钮应退场').toBe(false)
    expect(w.find('.neo-media-inspector-btn').exists(), 'ⓘ 详情必须保留').toBe(true)
    w.unmount()
  })

  it('无任务记录（本地上传）→ 三按钮兜底保留，ⓘ 不出现', () => {
    const w = mountNode(CanvasNodeAudio, { ...baseData })
    expect(w.find('.neo-node-replace-btn').exists()).toBe(true)
    expect(w.find('.neo-node-download-btn').exists()).toBe(true)
    expect(w.find('.neo-node-save-btn').exists()).toBe(true)
    expect(w.find('.neo-media-inspector-btn').exists()).toBe(false)
    w.unmount()
  })

  it('prompt 文本不再渲染在音频卡内', () => {
    const w = mountNode(CanvasNodeAudio, { ...baseData, generationRecordId: 'g1' })
    expect(w.text(), 'prompt 全文不得出现在卡内').not.toContain('多角色对话')
    w.unmount()
  })
})

describe('CanvasNodeVideo：hover 收敛', () => {
  it('有任务记录 → 替换/下载/存资产库退场，中央播放钮与 ⓘ 保留', () => {
    const w = mountNode(CanvasNodeVideo, {
      ...baseData,
      url: '/files/a.mp4',
      generationRecordId: 'g1',
    })
    expect(w.find('.neo-node-replace-btn').exists()).toBe(false)
    expect(w.find('.neo-node-download-btn').exists()).toBe(false)
    expect(w.find('.neo-node-save-btn').exists()).toBe(false)
    expect(w.find('.neo-gen-video-play-btn').exists(), '中央播放钮保留').toBe(true)
    expect(w.find('.neo-media-inspector-btn').exists()).toBe(true)
    w.unmount()
  })

  it('无任务记录 → 三按钮兜底保留', () => {
    const w = mountNode(CanvasNodeVideo, { ...baseData, url: '/files/a.mp4' })
    expect(w.find('.neo-node-replace-btn').exists()).toBe(true)
    expect(w.find('.neo-node-download-btn').exists()).toBe(true)
    expect(w.find('.neo-node-save-btn').exists()).toBe(true)
    w.unmount()
  })
})

describe('CanvasNodeImage：hover 收敛', () => {
  it('有任务记录 → 预览/替换退场（双击预览仍在），只留 ⓘ', () => {
    const w = mountNode(CanvasNodeImage, {
      ...baseData,
      url: '/files/a.png',
      generationRecordId: 'g1',
    })
    expect(w.find('.neo-node-preview-btn').exists(), '预览按钮应退场（双击预览兜底）').toBe(false)
    expect(w.find('.neo-node-replace-btn').exists()).toBe(false)
    expect(w.find('.neo-media-inspector-btn').exists()).toBe(true)
    w.unmount()
  })

  it('无任务记录 → 预览/替换兜底保留', () => {
    const w = mountNode(CanvasNodeImage, { ...baseData, url: '/files/a.png' })
    expect(w.find('.neo-node-preview-btn').exists()).toBe(true)
    expect(w.find('.neo-node-replace-btn').exists()).toBe(true)
    w.unmount()
  })
})
