// 文本节点范式反转（D-A，R1-T6）：长文(>120字) tap → TTS 朗读；短文 tap → 开阅读器。
// 音频/图/视走各自已有主动作（不在此覆盖）。
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

describe('MobileNodeTile text tts', () => {
  it('长文(>120字) tap 触发 TTS 而非 emit open-reader', async () => {
    const speak = stubSpeech()
    const long = '字'.repeat(200)
    const w = mount(MobileNodeTile, { props: { type: 'text', data: { content: long } } })
    await w.trigger('click')
    expect(speak).toHaveBeenCalled()
    expect(w.emitted('open-reader')).toBeFalsy()
  })

  it('短文 tap emit open-reader（开阅读器）且不触发 TTS', async () => {
    const speak = stubSpeech()
    const w = mount(MobileNodeTile, { props: { type: 'text', data: { content: '短' } } })
    await w.trigger('click')
    expect(w.emitted('open-reader')).toHaveLength(1)
    expect(speak).not.toHaveBeenCalled()
  })

  it('阈值边界：恰好 120 字按短文走阅读器', async () => {
    const speak = stubSpeech()
    const w = mount(MobileNodeTile, {
      props: { type: 'text', data: { content: '字'.repeat(TTS_THRESHOLD) } },
    })
    await w.trigger('click')
    expect(w.emitted('open-reader')).toHaveLength(1)
    expect(speak).not.toHaveBeenCalled()
  })
})
