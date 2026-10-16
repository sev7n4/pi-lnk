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

  it('lastTurnReceipt 隐藏条件不得引用 showTaskCard（review round 1 F1）', () => {
    // taskProgress.items 在回合收束时不清空（下次发送/切会话/loadHistory 才清），
    // 发过 task 事件的轮次 showTaskCard 恒为 true ⇒ 用它当门收据永不出现。
    const iStart = sideRail.indexOf('const lastTurnReceipt = computed(')
    expect(iStart).toBeGreaterThan(-1)
    const iEnd = sideRail.indexOf('\n})', iStart)
    const body = sideRail.slice(iStart, iEnd)
    expect(body).toContain('agent.isStreaming')
    expect(body, 'lastTurnReceipt 不得依赖 showTaskCard（收据会被陈旧任务卡永久遮蔽）')
      .not.toContain('showTaskCard')
  })

  it('onReceiptFocusAll 对空可定位集早退（review round 1 F2，防误导 toast）', () => {
    const iFn = sideRail.indexOf('function onReceiptFocusAll')
    const iEnd = sideRail.indexOf('\n}', iFn)
    const body = sideRail.slice(iFn, iEnd)
    expect(body).toMatch(/focusNodeIds\.length\s*===?\s*0/)
  })
})
