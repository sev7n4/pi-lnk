// 文本节点 tap 行为（规格 §6.2）：无论长短，单击统一打开阅读器（emit open-reader）；
// 朗读不再作为单击默认动作——改由阅读器内置「朗读 / 停止」按钮触发（§6.2「可朗读、可停」）。
// 早先「长文直接 TTS」与书面规格冲突，已移除：本文件断言单击不再触发 TTS。
// jsdom 未实现 SpeechSynthesisUtterance，测试中显式补齐浏览器 API 面。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'

const TTS_THRESHOLD = 120

beforeEach(() => {
  // 补齐浏览器语音合成 API 面（真实浏览器原生存在）
  ;(window as any).SpeechSynthesisUtterance = class {
    text: string
    constructor(text: string) {
      this.text = text
    }
  }
})

function stubSpeech() {
  const speak = vi.fn()
  ;(window as any).speechSynthesis = { speak, cancel: vi.fn(), getVoices: () => [] }
  return speak
}

describe('MobileNodeTile text tap → 阅读器', () => {
  it('长文(>120字) tap 也 emit open-reader，且不触发 TTS', async () => {
    const speak = stubSpeech()
    const long = '字'.repeat(200)
    const w = mount(MobileNodeTile, { props: { type: 'text', data: { content: long } } })
    await w.trigger('click')
    expect(w.emitted('open-reader')).toHaveLength(1)
    expect(speak).not.toHaveBeenCalled()
  })

  it('短文 tap emit open-reader（开阅读器）且不触发 TTS', async () => {
    const speak = stubSpeech()
    const w = mount(MobileNodeTile, { props: { type: 'text', data: { content: '短' } } })
    await w.trigger('click')
    expect(w.emitted('open-reader')).toHaveLength(1)
    expect(speak).not.toHaveBeenCalled()
  })

  it('阈值边界：恰好 120 字同样走阅读器', async () => {
    const speak = stubSpeech()
    const w = mount(MobileNodeTile, {
      props: { type: 'text', data: { content: '字'.repeat(TTS_THRESHOLD) } },
    })
    await w.trigger('click')
    expect(w.emitted('open-reader')).toHaveLength(1)
    expect(speak).not.toHaveBeenCalled()
  })
})
