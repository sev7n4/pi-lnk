import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AgentRefMediaBody from './AgentRefMediaBody.vue'
import type { NodeRef } from '@/composables/useNodeRefs'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentRefMediaBody.vue'), 'utf8')

function makeRef(over: Partial<NodeRef> = {}): NodeRef {
  return {
    refId: 'r1',
    refKey: 'T1',
    mediaType: 'text',
    sourceKind: 'upload',
    label: '粘贴文本',
    preview: '',
    payload: {},
    ...over,
  }
}

const TAIL = 'PIN-TAIL-MARKER-8B31'
const longText = '甲'.repeat(1000) + TAIL

describe('AgentRefMediaBody：四类型唯一渲染器', () => {
  it('⛔ 颜色只用语义类，不得回归深色专用写法（浅色主题正文不可见事故）', () => {
    expect(sfc).not.toContain('rgba(')
    expect(sfc).not.toContain('text-white')
    expect(sfc).not.toMatch(/(?:text|bg|border)-\[#/)
    expect(sfc).toContain('text-fg')
  })

  it('text 速览：显示字数 + 前 600 字预览 + 「展开全文」，不把 1000 字全塞进卡片', () => {
    const w = mount(AgentRefMediaBody, {
      props: { refItem: makeRef({ payload: { text: longText } }) },
    })
    expect(w.get('[data-testid="ref-media-meta"]').text()).toContain(`${[...longText].length} 字`)
    const shown = w.get('[data-testid="ref-media-text"]').text()
    expect(shown.endsWith('…')).toBe(true)
    expect(shown).not.toContain(TAIL)
    expect(w.find('[data-testid="ref-media-expand"]').exists()).toBe(true)
    w.unmount()
  })

  it('text 展开：全文可达（含末段唯一标记）+ 复制全文入口', () => {
    const w = mount(AgentRefMediaBody, {
      props: { refItem: makeRef({ payload: { text: longText } }), expanded: true },
    })
    expect(w.get('[data-testid="ref-media-text"]').text()).toContain(TAIL)
    expect(w.get('[data-testid="ref-media-copy"]').text()).toBe('复制全文')
    w.unmount()
  })

  it('text 点「展开全文」发出 expand（外壳据此钉住卡片）', async () => {
    const w = mount(AgentRefMediaBody, {
      props: { refItem: makeRef({ payload: { text: longText } }) },
    })
    await w.get('[data-testid="ref-media-expand"]').trigger('click')
    expect(w.emitted('expand')).toHaveLength(1)
    w.unmount()
  })

  it('text 空内容：明确显示（空文本），不是一片黑', () => {
    const w = mount(AgentRefMediaBody, { props: { refItem: makeRef() } })
    expect(w.get('[data-testid="ref-media-empty"]').text()).toBe('（空文本）')
    w.unmount()
  })

  it('image：速览出缩略图 + 查看大图；展开出大图', async () => {
    const refItem = makeRef({
      refKey: 'I1',
      mediaType: 'image',
      label: 'a.png',
      payload: { url: 'https://x/a.png' },
    })
    const w = mount(AgentRefMediaBody, { props: { refItem } })
    expect(w.get('[data-testid="ref-media-image"]').attributes('src')).toBe('https://x/a.png')
    await w.get('[data-testid="ref-media-expand"]').trigger('click')
    expect(w.emitted('expand')).toHaveLength(1)
    w.unmount()

    const full = mount(AgentRefMediaBody, { props: { refItem, expanded: true } })
    expect(full.find('[data-testid="ref-media-expand"]').exists()).toBe(false)
    expect(full.get('[data-testid="ref-media-image"]').classes()).toContain('max-h-[70vh]')
    full.unmount()
  })

  it('video：速览只有静音封面 + 播放按钮；展开才是可操作 controls', () => {
    const refItem = makeRef({
      refKey: 'V1',
      mediaType: 'video',
      label: 'demo.mp4',
      payload: { url: 'https://x/demo.mp4' },
    })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const small = mount(AgentRefMediaBody, { props: { refItem } })
    expect(small.get('[data-testid="ref-media-video-poster"]').attributes('src')).toBe('https://x/demo.mp4')
    expect(small.find('[data-testid="ref-media-video"]').exists()).toBe(false)
    small.unmount()

    const full = mount(AgentRefMediaBody, { props: { refItem, expanded: true } })
    expect(full.get('[data-testid="ref-media-video"]').attributes('controls')).toBeDefined()
    // 退出即停：卸载时 pause 被调用，媒体不许在后台继续播
    full.unmount()
    expect(pause).toHaveBeenCalled()
    play.mockRestore()
    pause.mockRestore()
  })

  it('audio：速览给播放按钮；展开给原生 controls', () => {
    const refItem = makeRef({
      refKey: 'A1',
      mediaType: 'audio',
      label: 'voice.mp3',
      payload: { url: 'https://x/voice.mp3' },
    })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const small = mount(AgentRefMediaBody, { props: { refItem } })
    expect(small.get('[data-testid="ref-media-expand"]').text()).toContain('播放音频')
    small.unmount()

    const full = mount(AgentRefMediaBody, { props: { refItem, expanded: true } })
    expect(full.get('[data-testid="ref-media-audio"]').attributes('controls')).toBeDefined()
    full.unmount()
    vi.restoreAllMocks()
  })

  it('无 url 的媒体：明确兜底文案（不是空白卡）', () => {
    const w = mount(AgentRefMediaBody, {
      props: { refItem: makeRef({ mediaType: 'image', refKey: 'I1' }) },
    })
    expect(w.get('[data-testid="ref-media-empty"]').text()).toBe('暂无可预览内容')
    w.unmount()
  })
})
