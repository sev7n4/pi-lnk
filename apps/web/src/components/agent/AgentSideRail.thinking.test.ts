// P1-2.1 裁决 fix round 1：B 级思考 chip 仅非默认档常驻；
// 默认档经 C 抽屉「思考档位」入口（参数预设槽位）进入同一三档 popover。
// 注：fs 扫描断言（与 canvasRefEntry.test.ts 同套路）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

// 模板区域切分：C 抽屉（＋）与 params 行（B chip 所在）按既有锚点类名切分
const drawerStart = sfc.indexOf('agent-attach-menu')
const paramsStart = sfc.indexOf('agent-dock-params')
const primaryStart = sfc.indexOf('agent-dock-primary')
const drawerRegion = drawerStart >= 0 && paramsStart > drawerStart ? sfc.slice(drawerStart, paramsStart) : ''
const chipRegion = paramsStart >= 0 && primaryStart > paramsStart ? sfc.slice(paramsStart, primaryStart) : ''

describe('thinking level B/C layering (P1-2.1 ruling fix)', () => {
  it('B chip is gated on non-default level', () => {
    expect(sfc).toContain(`v-if="currentThinkingLevel !== '标准'"`)
  })

  it('C drawer contains the 思考档位 entry', () => {
    expect(drawerRegion).toContain('思考档位')
  })

  it('drawer entry and chip share the same popover open handler', () => {
    expect(chipRegion).toContain('toggleThinkingMenu')
    expect(drawerRegion).toContain('toggleThinkingMenu')
  })
})
