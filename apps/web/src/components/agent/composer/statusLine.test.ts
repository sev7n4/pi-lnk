import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildStatusLine } from './statusLine'

describe('buildStatusLine (P1-3.1)', () => {
  it('fills phase/eta/points when known', () => {
    const m = buildStatusLine({ phase: '排版变体', progressRatio: 0.62, etaSeconds: 39.6, points: 8 })
    expect(m).toEqual({ phase: '排版变体', progress: 0.62, eta: '约 40s', points: '8 积分' })
  })
  it('cost-unknown → null segments (must be hidden, not zeroed)', () => {
    const m = buildStatusLine({ phase: '生成中' })
    expect(m.eta).toBeNull()
    expect(m.points).toBeNull()
  })
})

/** P1-3.2 保护项 fs 断言：停止键（DockGenerateButton 同槽位切换）不得被状态行挤动。 */
const here = dirname(fileURLToPath(import.meta.url))
const sideRail = readFileSync(resolve(here, '../AgentSideRail.vue'), 'utf8')

describe('composer-status-line 模板结构（fs 守卫）', () => {
  it('状态行存在于 AgentSideRail 模板，且位于输入 dock 之上', () => {
    expect(sideRail).toMatch(/class="composer-status-line"/)
    const iStatus = sideRail.indexOf('composer-status-line')
    const iDock = sideRail.indexOf('data-testid="agent-input-dock"')
    expect(iStatus).toBeGreaterThan(-1)
    expect(iDock).toBeGreaterThan(-1)
    expect(iStatus, '状态行模板位置必须在输入 dock 之前（输入区上方）').toBeLessThan(iDock)
  })

  it('DockGenerateButton 在 AgentSideRail 模板中仅出现 1 次（停止槽位不动，P1-3.2）', () => {
    // 根模板的闭标签是最后一个 </template>（中间有大量 <template #slot> 嵌套闭标签）
    const template = sideRail.slice(sideRail.indexOf('<template>'), sideRail.lastIndexOf('</template>'))
    const hits = template.match(/<DockGenerateButton/g) ?? []
    expect(hits.length, 'DockGenerateButton（发送/停止同槽位）只能出现一次').toBe(1)
  })
})
