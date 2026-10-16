import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MentionInput from './MentionInput.vue'

describe('MentionInput', () => {
  it('prevents Escape from closing the parent dock when dismissing mentions', async () => {
    const wrapper = mount(MentionInput, {
      props: {
        modelValue: '@',
        mentions: [{ id: 'ref-1', label: '参考图' }],
      },
    })
    const textarea = wrapper.get('textarea')
    await textarea.trigger('input')

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    textarea.element.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.find('ul').exists()).toBe(false)
  })
})

function pressEnter(wrapper: ReturnType<typeof mount>) {
  const ta = wrapper.get('textarea')
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  ta.element.dispatchEvent(ev)
  return ev
}

describe('MentionInput keyboard contract (P0-1.1)', () => {
  it('desktop: Enter submits when submitOnEnter', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', mentions: [], submitOnEnter: true } })
    const ev = pressEnter(w)
    await w.vm.$nextTick()
    expect(w.emitted('submit')).toHaveLength(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('mobile: Enter inserts newline, never submits (mobileEnterNewline)', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', mentions: [], submitOnEnter: true, mobileEnterNewline: true } })
    const ev = pressEnter(w)
    await w.vm.$nextTick()
    expect(w.emitted('submit')).toBeUndefined()
    expect(ev.defaultPrevented).toBe(false) // 不阻止默认 → textarea 正常换行
  })
})
