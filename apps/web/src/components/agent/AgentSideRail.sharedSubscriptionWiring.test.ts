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

  it('② ⛔ 开连接只能发生在**唯一判据**里（follower 不得自建连接）', () => {
    // ⭐ 2026-10-26 修订：判定从「散落在各调用点」**收拢到 evaluateConnection()**。
    //   理由：判定散落 ⇒ 条件漂移 ⇒ 同一时刻出现两条连接（生产实测同一 thread 6 条）。
    //   ⇒ 契约从「判据排在 start 之前」升级为「**start 只允许出现在判据里**」。
    const body = bodyOf('evaluateConnection') // 内部已断言「能定位」
    expect(body, '判据必须含 shouldOpenConnection（会话 leader 维度）').toContain('shouldOpenConnection(')
    expect(body, '判据必须含 holdsGlobalSseSlot（跨标签页/跨画布维度）').toContain('holdsGlobalSseSlot()')
    const gateAt = body.indexOf('shouldOpenConnection(')
    const startAt = body.indexOf('followUpTail.start()')
    expect(gateAt, '开连接前必须先判「该不该由我开」').toBeGreaterThan(-1)
    expect(startAt, '必须存在开连接调用').toBeGreaterThan(-1)
    expect(gateAt, '判据必须排在开连接之前').toBeLessThan(startAt)

    // ⛔ 全文件里 **只允许判据内部**出现 start()：其它地方出现 ⇒ 又一处独立判定。
    const allStarts = [...code.matchAll(/followUpTail\.start\(\)/g)].map((m) => m.index)
    expect(allStarts.length, '开连接调用必须唯一（出现多处 ⇒ 又多了一处独立判定）').toBe(1)
    const fnAt = code.indexOf('function evaluateConnection(')
    expect(allStarts[0], '唯一的那次开连接必须在 evaluateConnection 内').toBeGreaterThan(fnAt)
    expect(allStarts[0], '唯一的那次开连接必须在 evaluateConnection 内').toBeLessThan(fnAt + 1200)
  })

  it('②b ⛔ 全局槽位：频道名与 session/thread 无关（否则合并不了）', () => {
    const body = bodyOf('ensureSseSlotSubscription') // 内部已断言「能定位」
    // ⚠️ 只取 channelName 那一行：`bodyOf` 是定长切片，会把**下一个函数**也切进来
    //   （`ensureSharedSubscription` 里就有 `agent-sub:${...}`）⇒ 用整段判会假红。
    const line = body.split('\n').find((l) => l.includes('channelName'))
    expect(line, '全局槽位必须声明 channelName').toBeTruthy()
    expect(line, '全局槽位必须用固定频道名').toContain("'lnkpi:agent-sse-slot'")
    expect(line, '全局槽位频道名不得参数化（否则跨画布合并不了）').not.toMatch(/\$\{/)
  })

  it('②c ⛔ 可见性变化时全局槽位必须让位（隐藏页要交出那条唯一的连接）', () => {
    const body = bodyOf('onFollowUpTailVisibility')
    expect(body, '可见性处理必须把全局槽位一起更新').toContain('sseSlotSubscription?.setVisible(')
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

  it('⑦ 卸载必须退出共享频道与全局槽位（否则别的标签页接不了管）', () => {
    const body = bodyOf('onFollowUpTailVisibility') // 定位用
    expect(body.length).toBeGreaterThan(0)
    expect(code).toContain('sharedSubscription?.stop()')
    expect(code, '必须退出全局槽位').toContain('sseSlotSubscription?.stop()')
  })
})
