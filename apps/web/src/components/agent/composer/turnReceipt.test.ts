import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTurnReceipt } from './turnReceipt'

describe('buildTurnReceipt (P1-4.1)', () => {
  it('builds receipt copy (P1-4.1)', () => {
    const r = buildTurnReceipt({ producedCount: 3 })
    expect(r.summary).toBe('本轮产出 3 张 · 定位到画布')
    expect(r.keepAll).toBe('全部保留')
    expect(r.undoTurn).toBe('撤销本轮')
  })
})

/** P1-4.1 保护项 fs 断言：收据行落在 AgentSideRail 模板（消息流末尾），三串文案各 ≥1 次。 */
const here = dirname(fileURLToPath(import.meta.url))
const sideRail = readFileSync(resolve(here, '../AgentSideRail.vue'), 'utf8')

describe('turn-receipt 模板结构（fs 守卫）', () => {
  it('收据行三串文案（定位到画布/全部保留/撤销本轮）各 ≥1 次', () => {
    for (const s of ['定位到画布', '全部保留', '撤销本轮']) {
      expect(sideRail.includes(s), `AgentSideRail.vue 须包含「${s}」`).toBe(true)
    }
  })

  it('「撤销本轮」按钮在 runtime 工具落地前 disabled（ADR-0010，P1-4.2 只评估不实现）', () => {
    // data-testid 与 disabled 在同一开标签内（中间只允许空白），防止未来误放开
    expect(sideRail).toMatch(/data-testid="turn-receipt-undo"\s+disabled/)
  })
})
