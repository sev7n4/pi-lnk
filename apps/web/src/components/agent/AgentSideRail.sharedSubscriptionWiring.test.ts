/**
 * 跨标签页共享的**接线契约**（2026-10-26 根治 · 规格 §10）。
 *
 * 为什么用静态契约：`AgentSideRail.vue` 是 3000+ 行的 SFC，挂载它需要整套
 * store / fetch / auth 桩，代价远高于收益（`observerWiring.test.ts` 的既有结论）。
 * 而本契约要锁的恰恰是**"谁可以开连接"**这类只有接线层能表达的事实。
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

const code = stripComments(src)

/** `function listenFollowUpTail()` 的函数体（到下一个顶层 `}` 前）。 */
function bodyOf(name: string): string {
  const i = code.indexOf(`function ${name}(`)
  expect(i, `必须能定位 ${name}`).toBeGreaterThan(-1)
  return code.slice(i, i + 1200)
}

describe('AgentSideRail 跨标签页订阅共享接线（2026-10-26 根治）', () => {
  it('① 必须引入共享层与「谁该开连接」判据', () => {
    expect(code).toContain('createSharedSubscription')
    expect(code).toContain('shouldOpenConnection')
  })

  it('② ⛔ 订阅入口必须先过判据再开连接（follower 不得自建连接）', () => {
    const body = bodyOf('listenFollowUpTail')
    const gateAt = body.indexOf('shouldOpenConnection(')
    const startAt = body.indexOf('followUpTail.start()')
    expect(gateAt, '开连接前必须先判「该不该由我开」').toBeGreaterThan(-1)
    expect(startAt, '必须存在开连接调用').toBeGreaterThan(-1)
    expect(gateAt, '判据必须排在开连接之前').toBeLessThan(startAt)
  })

  it('③ ⛔ 可见性恢复（resume）同样必须过判据（否则 follower resume 会自己开一条）', () => {
    const body = bodyOf('onFollowUpTailVisibility')
    const gateAt = body.indexOf('shouldOpenConnection(')
    const resumeAt = body.indexOf('followUpTail.resume()')
    expect(gateAt, 'resume 前必须先判「该不该由我开」').toBeGreaterThan(-1)
    expect(resumeAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(resumeAt)
  })

  it('④ 直连与共享转发必须走**同一段**语义代码（防两边语义漂移）', () => {
    // 三个语义处理器各至少出现两次：一次在订阅回调，一次在共享 onEvent
    for (const fn of ['applyTextDelta', 'applyCanvasAction', 'applyTurnEnd']) {
      const count = (code.match(new RegExp(`\\b${fn}\\b`, 'g')) ?? []).length
      expect(count, `${fn} 必须被「直连」与「共享转发」共用`).toBeGreaterThanOrEqual(2)
    }
  })

  it('⑤ leader 转发语义事件、follower 只收不转（不得出现第二个事实源）', () => {
    expect(code).toContain("sharedSubscription?.broadcast({ kind: 'text_delta', text })")
    expect(code).toContain("sharedSubscription?.broadcast({ kind: 'canvas_action', data })")
    expect(code).toContain("sharedSubscription?.broadcast({ kind: 'turn_end' })")
  })

  it('⑥ 降级路径：无 BroadcastChannel ⇒ 各自订阅（= 改动前行为）', () => {
    expect(code).toContain('onDegrade')
    const body = bodyOf('ensureSharedSubscription')
    expect(body).toContain('onDegrade')
  })

  it('⑦ 卸载必须退出共享频道（否则别的标签页接不了管）', () => {
    const body = bodyOf('onFollowUpTailVisibility') // 定位用
    expect(body.length).toBeGreaterThan(0)
    expect(code).toContain('sharedSubscription?.stop()')
  })
})
