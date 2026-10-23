import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import NodeRenderer from '@/components/canvas/NodeRenderer.vue'
import { CANVAS_NODE_RETRY_KEY } from '@/composables/canvasNodeActions'

const HERE = dirname(fileURLToPath(import.meta.url))
const TILE = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf8')

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

/**
 * R3-T3 瓦片状态轻态（D-C 的 generating / pending / error 三行）。
 *
 * ⭐ 关键约束：**不存在生成进度百分比**。全仓取证——节点数据里唯一百分比是
 *   `uploadProgress`（仅上传态）；生成态只有 `generationStartedAt` + 计时
 *   （`nodeTaskChrome.formatElapsed`）。`AgentSideRail.vue:1125` 明确写着
 *   「progress / eta：现链路只有已耗时，无完成比例 / 剩余时长」。
 *   ⇒ 本任务的「进度环」是**不确定态 spinner + 计时**，绝不假造百分比。
 */
describe('R3-T3 瓦片状态轻态', () => {
  beforeEach(() => setMobile(true))
  afterEach(() => vi.restoreAllMocks())

  function mountTile(data: Record<string, unknown>, nodeId = 'n1') {
    const retry = vi.fn()
    const w = mount(NodeRenderer, {
      props: { id: nodeId, type: 'image', data },
      global: { provide: { [CANVAS_NODE_RETRY_KEY as symbol]: retry } },
    })
    return { w, retry }
  }

  describe('generating：骨架 + 不确定态进度环 + 计时', () => {
    it('根元素带 data-state="generating"', () => {
      const { w } = mountTile({ url: '', status: 'generating' })
      expect(w.find('.mobile-node-tile').attributes('data-state')).toBe('generating')
      w.unmount()
    })

    it('渲染不确定态进度环（.mobile-node-generating），不渲染任何百分比文案', () => {
      const { w } = mountTile({ url: '', status: 'generating' })
      expect(w.find('.mobile-node-generating').exists()).toBe(true)
      // ⛔ 不假造进度：产物里不得出现 '%' 进度数字
      expect(w.find('.mobile-node-generating').text()).not.toMatch(/%/)
      w.unmount()
    })

    it('不渲染媒体内容（生成中不该显示旧图）', () => {
      const { w } = mountTile({ url: 'https://x/a.png', status: 'generating' })
      expect(w.find('img.mobile-node-media').exists()).toBe(false)
      w.unmount()
    })
  })

  describe('error：红边 + 44px 重试入口', () => {
    it('根元素带 data-state="error"', () => {
      const { w } = mountTile({ url: '', status: 'error' })
      expect(w.find('.mobile-node-tile').attributes('data-state')).toBe('error')
      w.unmount()
    })

    it('渲染重试按钮且触控目标 ≥ 44px', () => {
      const { w } = mountTile({ url: '', status: 'error' })
      const btn = w.find('.mobile-node-retry')
      expect(btn.exists()).toBe(true)
      const style = readStyleRule(TILE, '.mobile-node-retry')
      expect(style).toMatch(/width:\s*var\(--lnk-touch-target\)/)
      expect(style).toMatch(/height:\s*var\(--lnk-touch-target\)/)
      w.unmount()
    })

    it('点重试 → 走 CANVAS_NODE_RETRY_KEY（复用桌面同一注入键）', async () => {
      const { w, retry } = mountTile({ url: '', status: 'error' })
      await w.find('.mobile-node-retry').trigger('click')
      expect(retry).toHaveBeenCalledWith('n1')
      w.unmount()
    })
  })

  describe('pending：待确认角标（不渲染重试/进度环）', () => {
    it('data-state="pending" 且只有角标，无重试按钮', () => {
      const { w } = mountTile({ url: '', status: 'pending_confirm' })
      expect(w.find('.mobile-node-tile').attributes('data-state')).toBe('pending')
      expect(w.find('.mobile-node-badge').text()).toContain('待确认')
      expect(w.find('.mobile-node-retry').exists()).toBe(false)
      expect(w.find('.mobile-node-generating').exists()).toBe(false)
      w.unmount()
    })
  })

  describe('confirmed / empty：回到常态', () => {
    it('有内容 → data-state="confirmed"，渲染媒体', () => {
      const { w } = mountTile({ url: 'https://x/a.png' })
      expect(w.find('.mobile-node-tile').attributes('data-state')).toBe('confirmed')
      expect(w.find('img.mobile-node-media').exists()).toBe(true)
      w.unmount()
    })

    it('无内容 → data-state="empty"', () => {
      const { w } = mountTile({ url: '' })
      expect(w.find('.mobile-node-tile').attributes('data-state')).toBe('empty')
      w.unmount()
    })
  })

  describe('样式纪律', () => {
    it('error 红边用 --lnk-error 令牌（不裸 hex）', () => {
      const style = readStyleRule(TILE, ".mobile-node-tile[data-state='error']")
      expect(style).toContain('--lnk-error')
      expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/)
      expect(style).not.toMatch(/rgba?\(/)
    })

    it('样式块里没有裸 hex / rgba（新增部分）', () => {
      const block = /<style scoped>([\s\S]*?)<\/style>/.exec(TILE)?.[1] ?? ''
      const stateRules = block
        .split('\n')
        .filter((l) => l.includes('data-state') || l.includes('mobile-node-generating') || l.includes('mobile-node-retry'))
        .join('\n')
      expect(stateRules).not.toMatch(/#[0-9a-fA-F]{3,8}/)
      expect(stateRules).not.toMatch(/rgba?\(/)
    })
  })
})

/** 从 SFC 的 scoped style 里取某条规则的声明体（未命中返回空串）。 */
function readStyleRule(src: string, selector: string): string {
  const block = /<style scoped>([\s\S]*?)<\/style>/.exec(src)?.[1] ?? ''
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`).exec(block)
  return m?.[1] ?? ''
}
