import { describe, expect, it } from 'vitest'
import { describeActivity } from '@/components/agent/activityLine'
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'

function step(over: Partial<ExecutionStep>): ExecutionStep {
  return { id: 's1', kind: 'tool', label: '调用 upsert_media_node', status: 'running', ...over }
}

describe('describeActivity（「正在做什么」人话）', () => {
  it('最新工具步 → 注册表动词', () => {
    expect(describeActivity([step({ kind: 'tool', meta: { toolName: 'upsert_media_node' } })]))
      .toBe('创建节点')
  })
  it('跳过 phase 门控步骤，取最新真实动作', () => {
    const steps = [
      step({ kind: 'phase', label: '生成门控', status: 'waiting_user' }),
      step({ kind: 'tool', meta: { toolName: 'arrange_nodes' } }),
    ]
    expect(describeActivity(steps)).toBe('整理布局')
  })
  it('thinking 步 → 思考中', () => {
    expect(describeActivity([step({ kind: 'thinking', label: '思考中…' })])).toBe('思考中…')
  })
  it('无步骤 / undefined → null（上层降级为「处理中」）', () => {
    expect(describeActivity([])).toBeNull()
    expect(describeActivity(undefined)).toBeNull()
  })
})
