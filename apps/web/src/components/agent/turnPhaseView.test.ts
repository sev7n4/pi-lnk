import { describe, expect, it } from 'vitest'
import type { TimelinePart } from './turnTimeline'
import { deriveTurnPhaseView, isTurnFinalized } from './turnPhaseView'

const T = (p: Partial<Extract<TimelinePart, { kind: 'thinking' }>> = {}): TimelinePart => ({
  kind: 'thinking', id: 't1', text: '', status: 'done', startedAt: 100, endedAt: 900, ...p,
})
const Tool = (toolName: string, status = 'done', ms = 800): TimelinePart => ({
  kind: 'tool', id: `k:${toolName}`, toolName, status, ms,
} as TimelinePart)

describe('deriveTurnPhaseView（渲染期派生，零落库）', () => {
  it('空 parts → null（不造阶段）', () => {
    expect(deriveTurnPhaseView([])).toBeNull()
  })

  it('仅 thinking → exploring 进行中，无小结、无耗时', () => {
    const v = deriveTurnPhaseView([T({ status: 'running', endedAt: undefined })])!
    expect(v.stages.map((s) => s.id)).toEqual(['exploring', 'creating', 'wrapping'])
    expect(v.activeIndex).toBe(0)
    expect(v.stages[0]!.status).toBe('running')
    expect(v.stages[0]!.durationLabel).toBeUndefined()
    expect(v.stages[0]!.summary).toBeUndefined()
  })

  it('读工具推进探索、写工具推进创作；前一阶段变 done 且小结只用真实人话', () => {
    const v = deriveTurnPhaseView([
      Tool('get_canvas_summary'), Tool('upsert_media_node'),
    ])!
    expect(v.activeIndex).toBe(1)
    expect(v.stages[0]!.status).toBe('done')
    expect(v.stages[0]!.summary).toContain('感知画布')
    expect(v.stages[0]!.durationLabel).toBe('800ms')
    expect(v.stages[1]!.status).toBe('running')
  })

  it('run_ 前缀与 cancel_generation 与 derivePhase 同分类', () => {
    expect(deriveTurnPhaseView([Tool('run_image')])!.activeIndex).toBe(1)
    expect(deriveTurnPhaseView([Tool('cancel_generation')])!.activeIndex).toBe(2)
  })

  it('等待确认冻结阶段 detail，不自行推进', () => {
    const parts = [
      Tool('get_canvas_summary'),
      { kind: 'proposal', id: 'p1', toolName: 'propose_generation', title: '生成',
        status: 'pending_confirm', startedAt: 1 } as TimelinePart,
    ]
    const v = deriveTurnPhaseView(parts)!
    expect(v.activeIndex).toBe(0)
    expect(v.stages[0]!.detail).toBe('等待你确认（阶段暂不推进）')
  })

  it('taskProgress 的 activeForm 优先成为活跃阶段 detail', () => {
    const v = deriveTurnPhaseView([Tool('upsert_media_node')], {
      items: [{ id: '1', title: '写脚本', activeForm: '正在编写脚本', status: 'running' }],
      finished: false,
    })!
    expect(v.stages[1]!.detail).toContain('正在编写脚本')
  })

  it('耗时字段缺失 ⇒ 不出数字；未知工具不造阶段名', () => {
    const v = deriveTurnPhaseView([
      { kind: 'tool', id: 'k1', toolName: 'brand_new_tool', status: 'done' } as TimelinePart,
      Tool('upsert_media_node'),
    ])!
    expect(v.stages[0]!.durationLabel).toBeUndefined()
    expect(v.stages[0]!.summary).not.toMatch(/undefined|NaN|0\/0/)
    expect(v.stages.map((s) => s.label)).toEqual(['探索中', '创作中', '收尾中'])
  })

  it('thinking-only 的 done 阶段小结 = 思考完成（真实素材非造数）', () => {
    const v = deriveTurnPhaseView([
      T({ status: 'done' }),
      Tool('cancel_generation'),
    ])!
    expect(v.stages[0]!.status).toBe('done')
    expect(v.stages[0]!.summary).toBe('思考完成')
    expect(v.stages[0]!.durationLabel).toBe('800ms')
  })
})

describe('isTurnFinalized', () => {
  it('只有稳定 id notice:turn-summary 为真', () => {
    expect(isTurnFinalized([])).toBe(false)
    expect(isTurnFinalized([Tool('get_canvas_summary')])).toBe(false)
    expect(isTurnFinalized([
      { kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张', tone: 'info' },
    ])).toBe(true)
  })
})
