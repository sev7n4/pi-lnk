import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'

/**
 * SEL-REF 开关语义（R-S9）。
 *
 * Review Focus #4：`SEL_REF_ENABLED` 写成 `true` / `ON` / 空串时必须落 **off**（安全侧），
 * 不得误开——误开会让未验收的指代行为直接进生产。
 */
describe('AgentService selectionRefEnabled（R-S9 开关）', () => {
  const original = process.env.SEL_REF_ENABLED
  let service: AgentService

  beforeEach(() => {
    process.env.PI_RUNTIME_MODE = 'active'
    service = new AgentService(
      { agentMessage: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) } } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  afterEach(() => {
    if (original === undefined) delete process.env.SEL_REF_ENABLED
    else process.env.SEL_REF_ENABLED = original
  })

  it.each([
    ['on', true],
    ['ON', true],
    [' on ', true],
    ['off', false],
    ['true', false],
    ['1', false],
    ['', false],
    ['   ', false],
    [undefined, false],
  ])('SEL_REF_ENABLED=%s ⇒ %s', (value, want) => {
    if (value === undefined) delete process.env.SEL_REF_ENABLED
    else process.env.SEL_REF_ENABLED = value as string
    expect(service.selectionRefEnabled()).toBe(want)
  })

  it('未设置时默认 off（V1 不默认开）', () => {
    delete process.env.SEL_REF_ENABLED
    expect(service.selectionRefEnabled()).toBe(false)
  })
})
