import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 多端一致性 P1（计划 2026-11-04 Task 5/6）：ack 化主流的**接线契约**静态守卫。
 *
 * ack 路径的语义由 main-turn-ack.test.ts（纯函数）与 follow-up-tail.main.test.ts
 * （通道分派）在 Node 里锁死；本文件锁「SFC 真的把它们接上了」——接线断掉
 * （重构改名 / 误删分支）时这些断言红，而不是静默回退成「永远走 off 路径」。
 *
 * 第十刀（2026-11-08）将 onEvent 路由 / finishOwnTurnViaObserver / 订阅工厂导入迁入
 * useAgentObserver：本文件 SFC 侧锁定 send 路径编排，composable 侧锁定接线。
 *
 * 变异验证口径（对齐本仓守卫纪律）：删除任一被断言的接线片段 ⇒ 对应断言必须红。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SFC = readFileSync(join(HERE, 'AgentSideRail.vue'), 'utf8')
const OBS = readFileSync(join(HERE, 'useAgentObserver.ts'), 'utf8')
const TAIL = readFileSync(join(HERE, 'follow-up-tail.ts'), 'utf8')

/** 提取 ack 分支源码区间（Content-Type 分派 → POST 体流 reader 之前）。 */
function ackBranch(): string {
  const start = SFC.indexOf('isConversationAckResponse(res)')
  const end = SFC.indexOf('const reader = res.body?.getReader()')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return SFC.slice(start, end)
}

describe('ack 化主流接线契约（P1 Task 5/6 静态守卫）', () => {
  it('sendMessage 有 Content-Type 分派 ack 分支', () => {
    expect(SFC).toContain('isConversationAckResponse(res)')
    expect(SFC).toContain('parseConversationAck(body)')
    expect(SFC).toContain("import { isConversationAckResponse, parseConversationAck } from './main-turn-ack'")
  })

  it('ack 分支：fork 切线程 + 绝对游标 + 开启本端通道消费', () => {
    const branch = ackBranch()
    // fork：thread_forked 是合成事件不进 lane ⇒ 新线程 id 只能从 ack 拿（三件套缺一不可）
    expect(branch).toContain('agentThreadId.value = ack.threadId')
    expect(branch).toContain('persistActiveThreadId(props.sessionId, ack.threadId)')
    expect(branch).toContain('persistForkedThreadId(props.sessionId, ack.threadId)')
    // 绝对游标覆盖（setLastSeq 而非 seedLastSeq —— 后者仅空播种，冻结残值会重放上一轮尾包）
    expect(branch).toContain('observer.followUpTail.setLastSeq(ack.sinceSeq ?? null)')
    expect(branch).not.toContain('followUpTail.seedLastSeq')
    // 本端回合经订阅通道消费 + 重挂连接
    expect(branch).toContain('observer.ownTurnViaObserver.value = true')
    expect(branch).toContain('void observer.listenFollowUpTail()')
    // ack 模式无 POST 流：staleness 监测必须停（否则 30s 后误报「生成服务不可达」）
    expect(branch).toContain('agentStream.stop()')
  })

  it('ack 分支内不得出现 [DONE]（Task 6：on 路径终止语义统一为事件终态）', () => {
    expect(ackBranch()).not.toContain('[DONE]')
  })

  it('onEvent 模式路由：本端回合走 handleEvent 全量语义，终态交 finishOwnTurnViaObserver', () => {
    expect(OBS).toContain("import { createFollowUpTailListener, isTurnTerminal } from './follow-up-tail'")
    expect(OBS).toContain('if (ownTurnViaObserver.value) {')
    expect(OBS).toContain('handleEvent(payload)')
    expect(OBS).toContain('if (isTurnTerminal(payload.type)) finishOwnTurnViaObserver()')
  })

  it('finishOwnTurnViaObserver 存在且幂等（ownTurnViaObserver 闸）+ 权威历史收口', () => {
    expect(OBS).toContain('function finishOwnTurnViaObserver(): void {')
    const fn = OBS.slice(OBS.indexOf('function finishOwnTurnViaObserver'), OBS.indexOf('function finishOwnTurnViaObserver') + 1600)
    expect(fn).toContain('if (!ownTurnViaObserver.value) return')
    expect(fn).toContain('agent.finishStreaming()')
    expect(fn).toContain('reconcileLatestAssistant()')
  })

  it('finally 守卫：ack 模式跳过 POST 流收尾（误跑会把刚起的回合 finishStreaming 掉）', () => {
    expect(SFC).toContain('if (ackMode) return')
    expect(SFC).toContain('let ackMode = false')
    expect(SFC).toContain('ackMode = true')
  })

  it('订阅模块提供全量事件通道 + 绝对游标（依赖侧契约在位）', () => {
    expect(TAIL).toContain('onEvent?: (payload: { type: string; data: unknown }) => void')
    expect(TAIL).toContain('setLastSeq: (seq: number | null) => void')
    expect(TAIL).toContain('export function isTurnTerminal')
  })
})
