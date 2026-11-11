/**
 * P1b 快照重同步**接线契约**（事件一等化换读，plan 2026-11-11-sse-event-firstclass-p1b-swap-read.md §1.2）。
 *
 * 为什么需要静态契约（与 observerWiring 同理）：pi-runtime 重放窗口过期（409）后
 * Nest 合成 `snapshot` 帧，前端此前**零消费**——游标不丢（每次重连重付 409→快照成本）、
 * 断连期缺口只能靠用户手动刷新补。本刀把「游标丢弃 + 拉权威历史」钉在三个文件里，
 * 任何一个被挪走/删掉都会**静默**退回「刷新才同步」——功能还在、代码还跑、就是看不见。
 *
 * ⚠️ 断言前一律 stripComments：本仓把迁移说明写进注释，全文扫描会让注释里的
 * 函数名被当成代码命中（假绿）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')
const obs = readFileSync(join(here, './useAgentObserver.ts'), 'utf8')
const tail = readFileSync(join(here, './follow-up-tail.ts'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const sfcCode = stripComments(sfc)
const obsCode = stripComments(obs)
const tailCode = stripComments(tail)

/** `createFollowUpTailListener({ ... })` 实参块（useAgentObserver 内装配点）。 */
const factoryBlock = obsCode.match(/createFollowUpTailListener\(\{[\s\S]*?\n\}\)/)?.[0] ?? ''

describe('P1b 快照重同步接线（409 replay window expired → 游标丢弃 + 权威历史收敛）', () => {
  it('① follow-up-tail：snapshot 帧单点拦截（丢游标 + 通知宿主），位于排他分派之前', () => {
    const intercept = tailCode.match(/if \(payload\.type === 'snapshot'\) \{[\s\S]*?\n\s*\}/)?.[0] ?? ''
    expect(intercept, 'follow-up-tail 必须有 snapshot 单点拦截块').not.toBe('')
    expect(intercept).toContain('lastSeq = null')
    expect(intercept).toContain('deps.onSnapshotResync?.()')
    // 单点性：拦截必须落在 onEvent 排他分派之前（快照不得进入 own-turn/旁观两路）
    const interceptIdx = tailCode.indexOf("if (payload.type === 'snapshot')")
    const dispatchIdx = tailCode.indexOf('if (deps.onEvent)')
    expect(interceptIdx, '拦截块必须存在').toBeGreaterThan(-1)
    expect(dispatchIdx, '排他分派块必须存在').toBeGreaterThan(-1)
    expect(interceptIdx, '拦截必须先于排他分派（own-turn 与旁观共用同一语义）').toBeLessThan(dispatchIdx)
  })

  it('② useAgentObserver：装配 onSnapshotResync 且带三态守卫（isStreaming / observerTurnActive / mainTurnSuspended）', () => {
    expect(factoryBlock, '必须能定位 createFollowUpTailListener 装配块').not.toBe('')
    expect(factoryBlock).toContain('onSnapshotResync')
    const guardBlock = factoryBlock.match(/onSnapshotResync: \(\) => \{[\s\S]*?\n\s*\},/)?.[0] ?? ''
    expect(guardBlock, '必须有守卫块').not.toBe('')
    expect(guardBlock).toContain('agent.isStreaming')
    expect(guardBlock).toContain('observerTurnActive.value')
    expect(guardBlock).toContain('mainTurnSuspended.value')
    expect(guardBlock).toContain('reloadAuthoritativeHistory')
  })

  it('③ AgentSideRail：注入 reloadAuthoritativeHistory = loadHistory（自带单飞与 merge 幂等）', () => {
    const wiring = sfcCode.match(/reloadAuthoritativeHistory: \(\) =>[\s\S]*?\)/)?.[0] ?? ''
    expect(wiring, 'SFC 必须注入 reloadAuthoritativeHistory').not.toBe('')
    expect(wiring).toContain('loadHistory()')
  })
})
