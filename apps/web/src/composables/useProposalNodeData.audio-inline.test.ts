import { describe, expect, it, vi } from 'vitest'
import { resolveProposalNodeData } from './useProposalNodeData'

// 内联参数回执展示（2026-11-03 propose_inline_params）：propose 落节点 data 的
// audioScripts/audioLyrics/...，确认卡据此渲染「台词 N 段 / 歌词 N 字」chip。
// 渲染期纯函数不报价（fetch fail-soft），这里直接 mock 掉网络面。
vi.mock('@/services/pricing-api', () => ({ fetchPriceQuote: vi.fn(() => new Promise(() => {})) }))

const AUDIO_NODE = {
  id: 'audio-1',
  type: 'audio',
  data: {
    title: '民谣音乐',
    prompt: '民谣风格音乐，人声演唱',
    audioModel: 'platform::stepaudio-3-gen-preview',
    audioKind: 'design',
    audioRoles: [{ role: '旁白', voice: 'warm_male' }],
    audioScripts: [{ text: '[主歌1] 清晨的雾' }, { role: '旁白', text: '[副歌] 风吹过麦田' }],
    audioInstruction: '温暖质朴',
  },
}

describe('resolveProposalNodeData 音频内联参数回执（2026-11-03）', () => {
  it('design：audioScripts → 段数', () => {
    const d = resolveProposalNodeData('audio-1', [AUDIO_NODE])!
    expect(d.audioScriptsSegments).toBe(2)
    expect(d.audioLyricsChars).toBeUndefined()
    expect(d.audioCaption).toBeUndefined()
  })

  it('music：audioLyrics → 字数；instrumental 透传', () => {
    const d = resolveProposalNodeData('audio-1', [
      {
        id: 'audio-1',
        type: 'audio',
        data: {
          title: 'BGM',
          prompt: '悬疑氛围',
          audioKind: 'music',
          audioLyrics: '当月光洒满我的心房',
          audioCaption: '悬疑氛围',
          audioInstrumental: true,
        },
      },
    ])!
    expect(d.audioLyricsChars).toBe(9)
    expect(d.audioCaption).toBe('悬疑氛围')
    expect(d.audioInstrumental).toBe(true)
  })

  it('无内联参数的存量节点：全部 undefined（chip 不渲染）', () => {
    const d = resolveProposalNodeData('audio-1', [
      { id: 'audio-1', type: 'audio', data: { title: '配音', prompt: 'x' } },
    ])!
    expect(d.audioScriptsSegments).toBeUndefined()
    expect(d.audioLyricsChars).toBeUndefined()
    expect(d.audioCaption).toBeUndefined()
    expect(d.audioInstrumental).toBeUndefined()
  })
})
