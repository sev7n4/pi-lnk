import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from './agent'

const env = (kind: string, svg: string) => ({
  kind,
  stepper: { current: '', completed: [] },
  body: { svg },
})

describe('setPresentation', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('写入最后一条 assistant 消息的 presentation', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.kind).toBe('svg_card')
  })

  it('Review Focus #3：同轮第二张卡覆盖第一张（最后一张胜出）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="a"/>') as never)
    s.setPresentation(env('svg_card', '<svg id="b"/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.body?.svg).toContain('id="b"')
  })

  it('无 assistant 消息时不抛错（静默忽略）', () => {
    const s = useAgentStore()
    expect(() => s.setPresentation(env('svg_card', '<svg/>') as never)).not.toThrow()
  })

  it('写入不误伤更早的 assistant 消息（只动最后一条）', () => {
    const s = useAgentStore()
    s.addUserMessage('turn 1')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="first"/>') as never)
    s.finishStreaming()
    s.addUserMessage('turn 2')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="second"/>') as never)
    expect(s.messages[1].presentation?.body?.svg).toContain('id="first"')
    expect(s.messages[3].presentation?.body?.svg).toContain('id="second"')
  })
})
