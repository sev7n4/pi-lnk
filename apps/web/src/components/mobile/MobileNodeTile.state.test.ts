import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import NodeRenderer from '@/components/canvas/NodeRenderer.vue'
import { nodeTypeConfigs } from './nodeTypeConfigs'

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
 * R3-T2 修断链：状态透传 + 徽标表补全。
 *
 * 断链①：`NodeRenderer` 向 `MobileNodeTile` 传的 props 只有 `id / type / data`
 *   （+ `v-bind="attrs"`），**没有 `:status`** ⇒ 磁贴拿不到状态 ⇒
 *   `statusBadge()` 恒返回 null ⇒ 状态徽标当前根本不渲染。
 *
 * 断链②：徽标表只覆盖 2/5 态（image 判 `error` + video 判 `pending`），
 *   且那个 `pending` **不是** `pending_confirm`（桌面用的是后者，ADR-0011）。
 *
 * 修法：徽标改为**统一按五态判**（不再按类型分别判）——四类型一致性由此保证。
 */
describe('R3-T2 状态透传 + 徽标表补全', () => {
  beforeEach(() => setMobile(true))
  afterEach(() => vi.restoreAllMocks())

  describe('断链①：状态必须传到磁贴', () => {
    it('磁贴从 data.status 读状态（不新增平行 prop——桌面组件无 status prop，传过去会 fallthrough 污染 DOM）', () => {
      expect(TILE).toContain('props.data?.status')
    })

    it('行为级：挂载 NodeRenderer（带 status）后磁贴渲染对应徽标', () => {
      const w = mount(NodeRenderer, {
        props: { id: 'n1', type: 'image', data: { url: '', status: 'generating' } },
      })
      // generating → 徽标文案「生成中」
      expect(w.find('.mobile-node-badge').text()).toContain('生成中')
      w.unmount()
    })

    it('行为级：error 状态 → 徽标「失败」', () => {
      const w = mount(NodeRenderer, {
        props: { id: 'n2', type: 'image', data: { url: '', status: 'error' } },
      })
      expect(w.find('.mobile-node-badge').text()).toContain('失败')
      w.unmount()
    })

    it('行为级：pending_confirm 状态 → 徽标「待确认」（不是判 pending 值）', () => {
      const w = mount(NodeRenderer, {
        props: { id: 'n3', type: 'image', data: { url: '', status: 'pending_confirm' } },
      })
      expect(w.find('.mobile-node-badge').text()).toContain('待确认')
      w.unmount()
    })

    it('行为级：fallback_pending 状态 → 徽标「生成中」', () => {
      const w = mount(NodeRenderer, {
        props: { id: 'n4', type: 'image', data: { url: '', status: 'fallback_pending' } },
      })
      expect(w.find('.mobile-node-badge').text()).toContain('生成中')
      w.unmount()
    })

    it('行为级：无状态 → 不渲染徽标', () => {
      const w = mount(NodeRenderer, {
        props: { id: 'n5', type: 'image', data: { url: 'https://x/a.png' } },
      })
      expect(w.find('.mobile-node-badge').exists()).toBe(false)
      w.unmount()
    })
  })

  describe('断链②：徽标表覆盖五态，且四类型一致', () => {
    it('generating → 生成中 / busy', () => {
      expect(nodeTypeConfigs.image.statusBadge('generating')).toEqual({ label: '生成中', tone: 'busy' })
    })

    it('fallback_pending → 生成中 / busy', () => {
      expect(nodeTypeConfigs.image.statusBadge('fallback_pending')).toEqual({ label: '生成中', tone: 'busy' })
    })

    it('pending_confirm → 待确认 / warn', () => {
      expect(nodeTypeConfigs.image.statusBadge('pending_confirm')).toEqual({ label: '待确认', tone: 'warn' })
    })

    it('error / failed → 失败 / error', () => {
      expect(nodeTypeConfigs.image.statusBadge('error')).toEqual({ label: '失败', tone: 'error' })
      expect(nodeTypeConfigs.image.statusBadge('failed')).toEqual({ label: '失败', tone: 'error' })
    })

    it('四类型对同一 status 给出同一徽标（一致性由「按状态判」保证）', () => {
      const types = ['image', 'video', 'audio', 'text'] as const
      for (const t of types) {
        expect(nodeTypeConfigs[t].statusBadge('generating')).toEqual({ label: '生成中', tone: 'busy' })
        expect(nodeTypeConfigs[t].statusBadge('pending_confirm')).toEqual({ label: '待确认', tone: 'warn' })
        expect(nodeTypeConfigs[t].statusBadge('error')).toEqual({ label: '失败', tone: 'error' })
      }
    })

    it('confirmed / 空态不渲染徽标（无多余噪音）', () => {
      for (const t of ['image', 'video', 'audio', 'text'] as const) {
        expect(nodeTypeConfigs[t].statusBadge(undefined)).toBeNull()
        expect(nodeTypeConfigs[t].statusBadge('')).toBeNull()
        expect(nodeTypeConfigs[t].statusBadge('completed')).toBeNull()
        expect(nodeTypeConfigs[t].statusBadge('draft')).toBeNull()
      }
    })
  })

  describe('徽标 tone 的样式齐全（断链③：busy/warn/idle 原本无 CSS）', () => {
    it('busy / warn 两条 tone 都有样式规则', () => {
      expect(TILE).toContain(".mobile-node-badge[data-tone='busy']")
      expect(TILE).toContain(".mobile-node-badge[data-tone='warn']")
    })
  })
})
