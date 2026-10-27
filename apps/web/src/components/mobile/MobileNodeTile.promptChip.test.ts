// G1 磁贴提示词分级（规格 §4.7 / §4.7.1，2026-10-27 S1 批次）：
// 有产物态 chips（confirmed/error/改词重生成）；改词重生成 = 旧产物淡化 + 角标 + chips；
// pending 不渲染 chips（全文入口 = §16-④ 点按查看全文，单一入口 Ruling）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'

const SFC_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'MobileNodeTile.vue'),
  'utf-8',
)

function mountTile(props: { type: 'image' | 'video' | 'audio' | 'text'; id?: string; data?: Record<string, unknown> }) {
  return mount(MobileNodeTile, { props, attachTo: document.body })
}

describe('MobileNodeTile 提示词 chips（G1 · §4.7）', () => {
  it('confirmed + 有产物 + 有提示词 → chips 渲染，单击 emit open-prompt-review（不 emit tap）', async () => {
    const w = mountTile({ id: 'n1', type: 'image', data: { url: 'x.png', prompt: '夜色霓虹' } })
    const chip = w.find('[data-testid="mobile-node-prompt-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('提示词')
    await chip.trigger('click')
    expect(w.emitted('open-prompt-review')).toHaveLength(1)
    expect(w.emitted('tap')).toBeFalsy()
    w.unmount()
  })

  it('四类节点统一可达：音频 confirmed + prompt → chips 渲染（§4.7.1 入口①）', () => {
    const w = mountTile({ id: 'n1', type: 'audio', data: { url: 'a.mp3', prompt: '轻快钢琴' } })
    expect(w.find('[data-testid="mobile-node-prompt-chip"]').exists()).toBe(true)
    w.unmount()
  })

  it('有产物但无提示词 → chips 不渲染（缺省不占位）', () => {
    const w = mountTile({ id: 'n1', type: 'image', data: { url: 'x.png' } })
    expect(w.find('[data-testid="mobile-node-prompt-chip"]').exists()).toBe(false)
    w.unmount()
  })

  it('error + 有旧产物 + prompt → chips 渲染（§4.7 表 error 行）', () => {
    const w = mountTile({
      id: 'n1',
      type: 'image',
      data: { url: 'x.png', prompt: '旧词', status: 'error' },
    })
    expect(w.find('[data-testid="mobile-node-prompt-chip"]').exists()).toBe(true)
    w.unmount()
  })

  it('pending + prompt → chips 不渲染（Ruling：全文入口 = §16-④ 点按查看全文）', () => {
    const w = mountTile({
      id: 'n1',
      type: 'image',
      data: { prompt: '夜色霓虹', status: 'pending_confirm' },
    })
    expect(w.find('[data-testid="mobile-node-prompt-chip"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('MobileNodeTile 改词重生成（G1 · §4.7 表第 3 行）', () => {
  const regenData = { url: 'old.png', prompt: '改后的词', status: 'generating' }

  it('generating + 有旧产物 → 「重新生成中」角标渲染（含计时位），旧产物仍渲染（不闪空）', () => {
    const w = mountTile({ id: 'n1', type: 'image', data: { ...regenData } })
    expect(w.find('[data-testid="mobile-node-regen-badge"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-node-regen-badge"]').text()).toContain('重新生成中')
    // 旧产物保留（旧实现「生成中不渲染旧媒体」= 规格明文要避免的闪空）
    expect(w.find('img').exists()).toBe(true)
    w.unmount()
  })

  it('generating + 有旧产物 → chips 可见（看清「在基于什么重生成」）', () => {
    const w = mountTile({ id: 'n1', type: 'image', data: { ...regenData } })
    expect(w.find('[data-testid="mobile-node-prompt-chip"]').exists()).toBe(true)
    w.unmount()
  })

  it('首生成（generating 无旧产物）→ 走骨架轻态，无角标无 chips（不渲染旧媒体）', () => {
    const w = mountTile({ id: 'n1', type: 'image', data: { prompt: '首词', status: 'generating' } })
    expect(w.find('.mobile-node-generating').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-node-regen-badge"]').exists()).toBe(false)
    expect(w.find('[data-testid="mobile-node-prompt-chip"]').exists()).toBe(false)
    expect(w.find('img').exists()).toBe(false)
    w.unmount()
  })

  it('淡化：generating 态下媒体/波形/文本 opacity 0.4（静态源契约——jsdom 不注入 scoped CSS）', () => {
    expect(SFC_SOURCE).toContain("opacity: 0.4")
    expect(SFC_SOURCE).toContain("[data-state='generating'] .mobile-node-media")
    expect(SFC_SOURCE).toContain("[data-state='generating'] .mobile-node-text")
  })

  it('文本节点改词重生成（有旧正文）→ 角标 + 旧正文保留 + chips', () => {
    const w = mountTile({
      id: 'n1',
      type: 'text',
      data: { content: '旧正文', prompt: '新词', status: 'generating' },
    })
    expect(w.find('[data-testid="mobile-node-regen-badge"]').exists()).toBe(true)
    expect(w.find('.mobile-node-text').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-node-prompt-chip"]').exists()).toBe(true)
    w.unmount()
  })
})
