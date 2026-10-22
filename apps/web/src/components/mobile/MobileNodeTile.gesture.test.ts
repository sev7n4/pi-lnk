import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'
import { CANVAS_NODE_OPEN_CONTEXT_MENU_KEY } from '@/composables/canvasNodeActions'

function fireTouch(wrapper: any, type: string) {
  const el = wrapper.element as HTMLElement
  const ev = new Event(type, { bubbles: true }) as any
  ev.touches = [{ clientX: 0, clientY: 0 }]
  el.dispatchEvent(ev)
}

describe('MobileNodeTile gesture', () => {
  it('tap 触发主内容动作', async () => {
    const w = mount(MobileNodeTile, { props: { id: 'n1', type: 'image', data: { url: 'x' } } })
    await w.trigger('click')
    expect(w.emitted('tap')).toHaveLength(1)
  })

  it('长按经 useLongPress 打开上下文菜单（不触发 tap）', async () => {
    const openMenu = vi.fn()
    const w = mount(MobileNodeTile, {
      props: { id: 'n1', type: 'image', data: {} },
      global: { provide: { [CANVAS_NODE_OPEN_CONTEXT_MENU_KEY as any]: openMenu } },
    })
    fireTouch(w, 'touchstart')
    await new Promise((r) => setTimeout(r, 450))
    fireTouch(w, 'touchend')
    expect(openMenu).toHaveBeenCalledWith('n1')
    expect(w.emitted('tap')).toBeFalsy()
  })

  it('audio: 点击播放按钮切换播放态（不冒泡成 tap）', async () => {
    const w = mount(MobileNodeTile, { props: { id: 'n2', type: 'audio', data: { url: 'a.mp3' } } })
    await w.find('.mobile-audio-play').trigger('click')
    expect(w.find('.mobile-audio-play').attributes('aria-label')).toBe('暂停')
    expect(w.emitted('tap')).toBeFalsy()
  })
})
