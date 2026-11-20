// 思考种子接线守卫（AD3）：AgentSideRail 必须在改档写种子、切模型查表种入，
// 且 key 必须归一（经 useThinkingByModel → catalogModelKeyFromValue），运行时仍单值。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('thinking seed wiring in AgentSideRail', () => {
  it('imports useThinkingByModel and destructures seedFor/saveSeed', () => {
    expect(sfc).toContain("import { useThinkingByModel } from '@/composables/useThinkingByModel'")
    expect(sfc).toMatch(/useThinkingByModel\(\)/)
  })

  it('setPlanningThinkingLevel saves seed on every level change', () => {
    const at = sfc.indexOf('function setPlanningThinkingLevel')
    expect(at).toBeGreaterThan(-1)
    const body = sfc.slice(at, at + 400)
    expect(body).toContain('saveSeed(')
  })

  it('watches planningModel to seed the session-level single value', () => {
    // 必须有一段 watch(planningModel) 调用 seedFor（切模型查表种入）
    const watchAt = sfc.indexOf('watch(\n  planningModel')
    expect(watchAt).toBeGreaterThan(-1)
    const region = sfc.slice(watchAt, watchAt + 600)
    expect(region).toContain('seedFor(')
    expect(region).toContain('setPlanningThinkingLevel(')
  })

  it('seed lookup is capability-gated (不支持 thinking 的模型强制标准)', () => {
    const watchAt = sfc.indexOf('watch(\n  planningModel')
    const region = sfc.slice(watchAt, watchAt + 600)
    expect(region).toContain('showPlanningThinkingControls')
  })
})
