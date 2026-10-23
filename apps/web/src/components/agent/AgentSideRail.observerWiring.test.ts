/**
 * 会话级订阅的**接线契约**（multi-device 收尾 P0 · 2026-10-24）。
 *
 * 为什么需要静态契约：`AgentSideRail.vue` 是 3000 行的 SFC，挂载它需要整套
 * store / fetch / auth 桩，代价远高于收益（Task 5 的既有结论）。但「什么时候订阅」
 * 恰恰是本次修复的全部内容——不锁住它，下次有人把 `listenFollowUpTail()` 挪回
 * 「turn 收尾之后」，多端实时同步会**静默消失**（功能还在、代码还跑、就是看不见）。
 *
 * 生产实证（为什么要锁）：25 次 `/api/agent/runs/events` 订阅全部 0 字节，
 * 因为订阅入口只在 `sendMessage` 的收尾分支里 —— 旁观端压根不订阅。
 *
 * ⚠️ 断言前一律 `stripComments`：本仓把迁移说明写进注释，
 * 全文扫描会让注释里的函数名被当成代码命中（假绿）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/** 剥注释后的源码（所有断言都基于它）。 */
const code = stripComments(src)

/** `createFollowUpTailListener({ ... })` 实参块。 */
const factoryBlock = code.match(/createFollowUpTailListener\(\{[\s\S]*?\n\}\)/)?.[0] ?? ''

describe('AgentSideRail 会话级订阅接线（multi-device 收尾 P0）', () => {
  it('① 挂载即订阅：onMounted 里必须挂上（不得只在 turn 收尾后挂）', () => {
    const blocks = [...code.matchAll(/onMounted\(\(\) => \{[\s\S]*?\n\}\)/g)].map((m) => m[0])
    expect(blocks.length, '必须能定位 onMounted 块').toBeGreaterThan(0)
    expect(
      blocks.some((b) => b.includes('listenFollowUpTail()')),
      '打开会话就要订阅：另一端在跑的那轮，本端不发消息也必须能收到（多端实时同步的前提）',
    ).toBe(true)
  })

  it('② 本端主流起飞前必须让位（旁听与主流同订阅一个会话 ⇒ 否则双倍文本）', () => {
    const iStart = code.indexOf('agentStream.start()')
    expect(iStart, '必须能定位主流起点').toBeGreaterThan(0)
    const before = code.slice(Math.max(0, iStart - 400), iStart)
    expect(before, '主流起飞前必须结束旁观轮').toContain('releaseObserverTurn()')
    expect(before, '主流起飞前必须掐掉常驻订阅').toContain('followUpTail.abort()')
  })

  it('③ 常驻订阅：不得显式传 maxRounds（默认无穷，有上限 = 第 N 次之后本端又聋了）', () => {
    expect(factoryBlock, '必须能定位订阅工厂实参').toContain('createFollowUpTailListener')
    expect(factoryBlock).not.toContain('maxRounds')
  })

  it('④ 会话 / 线程切换后必须重挂（订阅 URL 携带 threadId）', () => {
    const watchIdxs = [...code.matchAll(/\bwatch\(/g)].map((m) => m.index ?? -1)
    const ok = watchIdxs.some((i) => {
      if (i < 0) return false
      const w = code.slice(i, i + 700)
      return (
        w.includes('props.sessionId')
        && w.includes('agentThreadId')
        && w.includes('listenFollowUpTail()')
        && w.includes('followUpTail.abort()')
      )
    })
    expect(ok, '线程变了旧流就在听错的对象，必须重挂').toBe(true)
  })

  it('⑤ 旁观轮必须有收束：onTurnEnd 接线 + 以服务端权威历史纠正一次（不做终态轮询）', () => {
    expect(factoryBlock, '收束回调必须接线，否则旁观气泡永远转圈').toContain('onTurnEnd')
    expect(
      code,
      '旁观收尾直接拉权威历史（传 0 跳过 5s×N 的终态轮询：那一轮已在另一端跑完）',
    ).toContain('reconcileLatestAssistant(0)')
  })

  it('⑥ 未登录不订阅（没 token 只会拿到 401，还会连带一轮无意义的退避重连）', () => {
    expect(code, '订阅前必须校验 token').toContain('hasAuthToken()')
    expect(code, 'token 守卫必须落在订阅入口（挂载 / 切会话 / 可见性恢复全覆盖）').toMatch(
      /function listenFollowUpTail\(\)[\s\S]{0,200}hasAuthToken\(\)/,
    )
  })
})
