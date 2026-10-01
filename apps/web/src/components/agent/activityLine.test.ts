import { describe, expect, it } from 'vitest'
import { describeActivity, describeRuntimeActivity } from '@/components/agent/activityLine'
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

describe('describeRuntimeActivity（决策 8 · runtime activity 人话）', () => {
  it('已登记工具 → 注册表动词', () => {
    expect(describeRuntimeActivity({ toolName: 'upsert_media_node', done: 1 })).toBe('创建节点')
  })

  it('未登记工具 → 回落到「处理中」，绝不吐内部名（决策 5）', () => {
    expect(describeRuntimeActivity({ toolName: 't_probe', done: 1 })).toBe('处理中')
  })

  it('done >= 2 才追加「第 N 步」；done=1 不追加（第 1 步说是废话）', () => {
    expect(describeRuntimeActivity({ toolName: 'web_search', done: 1 })).toBe('联网搜索')
    expect(describeRuntimeActivity({ toolName: 'web_search', done: 2 })).toBe('联网搜索 · 第 2 步')
    expect(describeRuntimeActivity({ toolName: 'web_search', done: 7 })).toBe('联网搜索 · 第 7 步')
  })

  it('无工具名 / null / undefined → null（调用方走 trace 兜底）', () => {
    expect(describeRuntimeActivity({ done: 3 })).toBeNull()
    expect(describeRuntimeActivity(null)).toBeNull()
    expect(describeRuntimeActivity(undefined)).toBeNull()
  })

  it('不渲染任何分母文案（total 在 runtime 侧无源，不能造假进度）', () => {
    const out = describeRuntimeActivity({ toolName: 'arrange_nodes', done: 3 });
    expect(out).toBe('整理布局 · 第 3 步');
    expect(out).not.toMatch(/\//);
  })
})
