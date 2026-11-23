import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const rail = () => readFileSync('src/components/agent/AgentSideRail.vue', 'utf8')
const timeline = () => readFileSync('src/components/agent/AgentTurnTimeline.vue', 'utf8')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('AgentSideRail —— B 形态接线守卫（清单流内化、composer 卡/灰字退役）', () => {
  it('composer 区任务卡与灰字渲染各 0 次；活跃轮 task-progress 接线仍在', () => {
    const src = stripComments(rail())
    expect(src).not.toMatch(/AgentTaskProgressCard/)
    expect(src).not.toMatch(/data-testid="turn-live-status"/)
    expect(src).not.toMatch(/showTaskCardAtComposer/)
    // 活跃轮接线保留；turnLiveStatus 派生函数在 timeline 侧保留（当前态单源）
    expect(src).toMatch(/:task-progress="/)
    expect(stripComments(timeline())).toMatch(/turnLiveStatus/)
  })

  it('活跃轮 task-progress 只在 isLiveTurnMessage 门禁内传入', () => {
    const src = stripComments(rail())
    const m = src.match(/:task-progress="([^"]+)"/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('isLiveTurnMessage')
  })

  it('旧三阶段方案不得复活（源码级）', () => {
    const timeline = stripComments(readFileSync('src/components/agent/AgentTurnTimeline.vue', 'utf8'))
    expect(timeline).not.toMatch(/turnPhaseView|turn-phase-strip|PHASE_INDEX_LABELS|deriveTurnPhaseView/)
    expect(timeline).toMatch(/turn-current-state|turn-task-checklist/)
  })
})
