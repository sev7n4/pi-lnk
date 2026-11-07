/**
 * 旁观分支的**结算分发接线契约**（2026-11-04 结算实时性根治 · 机制 B）。
 *
 * 根因（会话 cmw1oyqww 实测）：终态帧 `done`（pi agent_end 投影）先于 `turn_settled`
 * 到达 /runs/events——结算块含 quote+settle 两次 DB 往返，agent_end 投影恒抢先 ⇒
 * `finishOwnTurnViaObserver` 先把 `ownTurnViaObserver` 翻 false，settle/credit_tx 帧
 * 落入 `onEvent` **旁观分支**。该分支若不分发这两类事件 ⇒ 静默丢弃 ⇒ 摘要
 * 「已结算 -N 积分」与卡「实耗翻转」只在刷新重放后出现。
 *
 * 为什么用静态契约：`AgentSideRail.vue` 是 4000+ 行 SFC，挂载它需要整套 store /
 * fetch / auth 桩（`sharedSubscriptionWiring.test.ts` 同款结论）；本契约要锁的恰是
 * 「终态后到达的计费帧必须被旁观分支分发」这一接线层事实。
 *
 * 第十刀（2026-11-08）将 onEvent 分派器迁入 `useAgentObserver`，以下断言改读该文件。
 *
 * ⚠️ 断言前一律 `stripComments`：注释里的类型名/方法名不得被当成代码命中（假绿）。
 * ⚠️ 定位用 `ownTurnViaObserver.value` 分支**之后**的切片（旁观分支本体），
 *    防止 own-turn 分支（handleEvent 内已有同款分发）掩护旁观分支的缺失。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './useAgentObserver.ts'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const code = stripComments(src)

/**
 * `onEvent` 回调体内「旁观分支」切片：从 `ownTurnViaObserver.value` 判据的
 * return 之后起、到 `onEvent` 收口的 `},` 止（onEvent 是 createFollowUpTailListener
 * 的最后一个字段 ⇒ 收口形态唯一）。切片起点用「旁观模式」锚点注释后第一行 if。
 */
function observerBranchBody(): string {
  const start = code.indexOf("onEvent: (payload) => {")
  expect(start, '必须能定位 onEvent 回调').toBeGreaterThan(-1)
  const ownTurnReturn = code.indexOf('if (isTurnTerminal(payload.type)) finishOwnTurnViaObserver()', start)
  expect(ownTurnReturn, '必须能定位 own-turn 分支收口').toBeGreaterThan(-1)
  const bodyStart = code.indexOf("if (payload.type === 'text_delta')", ownTurnReturn)
  expect(bodyStart, '必须能定位旁观分支首行').toBeGreaterThan(-1)
  // onEvent 收口：切片内首个 `\n  },`（createFollowUpTailListener 字段级闭合一律两空格缩进）
  const bodyEnd = code.indexOf('\n  },', bodyStart)
  expect(bodyEnd, '必须能定位 onEvent 收口').toBeGreaterThan(-1)
  return code.slice(bodyStart, bodyEnd)
}

describe('AgentSideRail 旁观分支结算分发接线（2026-11-04 结算实时性根治）', () => {
  const body = observerBranchBody()

  it('① 旁观分支必须分发 turn_settled → agent.trackTurnSettled', () => {
    expect(body).toContain("payload.type === 'turn_settled'")
    expect(body).toContain('agent.trackTurnSettled(')
  })

  it('② 旁观分支必须分发 credit_tx → agent.trackCreditTx（退款天然回合外，同类丢失面）', () => {
    expect(body).toContain("payload.type === 'credit_tx'")
    expect(body).toContain('agent.trackCreditTx(')
  })

  it('③ 分发必须排在终态收口判据**之前**（else-if 链序：先计费帧后 isTurnTerminal）', () => {
    const settledAt = body.indexOf("payload.type === 'turn_settled'")
    const creditAt = body.indexOf("payload.type === 'credit_tx'")
    const terminalAt = body.indexOf('isTurnTerminal(payload.type)')
    expect(settledAt).toBeGreaterThan(-1)
    expect(creditAt).toBeGreaterThan(-1)
    expect(terminalAt).toBeGreaterThan(-1)
    expect(settledAt, 'turn_settled 判据必须在 isTurnTerminal 之前').toBeLessThan(terminalAt)
    expect(creditAt, 'credit_tx 判据必须在 isTurnTerminal 之前').toBeLessThan(terminalAt)
  })

  it('④ 计费帧不得被跨标签广播（follower 应用语义未定，广播会引入 buffer 重放误标）', () => {
    // 广播扩展是独立决策（新标签加入时 SharedSubscription buffer 会重放广播帧，
    // turn_settled 落到新标签 lastAssistant 有误标面）——本契约钉住「只分发不广播」。
    expect(body).not.toContain("broadcast({ kind: 'turn_settled'")
    expect(body).not.toContain("broadcast({ kind: 'credit_tx'")
  })
})
