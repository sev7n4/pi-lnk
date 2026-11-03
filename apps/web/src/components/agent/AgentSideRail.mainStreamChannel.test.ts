/**
 * P1 Task 5/6 静态契约（多端一致性 · 统一传输）：主流传输交换接线。
 *
 * 断言前一律 stripComments：注释里写有事件名与故障成因，全文扫描会假绿
 * （AgentSideRail.*.test.ts 家族同款纪律）。
 *
 * 钉住六件事：
 *  ① sendMessage 按 Content-Type 分流（application/json ⇒ ack 路径）；
 *  ② ack 解析 + GET /runs/events 订阅带 lastEventId=sinceSeq 游标锚点；
 *  ③ on 路径事件进**主流 reducer** handleEvent（与 POST 流同一事件面）；
 *  ④ fork 由 ack.forkedThreadId 经 handleEvent('thread_forked') 接线（复用切线程实现）；
 *  ⑤ Task 4 三闸门折义文案接线（idempotent_hit / not_idle / session_forbidden）；
 *  ⑥ Task 6：on 路径无 [DONE] 依赖（终止 = 回合收束帧）；off 路径 [DONE] 保留。
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

/** 从 sendMessage 起点截到函数收尾（下一个 `async function` 或 watch 之前的最大块）。 */
function sendMessageBlock(): string {
  const start = code.indexOf('async function sendMessage(')
  expect(start, '必须能定位 sendMessage').toBeGreaterThan(0)
  const next = code.indexOf('async function', start + 10)
  return code.slice(start, next)
}

describe('AgentSideRail 主流统一传输接线（P1 Task 5）', () => {
  const block = sendMessageBlock()

  it('① Content-Type 分流：application/json ⇒ ack 路径（flag on 由服务端裁决，前端免旗标）', () => {
    expect(block).toContain("contentType.includes('application/json')")
  })

  it('② ack 解析 + 权威通道订阅带游标锚点 lastEventId=<sinceSeq>', () => {
    expect(block).toContain('parseConversationAck(')
    expect(block).toContain('consumeMainTurnStream(')
    expect(block).toContain('lastEventId=')
    expect(block).toContain('ack.sinceSeq')
  })

  it('③ on 路径事件进主流 reducer handleEvent（与 POST 流同一事件面，非旁观影子路径）', () => {
    expect(block).toMatch(/onEvent: \(event\) => \{[\s\S]*?agentStream\.touch\(\)[\s\S]*?handleEvent\(event\)/)
  })

  it('④ fork：ack.forkedThreadId 经 handleEvent thread_forked 接线（切线程 + fork key 持久化一处实现）', () => {
    expect(block).toContain("type: 'thread_forked'")
    expect(block).toContain('ack.forkedThreadId')
  })

  it('⑤ Task 4 三闸门折义接线：accepted=false 按 reason 给同义文案且不触发订阅', () => {
    expect(block).toContain("ack.reason === 'idempotent_hit'")
    expect(block).toContain("ack.reason === 'not_idle'")
    expect(block).toContain("ack.reason === 'session_forbidden'")
    expect(block).toContain('上一轮仍在处理中，请稍候…')
    expect(block).toContain('检测到相同内容已在生成 / 已生成，已为你复用，无需重复发送。')
  })

  it('⑥ Task 6：on 路径（ack 分支内）不得出现 [DONE] 依赖——终止 = 回合收束帧', () => {
    const ackBranchStart = block.indexOf("contentType.includes('application/json')")
    const ackBranch = block.slice(ackBranchStart)
    // ack 分支自 data 帧解析点起到 return 为止不得读 [DONE]
    const consumeStart = ackBranch.indexOf('consumeMainTurnStream(')
    const consumeBlock = ackBranch.slice(consumeStart, ackBranch.indexOf('}\n', consumeStart))
    expect(consumeBlock, 'on 路径禁止 [DONE] 依赖').not.toContain('[DONE]')
  })

  it('⑦ off 路径保留：POST 响应体流 + [DONE] 原样存在（flag off 行为逐字节不变）', () => {
    expect(block).toContain("line === 'data: [DONE]'")
  })

  it('⑧ 纯模块导入存在（main-turn-channel：解析 + 消费循环不许内联第二套解析器）', () => {
    expect(code).toContain("from './main-turn-channel'")
  })
})
