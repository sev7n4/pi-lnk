import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const editor = {
  previewTarget: null as null | Record<string, unknown>,
  closeMediaPreview: vi.fn(),
  openImageEditor: vi.fn(),
}
vi.mock('@/stores/canvasEditor', () => ({
  useCanvasEditorStore: () => editor,
}))
vi.mock('@/composables/useMediaInspector', () => ({ useMediaInspector: () => ({ openInspector: vi.fn() }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }) }))

import MediaPreviewOverlay from './MediaPreviewOverlay.vue'

/**
 * 组件用 Teleport 挂到 body：任一用例中途失败未 unmount，残留 DOM 会污染下一个用例
 * （实测：残留的图片灯箱让「视频不给 1:1」误判为存在 1:1 按钮）。每个用例后清空。
 */
afterEach(() => {
  document.body.innerHTML = ''
})

function previewButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
}

describe('MediaPreviewOverlay hub actions', () => {
  it('hides edit/save without nodeId', async () => {
    editor.previewTarget = { url: 'https://cdn/a.png', kind: 'image' }
    const wrapper = mount(MediaPreviewOverlay, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).not.toContain('编辑')
    expect(document.body.textContent).not.toContain('存入资产库')
    wrapper.unmount()
  })

  it('edit button closes preview and opens editor with nodeId', async () => {
    editor.previewTarget = { url: 'https://cdn/a.png', kind: 'image', nodeId: 'n1' }
    const wrapper = mount(MediaPreviewOverlay, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    const editBtn = previewButtons().find((b) => (b.textContent ?? '').trim() === '编辑')
    expect(editBtn).toBeTruthy()
    editBtn!.click()
    expect(editor.closeMediaPreview).toHaveBeenCalled()
    expect(editor.openImageEditor).toHaveBeenCalledWith({ nodeId: 'n1', url: 'https://cdn/a.png' })
    wrapper.unmount()
  })
})

/**
 * 灯箱微调（2026-10-08）：默认「适应窗口」，可切「1:1 原始尺寸」——
 * 看抠图边缘 / 文字细节时不被缩放糊掉；图片双击同样可切。
 */
describe('MediaPreviewOverlay 原始尺寸切换', () => {
  function mediaEl(): HTMLElement {
    const el = document.body.querySelector('.preview-media')
    expect(el, '找不到媒体主体').toBeTruthy()
    return el as HTMLElement
  }

  function maskEl(): HTMLElement {
    const el = document.body.querySelector('.media-preview-mask')
    expect(el, '找不到遮罩层').toBeTruthy()
    return el as HTMLElement
  }

  /** Teleport 到 body 后 `wrapper.find` 找不到节点，只能在 document 上派发事件。 */
  async function dblclickMedia(wrapper: ReturnType<typeof mount>): Promise<void> {
    mediaEl().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wrapper.vm.$nextTick()
  }

  it('默认适应窗口，点 1:1 后媒体与遮罩都进入 is-actual，再点回适应', async () => {
    editor.previewTarget = { url: 'https://cdn/a.png', kind: 'image', nodeId: 'n1' }
    const wrapper = mount(MediaPreviewOverlay, { attachTo: document.body })
    await wrapper.vm.$nextTick()

    expect(mediaEl().classList.contains('is-actual')).toBe(false)

    const toActual = previewButtons().find((b) => (b.textContent ?? '').trim() === '1:1')
    expect(toActual, '缺少 1:1 按钮').toBeTruthy()
    toActual!.click()
    await wrapper.vm.$nextTick()

    expect(mediaEl().classList.contains('is-actual')).toBe(true)
    expect(maskEl().classList.contains('is-actual')).toBe(true)

    const backToFit = previewButtons().find((b) => (b.textContent ?? '').trim() === '适应')
    expect(backToFit, '切到 1:1 后按钮文案应变成「适应」').toBeTruthy()
    backToFit!.click()
    await wrapper.vm.$nextTick()

    expect(mediaEl().classList.contains('is-actual')).toBe(false)
    wrapper.unmount()
  })

  it('双击图片也能来回切换原始尺寸', async () => {
    editor.previewTarget = { url: 'https://cdn/a.png', kind: 'image' }
    const wrapper = mount(MediaPreviewOverlay, { attachTo: document.body })
    await wrapper.vm.$nextTick()

    await dblclickMedia(wrapper)
    expect(mediaEl().classList.contains('is-actual')).toBe(true)

    await dblclickMedia(wrapper)
    expect(mediaEl().classList.contains('is-actual')).toBe(false)
    wrapper.unmount()
  })

  it('视频不给 1:1 切换（只对图片有意义）', async () => {
    editor.previewTarget = { url: 'https://cdn/v.mp4', kind: 'video', nodeId: 'n1' }
    const wrapper = mount(MediaPreviewOverlay, { attachTo: document.body })
    await wrapper.vm.$nextTick()

    const labels = previewButtons().map((b) => (b.textContent ?? '').trim())
    expect(labels).not.toContain('1:1')
    wrapper.unmount()
  })
})
