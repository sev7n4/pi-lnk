import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import NodeRenderer from '@/components/canvas/NodeRenderer.vue'

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
 * R4-T1：提议内容上瓦片（D1）。
 *
 * ⭐ 用户的原始设计意图：「提示词直接在节点瓦片上，省去了点击的二次动作」。
 *
 * 取证事实：
 * - PC 真正显示提议内容的不是 `ProposeConfirmOverlay`（它只有「待确认」标签 + 三个按钮，
 *   props 只有 id + data.status），而是**节点体内的 `NodePendingPrompt`**。
 * - 提议的 prompt / 模型 / 比例**早于 propose 就写进了 node.data**
 *   （建节点时写 prompt + imageAspect + videoSettings；`propose_generation` 只把
 *   status 打成 pending_confirm）⇒ **数据已在节点上，只是移动端没渲染**。
 *
 * ⇒ 本任务复用 `NodePendingPrompt`（零新判据），并补一行移动端特有的参数摘要
 *   （移动端无常驻 dock，PC 靠参数面板承载模型/比例/分辨率）。
 */
describe('R4-T1 提议内容上瓦片', () => {
  beforeEach(() => setMobile(true))
  afterEach(() => vi.restoreAllMocks())

  function mountTile(data: Record<string, unknown>) {
    const w = mount(NodeRenderer, { props: { id: 'n1', type: 'image', data } })
    return w
  }

  it('pending_confirm 态 → 瓦片上直接显示提示词正文（不必点开任何东西）', () => {
    const w = mountTile({ status: 'pending_confirm', prompt: '一只猫在雨中奔跑' })
    expect(w.find('[data-testid="node-pending-prompt-text"]').exists()).toBe(true)
    expect(w.text()).toContain('一只猫在雨中奔跑')
    w.unmount()
  })

  it('pending_confirm 态 → 显示参数摘要（模型 · 比例 · 分辨率）', () => {
    const w = mountTile({
      status: 'pending_confirm',
      prompt: 'p',
      imageModel: 'seedream-4',
      imageAspect: '16:9',
      imageResolution: '2K',
    })
    const summary = w.find('[data-testid="mobile-node-params"]')
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toContain('16:9')
    expect(summary.text()).toContain('2K')
    w.unmount()
  })

  it('「待确认」标识只出现一次（磁贴角标让位给提议卡自带 chip，不重复）', () => {
    const w = mountTile({ status: 'pending_confirm', prompt: 'p' })
    expect(w.findAll('.mobile-node-badge')).toHaveLength(0)
    expect(w.find('[data-testid="node-pending-prompt-chip"]').exists()).toBe(true)
    w.unmount()
  })

  it('非 pending 态不显示提议内容（正常内容不被提议卡遮挡）', () => {
    const w = mountTile({ status: 'generating', prompt: 'p' })
    expect(w.find('[data-testid="node-pending-prompt-text"]').exists()).toBe(false)
    w.unmount()
  })

  it('pending 但无提示词 → 不渲染提议卡（空内容不占位）', () => {
    const w = mountTile({ status: 'pending_confirm' })
    expect(w.find('[data-testid="node-pending-prompt"]').exists()).toBe(false)
    w.unmount()
  })

  it('已确认态（有内容）→ 仍显示媒体，提议卡不出现', () => {
    const w = mountTile({ status: 'completed', url: 'https://x/a.png', prompt: 'p' })
    expect(w.find('img.mobile-node-media').exists()).toBe(true)
    expect(w.find('[data-testid="node-pending-prompt"]').exists()).toBe(false)
    w.unmount()
  })

  it('不显示 PC 语境的 hint（「可在提示词卡片上「编辑」后确认」——移动端编辑在 sheet）', () => {
    const w = mountTile({ status: 'pending_confirm', prompt: 'p' })
    expect(w.text()).not.toContain('可在提示词卡片上')
    w.unmount()
  })

  it('磁贴 data 类型声明含 prompt / 模型 / 比例字段（类型层不遗漏）', () => {
    expect(TILE).toMatch(/prompt\?: string/)
    expect(TILE).toMatch(/imageModel\?: string/)
    expect(TILE).toMatch(/imageAspect\?: string/)
  })

  it('样式纪律：新增样式只用 --lnk-* 令牌（无裸 hex / rgba）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(TILE)?.[1] ?? ''
    const lines = block
      .split('\n')
      .filter((l) => l.includes('mobile-node-params') || l.includes('mobile-node-pending'))
      .join('\n')
    expect(lines).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(lines).not.toMatch(/rgba?\(/)
  })

  it('§16-④ 长提示词（>80 字）→ 显示「点按查看全文」引导（短提示词不显示）', () => {
    const long = 'a'.repeat(90)
    const wLong = mountTile({ status: 'pending_confirm', prompt: long })
    expect(wLong.find('[data-testid="mobile-node-propose-hint"]').exists()).toBe(true)
    wLong.unmount()
    const wShort = mountTile({ status: 'pending_confirm', prompt: '一只猫' })
    expect(wShort.find('[data-testid="mobile-node-propose-hint"]').exists()).toBe(false)
    wShort.unmount()
  })

  it('§16-④ 引导行是被动提示（磁贴内不挂按钮——tap 手势归页面级单一出处）', () => {
    const src = TILE.replace(/<!--[\s\S]*?-->/g, '')
    const hintTag = /<p[^>]*mobile-node-propose-hint[^>]*>/.exec(src)?.[0] ?? ''
    expect(hintTag, '引导行应为 p 被动提示且带 testid').toContain(
      'data-testid="mobile-node-propose-hint"',
    )
    expect(hintTag).not.toContain('button')
    expect(hintTag).not.toContain('@click')
  })
})
