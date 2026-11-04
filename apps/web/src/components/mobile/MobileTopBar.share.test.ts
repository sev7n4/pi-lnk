import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MobileTopBar from './MobileTopBar.vue'

// MobileTopBar 用 <Teleport to="body">，测试需在 document.body 操作
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
async function clickSel(sel: string) {
  const el = q(sel)
  if (!el) throw new Error(`selector not found: ${sel}`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
  await new Promise((r) => setTimeout(r, 0))
}

describe('MobileTopBar 会话级分享入口（Task 6）', () => {
  let wrapper: ReturnType<typeof mount> | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('chat 页签顶栏含「分享会话」按钮，点击 emit share', async () => {
    wrapper = mount(MobileTopBar, { props: { tab: 'chat', projectName: 'P' } })
    await flushPromises()
    const shareBtn = q('[data-testid="mobile-topbar-share"]')
    expect(shareBtn).not.toBeNull()
    expect(shareBtn!.getAttribute('aria-label')).toContain('分享')
    await clickSel('[data-testid="mobile-topbar-share"]')
    expect(wrapper!.emitted('share')).toBeTruthy()
  })

  it('canvas 页签不渲染「分享会话」按钮（仅对话页签）', async () => {
    wrapper = mount(MobileTopBar, { props: { tab: 'canvas', projectName: 'P' } })
    await flushPromises()
    expect(q('[data-testid="mobile-topbar-share"]')).toBeNull()
  })
})
