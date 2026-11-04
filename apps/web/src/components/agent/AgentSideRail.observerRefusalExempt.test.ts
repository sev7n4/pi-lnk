/**
 * P3（Review Focus 1）：旁观分支的 turn_not_submitted **豁免**契约。
 *
 * 背景：turn_not_submitted 原本只出现在提交者自己的 POST 流（受众=提交者）。
 * P3 G1 把它桥接进共享 /runs/events 通道后，**观察者也会收到**——运行中的 run
 * 与「第三方消息被拒」无关，据此收尾（applyTurnEnd）会把旁观轮提前掐断、
 * 旁观气泡在 run 仍在跑时提前熄灭。
 *
 * 两层防线（缺一不可）：
 *  ① follow-up-tail.ts 具名回调分支（旁观最小面）——见 follow-up-tail.main.test.ts；
 *  ② AgentSideRail.vue 的 onEvent 旁观分支（ack 化主流后真正的旁观路由）——本文件钉。
 *
 * 为什么是静态契约：AgentSideRail.vue 是 3000+ 行 SFC，挂载需整套 store/fetch/auth 桩
 * （observerWiring.test.ts 既有结论）；分派分支形状恰好是本修复的全部内容。
 *
 * ⚠️ 断言前一律 stripComments（同 observerWiring：注释里的函数名会被当代码命中，假绿）。
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

const code = stripComments(src)

/** `createFollowUpTailListener({ ... })` 实参块（onEvent 分派器所在）。 */
const factoryBlock = code.match(/createFollowUpTailListener\(\{[\s\S]*?\n\}\)/)?.[0] ?? ''

describe('AgentSideRail 旁观分支 turn_not_submitted 豁免（P3 Review Focus 1）', () => {
  it('onEvent 旁观分支：turn_not_submitted 必须在 isTurnTerminal 之前被拦截，且不触发 applyTurnEnd', () => {
    expect(factoryBlock, '必须能定位订阅工厂实参块').toContain('createFollowUpTailListener')
    const iRefusal = factoryBlock.indexOf("payload.type === 'turn_not_submitted'")
    // isTurnTerminal 在 factoryBlock 出现两次（own-turn 收口 + 旁观收尾）——
    // 必须取**拦截点之后**的那次（旁观分支），否则命中 own-turn 内的早出现。
    const iTerminal = factoryBlock.indexOf('isTurnTerminal(payload.type)', Math.max(iRefusal, 0))
    expect(iRefusal, '旁观分支必须有 turn_not_submitted 拦截（第三方拒绝帧不得收尾旁观轮）').toBeGreaterThan(-1)
    expect(iTerminal, '拦截必须落在旁观分支的 isTurnTerminal 终态判定之前（否则先被收尾）').toBeGreaterThan(iRefusal)
    const branch = factoryBlock.slice(iRefusal, iTerminal)
    expect(branch, '拦截分支体内不得调用 applyTurnEnd').not.toContain('applyTurnEnd')
  })

  it('own-turn 路径不受影响：turn_ack / turn_not_submitted 仍走 handleEvent + finishOwnTurnViaObserver（P1 契约不回归）', () => {
    // own-turn 分支（ownTurnViaObserver gate 内）保留全量语义：handleEvent + 终态收口
    const iOwn = code.indexOf('ownTurnViaObserver.value) {')
    expect(iOwn, '必须能定位 own-turn gate').toBeGreaterThan(-1)
    const ownBlock = code.slice(iOwn, iOwn + 600)
    expect(ownBlock).toContain('handleEvent(payload)')
    expect(ownBlock).toContain('finishOwnTurnViaObserver()')
  })
})
