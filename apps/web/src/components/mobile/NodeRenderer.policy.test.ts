import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import NodeRenderer from '@/components/canvas/NodeRenderer.vue'
import {
  MOBILE_NODE_OPEN_VIEWER_KEY,
  MOBILE_NODE_OPEN_EDITOR_KEY,
} from '@/composables/canvasNodeActions'

const HERE = dirname(fileURLToPath(import.meta.url))
const NR = readFileSync(join(HERE, '..', 'canvas', 'NodeRenderer.vue'), 'utf8')
const TILE = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf8')
const ACTIONS = readFileSync(join(HERE, '..', '..', 'composables', 'canvasNodeActions.ts'), 'utf8')

/**
 * 空节点 tap 路由（R2-T2，2026-10-23 真机走查）。
 *
 * 走查反馈——点空白节点会进入**空白全屏**（音频除外）。
 * 根因：`NodeRenderer.onTileOpen` 无条件 `openViewer(...)`，而 viewer 的 img/video 均 `v-if="url"`
 * ⇒ 空节点 tap 得到一片空白。
 *
 * 修法：tap 意图由纯函数 `resolveMobileNodeTapIntent` 单一判定（viewer / editor / inline），
 * 空节点 → editor（打开编辑 sheet，「点击生成/撰写」主动作，D-C 的 empty 行）。
 *
 * ⭐ 守卫强度：**行为级**——挂载 NodeRenderer、注入 mock，断言「哪个回调被调用」。
 *   静态字符串断言（`toContain('openEditor')`）会被 `if (false)` 这类变异骗过
 *   （2026-10-23 实测：变异 1 逃过静态守卫 ⇒ 改为行为级）。
 *   移动端态用 `window.matchMedia` mock（`useAgentMobileLayout` 走 matchMedia，非 DI）。
 */
function setMobile(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: on,
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as any
}

describe('R2-T2 空节点 tap 路由到编辑 sheet', () => {
  beforeEach(() => setMobile(true))
  afterEach(() => vi.restoreAllMocks())

  describe('canvasNodeActions：新增 editor 注入键（与 viewer 键同构）', () => {
    it('定义 MOBILE_NODE_OPEN_EDITOR_KEY 与 MobileNodeOpenEditorFn', () => {
      expect(ACTIONS).toContain('MOBILE_NODE_OPEN_EDITOR_KEY')
      expect(ACTIONS).toContain('MobileNodeOpenEditorFn')
    })
  })

  describe('NodeRenderer：行为级分流', () => {
    /** 挂载 NodeRenderer（移动端），注入 mock 的 viewer/editor 回调，tap 磁贴后看谁被调。 */
    function tapNode(type: 'image' | 'video' | 'audio' | 'text', data: Record<string, unknown>) {
      const openViewer = vi.fn()
      const openEditor = vi.fn()
      const w = mount(NodeRenderer, {
        props: { id: 'n1', type, data },
        global: {
          provide: {
            [MOBILE_NODE_OPEN_VIEWER_KEY as symbol]: openViewer,
            [MOBILE_NODE_OPEN_EDITOR_KEY as symbol]: openEditor,
          },
        },
      })
      w.find('.mobile-node-tile').trigger('click')
      w.unmount()
      return { openViewer, openEditor }
    }

    it('空图片节点 → 走 editor，不走 viewer（真机症状：空白全屏）', () => {
      const { openViewer, openEditor } = tapNode('image', { url: '' })
      expect(openEditor).toHaveBeenCalledTimes(1)
      expect(openViewer).not.toHaveBeenCalled()
    })

    it('空视频节点 → 走 editor', () => {
      const { openViewer, openEditor } = tapNode('video', { url: '' })
      expect(openEditor).toHaveBeenCalledTimes(1)
      expect(openViewer).not.toHaveBeenCalled()
    })

    it('空文本节点 → 走 editor', () => {
      const { openViewer, openEditor } = tapNode('text', { content: '' })
      expect(openEditor).toHaveBeenCalledTimes(1)
      expect(openViewer).not.toHaveBeenCalled()
    })

    it('有 url 的图片节点 → 仍走 viewer（R1 语义不回归）', () => {
      const { openViewer, openEditor } = tapNode('image', { url: 'https://x/a.png' })
      expect(openViewer).toHaveBeenCalledTimes(1)
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('有内容的文本节点 → 仍走 viewer（R1 语义不回归）', () => {
      const { openViewer, openEditor } = tapNode('text', { content: '你好' })
      expect(openViewer).toHaveBeenCalledTimes(1)
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('有 url 的音频节点 → 磁贴内联播放，不触发 viewer/editor', () => {
      const { openViewer, openEditor } = tapNode('audio', { url: 'https://x/a.mp3' })
      expect(openViewer).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('空音频节点 → 走 editor（不再播一个不存在的源）', () => {
      const { openViewer, openEditor } = tapNode('audio', { url: '' })
      expect(openEditor).toHaveBeenCalledTimes(1)
      expect(openViewer).not.toHaveBeenCalled()
    })

    it('引用 resolveMobileNodeTapIntent（策略单一真源，不各写一遍）', () => {
      expect(NR).toContain('resolveMobileNodeTapIntent')
    })
  })

  describe('MobileNodeTile：空音频不再 toggleAudio，改为 emit(tap) 交策略', () => {
    it('音频分支校验 url：有 url 才内联播放', () => {
      expect(TILE).toMatch(/type === 'audio'[\s\S]{0,200}url/)
    })
  })
})
