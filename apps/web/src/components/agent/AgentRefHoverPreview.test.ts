import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import AgentRefHoverPreview from './AgentRefHoverPreview.vue'
import type { NodeRef } from '@/composables/useNodeRefs'
import type { AnchorRect } from '@/utils/refPreviewPosition'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentRefHoverPreview.vue'), 'utf8')

const anchor: AnchorRect = { left: 20, top: 20, right: 52, bottom: 52, width: 32, height: 32 }
function makeRef(over: Partial<NodeRef> = {}): NodeRef {
  return {
    refId: 'r1',
    refKey: 'T1',
    mediaType: 'text',
    sourceKind: 'upload',
    label: '粘贴文本 · 6347 字',
    preview: '',
    payload: { text: '正文第一段。\n' + '乙'.repeat(900) },
    ...over,
  }
}
function card() { return document.body.querySelector('[data-testid="ref-preview-card"]') as HTMLElement | null }

afterEach(() => { document.body.innerHTML = '' })

describe('AgentRefHoverPreview：主题语义面 + pinned 详情', () => {
  it('⛔ 浅色主题回归锁：卡片用 bg-surface-overlay，禁止写死深底', () => {
    expect(sfc).toContain('bg-surface-overlay')
    expect(sfc).not.toContain('rgba(')
    expect(sfc).not.toContain('bg-[#')
    expect(sfc).toContain('AgentRefMediaBody')
  })

  it('速览：卡片渲染 + 正文用主题文字色，且内容委托唯一渲染器', () => {
    const w = mount(AgentRefHoverPreview, {
      props: { refItem: makeRef(), anchor },
      attachTo: document.body,
    })
    expect(card()).not.toBeNull()
    expect(card()!.className).toContain('bg-surface-overlay')
    expect(document.body.querySelector('[data-testid="ref-media-text"]')?.textContent).toContain('正文第一段')
    expect(document.body.querySelector('[data-testid="ref-preview-scrim"]')).toBeNull()
    w.unmount()
  })

  it('卡内点「展开全文」⇒ 发 pin（外壳钉住，80ms 不再关）', async () => {
    const w = mount(AgentRefHoverPreview, {
      props: { refItem: makeRef(), anchor },
      attachTo: document.body,
    })
    const btn = document.body.querySelector('[data-testid="ref-media-expand"]') as HTMLElement
    expect(btn).not.toBeNull()
    btn.click()
    await nextTick()
    expect(w.emitted('pin')).toHaveLength(1)
    w.unmount()
  })

  it('pinned：遮罩 / 关闭钮 / 引用动作齐备，X 与 Esc 都能关', async () => {
    const w = mount(AgentRefHoverPreview, {
      props: { refItem: makeRef(), anchor, pinned: true, actionLabel: '引用 @T1' },
      attachTo: document.body,
    })
    expect(document.body.querySelector('[data-testid="ref-preview-scrim"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="ref-preview-action"]')?.textContent).toContain('引用 @T1')
    ;(document.body.querySelector('[data-testid="ref-preview-close"]') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('close')).toHaveLength(1)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })

  it('pinned：正文展开为全文（不截断），引用动作转发给外壳', async () => {
    const w = mount(AgentRefHoverPreview, {
      props: { refItem: makeRef(), anchor, pinned: true, actionLabel: '引用 @T1' },
      attachTo: document.body,
    })
    expect(document.body.querySelector('[data-testid="ref-media-text"]')?.textContent).toContain('乙'.repeat(100))
    expect(document.body.querySelector('[data-testid="ref-media-expand"]')).toBeNull()
    ;(document.body.querySelector('[data-testid="ref-preview-action"]') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('action')).toHaveLength(1)
    w.unmount()
  })
})
