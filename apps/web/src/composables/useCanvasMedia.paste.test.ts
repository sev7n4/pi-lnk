import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { setupCanvasMediaHandlers } from './useCanvasMedia'

function pasteEvent(target: EventTarget, types: string[] = ['text/plain']) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    configurable: true,
    value: {
      items: types.map((type) => ({
        type,
        kind: 'string',
        getAsFile: () => new File(['hello'], 'clip.txt', { type }),
      })),
      files: [],
    },
  })
  // dispatch 让 Event.target 由浏览器/jsdom 正确赋值，再手动调用 handler
  target.dispatchEvent(ev)
  return ev as unknown as ClipboardEvent
}

describe('setupCanvasMediaHandlers.onPaste（P0 守卫）', () => {
  it('textarea 目标：不 preventDefault、不建节点（composer 粘贴保持原生）', async () => {
    const onMedia = vi.fn()
    const { onPaste } = setupCanvasMediaHandlers(ref<HTMLElement | null>(null), onMedia)
    const ev = pasteEvent(document.createElement('textarea'))
    await onPaste(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(onMedia).not.toHaveBeenCalled()
  })

  it('画布目标：仍按既有行为 ingest 文本并建节点', async () => {
    const onMedia = vi.fn()
    const { onPaste } = setupCanvasMediaHandlers(ref<HTMLElement | null>(null), onMedia)
    const ev = pasteEvent(document.createElement('div'))
    await onPaste(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onMedia).toHaveBeenCalledTimes(1)
  })
})
