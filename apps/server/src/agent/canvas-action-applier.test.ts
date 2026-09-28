import 'reflect-metadata'
import { applyCanvasActions } from '@lnkpi/agent'
import type { CanvasAction, CanvasActionApplier, CanvasData } from '@lnkpi/shared'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { defaultCanvasActionApplier } from './canvas-action-applier'

/** 最小构造：只关心第 6 个（applier）参数，其余按现有测试惯例传桩。 */
function createService(applier?: CanvasActionApplier) {
  return new AgentService(
    {} as never,
    { create: vi.fn() } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
    undefined,
    applier,
  )
}

/** 私有 getter 只读验证（不触发真实落地逻辑）。 */
const applierOf = (svc: AgentService): CanvasActionApplier =>
  (svc as unknown as { applier: CanvasActionApplier }).applier

describe('画布动作落地 seam（两产品线拆分 path A）', () => {
  const base: CanvasData = { nodes: [], edges: [] }
  const actions: CanvasAction[] = [{ type: 'add_node', payload: { id: 'n1', nodeType: 'audio' } }]

  it('默认实现与 @lnkpi/agent 的 applyCanvasActions 行为一致（抽象未改变行为）', () => {
    expect(defaultCanvasActionApplier.apply(base, actions)).toEqual(applyCanvasActions(base, actions))
  })

  it('未注入时回退默认实现', () => {
    expect(applierOf(createService())).toBe(defaultCanvasActionApplier)
  })

  it('注入的实现被优先使用（将来换归属只改 DI，不动调用点）', () => {
    const fake: CanvasActionApplier = { apply: vi.fn((d: CanvasData) => d) }
    expect(applierOf(createService(fake))).toBe(fake)
  })
})
