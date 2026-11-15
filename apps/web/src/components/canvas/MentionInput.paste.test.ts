import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MentionInput from './MentionInput.vue'
import { shouldPromotePasteToTextChip } from '@/composables/pasteTextChip'
import type { PasteTextProbe } from '@/composables/pasteTextChip'

function pasteEvent(text: string, types: string[] = ['text/plain']) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    configurable: true,
    value: {
      getData: (t: string) => (t === 'text/plain' ? text : ''),
      items: types.map((type) => ({ type, kind: 'string', getAsFile: () => null })),
      files: [],
    },
  })
  return ev as unknown as ClipboardEvent
}

const policy = (probe: PasteTextProbe) => shouldPromotePasteToTextChip({
  ...probe,
  pendingCount: 0,
  maxCount: 5,
}).promote

describe('MentionInput paste promotion', () => {
  it('未传 policy 时完全原生：不 preventDefault、不 emit', async () => {
    const w = mount(MentionInput, { props: { modelValue: '', mentions: [] } })
    const ev = pasteEvent('x'.repeat(1200))
    w.get('textarea').element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('paste-text-chip')).toBeUndefined()
  })

  it('policy 命中：preventDefault + emit 完整原文', async () => {
    const text = 'x'.repeat(1200)
    const w = mount(MentionInput, { props: { modelValue: '', mentions: [], pasteTextPolicy: policy } })
    const ev = pasteEvent(text)
    w.get('textarea').element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(true)
    expect(w.emitted('paste-text-chip')?.[0]).toEqual([text])
  })

  it('policy 拒绝短文本：不 preventDefault', async () => {
    const w = mount(MentionInput, { props: { modelValue: '', mentions: [], pasteTextPolicy: policy } })
    const ev = pasteEvent('短句')
    w.get('textarea').element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('paste-text-chip')).toBeUndefined()
  })

  it('有选区时不接管（替换语义保持原生）', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'abcdefgh', mentions: [], pasteTextPolicy: policy } })
    const ta = w.get('textarea').element
    ta.setSelectionRange(2, 6)
    const ev = pasteEvent('x'.repeat(1200))
    ta.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('canUndoPaste 时 ⌘Z 交宿主还原，不吞其他按键', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', mentions: [], canUndoPaste: true } })
    const ta = w.get('textarea').element
    const undo = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
    ta.dispatchEvent(undo)
    await w.vm.$nextTick()
    expect(undo.defaultPrevented).toBe(true)
    expect(w.emitted('undo-paste')).toHaveLength(1)
    const plain = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    ta.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
  })

  it('未开启 canUndoPaste 时 ⌘Z 走 textarea 原生行为', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', mentions: [] } })
    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    w.get('textarea').element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('undo-paste')).toBeUndefined()
  })
})
