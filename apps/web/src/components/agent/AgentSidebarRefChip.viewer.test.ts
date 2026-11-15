import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import AgentSidebarRefChip from './AgentSidebarRefChip.vue'
import type { NodeRef } from '@/composables/useNodeRefs'

function makeRef(over: Partial<NodeRef> = {}): NodeRef {
  return {
    refId: 'r1',
    refKey: 'T1',
    mediaType: 'text',
    sourceKind: 'upload',
    label: '粘贴文本 · 6347 字',
    preview: '',
    payload: { text: '文档正文。' + '丙'.repeat(900) },
    ...over,
  }
}

/** useAgentMobileLayout 走 (max-width: 767px) 查询；jsdom 默认没有 matchMedia。 */
function setMobile(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AgentSidebarRefChip：点击 = 查看内容（此前只插 @T1）', () => {
  it('PC：点芯片钉住详情卡，不提前插 @T1；引用由卡内动作完成', async () => {
    const w = mount(AgentSidebarRefChip, {
      props: { refItem: makeRef(), clickable: true },
      attachTo: document.body,
    })
    await w.get('.dock-ref-chip').trigger('click')
    await nextTick()
    expect(document.body.querySelector('[data-testid="ref-preview-card"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="ref-preview-scrim"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="ref-preview-action"]')?.textContent).toContain('引用 @T1')
    expect(w.emitted('mention')).toBeUndefined()

    ;(document.body.querySelector('[data-testid="ref-preview-action"]') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('mention')?.[0]).toEqual(['T1'])
    w.unmount()
  })

  it('历史气泡芯片：也能查看内容，动作是「再次引用 @T1」', async () => {
    const w = mount(AgentSidebarRefChip, {
      props: { refItem: makeRef(), clickable: true, variant: 'history' },
      attachTo: document.body,
    })
    await w.get('.dock-ref-chip').trigger('click')
    await nextTick()
    expect(document.body.querySelector('[data-testid="ref-preview-card"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="ref-preview-action"]')?.textContent).toContain('再次引用 @T1')
    w.unmount()
  })

  it('⛔ 移动端无 hover：点击直接开 sheet，不复用 PC 定位卡', async () => {
    setMobile(true)
    const w = mount(AgentSidebarRefChip, {
      props: { refItem: makeRef(), clickable: true },
      attachTo: document.body,
    })
    await w.get('.dock-ref-chip').trigger('click')
    await nextTick()
    expect(document.body.querySelector('[data-testid="ref-sheet-action"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="ref-preview-card"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="ref-media-text"]')?.textContent).toContain('丙'.repeat(100))
    w.unmount()
  })

  it('移动端 sheet 拇指区动作转发 mention，且关闭后不留浮层', async () => {
    setMobile(true)
    const w = mount(AgentSidebarRefChip, {
      props: { refItem: makeRef(), clickable: true },
      attachTo: document.body,
    })
    await w.get('.dock-ref-chip').trigger('click')
    await nextTick()
    ;(document.body.querySelector('[data-testid="ref-sheet-action"]') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('mention')?.[0]).toEqual(['T1'])
    expect(document.body.querySelector('[data-testid="ref-sheet-action"]')).toBeNull()
    w.unmount()
  })
})
