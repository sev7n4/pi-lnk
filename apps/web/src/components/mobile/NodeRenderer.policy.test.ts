import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import NodeRenderer from '@/components/canvas/NodeRenderer.vue'
import MobileNodeTile from './MobileNodeTile.vue'
import {
  MOBILE_NODE_OPEN_VIEWER_KEY,
  MOBILE_NODE_OPEN_EDITOR_KEY,
} from '@/composables/canvasNodeActions'

const HERE = dirname(fileURLToPath(import.meta.url))
const NR = readFileSync(join(HERE, '..', 'canvas', 'NodeRenderer.vue'), 'utf8')
const TILE = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf8')
const ACTIONS = readFileSync(join(HERE, '..', '..', 'composables', 'canvasNodeActions.ts'), 'utf8')

/**
 * 空节点 tap 路由（2026-10-23 真机走查 R2-T2 → 2026-10-25 规格 §5.1 D1/D3 修订）。
 *
 * R2-T2 走查反馈——点空白节点会进入**空白全屏**（音频除外）。
 * 根因：`NodeRenderer.onTileOpen` 无条件 `openViewer(...)`，而 viewer 的 img/video 均 `v-if="url"`
 * ⇒ 空节点 tap 得到一片空白。
 *
 * ⚠️ D1/D3 修订（2026-10-25 规格 §5.1 · 铁律 P1「单击 = 查看」）：
 * R2 的解法（空节点 → 编辑 sheet）已被**推翻**——单击不进编辑器。
 * 空 / 生成中 / 失败无旧产物 ⇒ 无 op + 轻提示（引导长按）；管理与撰写只走长按。
 * 有产物（pending / confirmed / error+旧产物）⇒ 单击仍进查看器（§6.2 查看矩阵）。
 *
 * ⭐ 守卫强度：**行为级**——挂载 NodeRenderer、注入 mock，断言「哪个回调被调用」
 *   + 「磁贴是否给出轻提示」。
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

describe('移动端 tap 路由（状态门控 · D1/D3）', () => {
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
    async function tapNode(type: 'image' | 'video' | 'audio' | 'text', data: Record<string, unknown>) {
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
      await w.find('.mobile-node-tile').trigger('click')
      await w.vm.$nextTick()
      const hint = w.find('[data-testid="mobile-node-hint"]')
      const hintText = hint.exists() ? hint.text() : ''
      w.unmount()
      return { openViewer, openEditor, hintText }
    }

    it('空图片节点 → 无 op + 轻提示（既不开 viewer 也不开 editor）', async () => {
      const { openViewer, openEditor, hintText } = await tapNode('image', { url: '' })
      expect(openViewer).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
      expect(hintText).toContain('长按编辑')
    })

    it('空视频节点 → 无 op + 轻提示', async () => {
      const { openViewer, openEditor, hintText } = await tapNode('video', { url: '' })
      expect(openViewer).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
      expect(hintText).toContain('长按编辑')
    })

    it('空文本节点 → 无 op + 轻提示（引导「长按撰写」）', async () => {
      const { openViewer, openEditor, hintText } = await tapNode('text', { content: '' })
      expect(openViewer).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
      expect(hintText).toContain('长按撰写')
    })

    it('生成中的节点 → 无 op + 轻提示（壳层状态栏已给「耗时 · 取消」，不重复入口）', async () => {
      const { openViewer, openEditor } = await tapNode('image', { url: '', status: 'generating' })
      expect(openViewer).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('失败且无旧产物 → 无 op + 轻提示', async () => {
      const { openViewer, openEditor } = await tapNode('image', { url: '', status: 'error' })
      expect(openViewer).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('失败但有旧产物 → 仍走 viewer（用户此时最想看旧产物）', async () => {
      const { openViewer, openEditor } = await tapNode('image', {
        url: 'https://x/a.png',
        status: 'error',
      })
      expect(openViewer).toHaveBeenCalledTimes(1)
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('待确认节点 → 仍走 viewer（确认前必须能先看）', async () => {
      const { openViewer, openEditor } = await tapNode('image', { status: 'pending_confirm' })
      expect(openViewer).toHaveBeenCalledTimes(1)
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('有 url 的图片节点 → 仍走 viewer（R1 语义不回归）', async () => {
      const { openViewer, openEditor } = await tapNode('image', { url: 'https://x/a.png' })
      expect(openViewer).toHaveBeenCalledTimes(1)
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('有内容的文本节点 → 仍走 viewer（R1 语义不回归）', async () => {
      const { openViewer, openEditor } = await tapNode('text', { content: '你好' })
      expect(openViewer).toHaveBeenCalledTimes(1)
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('有 url 的音频节点 → 走 viewer（2026-10-27 D2 修订：波形查看器；原「内联不进 viewer」拍板已被真机走查推翻）', async () => {
      const { openViewer, openEditor } = await tapNode('audio', { url: 'https://x/a.mp3' })
      expect(openViewer).toHaveBeenCalledTimes(1)
      expect(openViewer).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'audio', data: { url: 'https://x/a.mp3' } }),
      )
      expect(openEditor).not.toHaveBeenCalled()
    })

    it('空音频节点 → 无 op + 轻提示（无源可播，不进编辑器）', async () => {
      const { openViewer, openEditor, hintText } = await tapNode('audio', { url: '' })
      expect(openViewer).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
      expect(hintText).toContain('长按编辑')
    })

    it('引用 resolveMobileNodeTapIntent（策略单一真源，不各写一遍）', () => {
      expect(NR).toContain('resolveMobileNodeTapIntent')
    })
  })

  describe('MobileNodeTile：空态 CTA 与轻提示文案改为「长按」', () => {
    it('空瓦片 CTA 是「长按编辑 / 长按撰写」（不再是「点按生成 / 点按撰写」）', () => {
      const w = mount(MobileNodeTile, { props: { type: 'image', data: { url: '' } as never } })
      expect(w.find('.mobile-node-empty-cta').text()).toBe('长按编辑')
      const wt = mount(MobileNodeTile, { props: { type: 'text', data: { content: '' } as never } })
      expect(wt.find('.mobile-node-text-cta').text()).toBe('长按撰写')
    })

    it('轻提示是磁贴内的 transient 提示（1.5s 自动消失，带 data-testid）', () => {
      expect(TILE).toContain('mobile-node-hint')
      expect(TILE).toContain('data-testid="mobile-node-hint"')
      // 1.5s 自动消失（毫秒常量）
      expect(TILE).toMatch(/HINT_DURATION_MS\s*=\s*1500/)
    })
  })
})
