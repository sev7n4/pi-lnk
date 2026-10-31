/**
 * turn_suspended 契约（2026-10-31 皮皮虾回合生产实证防回归）。
 *
 * 事故：`cmvvaw8ar000moe01fdolrugb` 的 propose_generation 回合，主流在阻塞等待边界
 * 被 pi lane 挂起收尾（nginx 实测 201 完成、用时恰等于等待起点）。此前客户端对
 * 「正常挂起」零显式信号，故障面四处：
 *   ① 等待条随 isStreaming 熄灭（turnStatus 只认 isStreaming）；
 *   ② finally 的「本轮无文本回复」兜底把挂起回合当空回合补噪音文案；
 *   ③ 续跑文本（answered 后模型续写）经旁听流到达时误开**影子气泡**（重复第二条）；
 *   ④ turn_end 收口从不触发权威对账 ⇒ 自动取消后 proposal 卡永久 pending，
 *      用户迟到点击全部 201 no-op、「点了没反应」。
 *
 * 服务端配套：streamFromPiRuntime 在「waiting{waiting} 且无权威收束」时流末尾下发
 * `turn_suspended`（见 agent.service.turn-identity.test.ts D3）。本文件钉住消费侧：
 * 挂起态的置位 / 复位 / 呈现豁免 / 旁听采纳四件事，任一被改回即红灯。
 *
 * ⚠️ 断言前一律 stripComments：注释里写有事故成因与事件名，全文扫描会假绿。
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

function fnBlock(signature: string): string {
  const re = new RegExp(`${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\\}`)
  return code.match(re)?.[0] ?? ''
}

describe('AgentSideRail turn_suspended 挂起契约（挂起 ≠ 断链）', () => {
  it('handleEvent 必须消费 turn_suspended：置位挂起态、不得追加任何断链/失败文案', () => {
    // case 体在 switch 内层，收口是缩进 `    }`（fnBlock 的行首 `}` 匹配不到）⇒ 用专用正则。
    const block = code.match(/case 'turn_suspended': \{[\s\S]*?\n    \}/)?.[0] ?? ''
    expect(block, '必须能定位 turn_suspended case（事件契约消费侧）').toContain(
      'mainTurnSuspended.value = true',
    )
    expect(
      block,
      '挂起不是断链：case 体内禁止 appendText（安抚文案只属于真网络异常的 catch 分支）',
    ).not.toContain('appendText')
  })

  it('liveTimeline 的 active 基座必须并入挂起态（钉底时间线整个等待期存活；2026-10-31 状态行退役后本处是唯一基座）', () => {
    const block = fnBlock('const liveTimeline = computed(() =>')
    expect(block, 'active 必须是 isStreaming ∥ mainTurnSuspended 并集').toContain(
      'agent.isStreaming || mainTurnSuspended.value',
    )
  })

  it('finally 的「本轮无文本回复」兜底必须豁免挂起回合（挂起回合等模型续写，不是空回合）', () => {
    // 该文案前 ~600 字符窗口内必须出现挂起门禁（finally 块内同型语句多处，
    // fnBlock 的首个匹配可能落在别的函数）。
    const anchor = code.indexOf('（本轮无文本回复')
    expect(anchor, '必须能定位空回合兜底文案').toBeGreaterThan(-1)
    const window = code.slice(Math.max(0, anchor - 600), anchor)
    expect(window, '空回合兜底必须带 !mainTurnSuspended.value 门禁').toContain(
      '!mainTurnSuspended.value',
    )
  })

  it('applyTextDelta 旁听采纳：挂起回合的续跑文本必须采纳原 assistant 消息（禁止影子气泡）', () => {
    const block = fnBlock('function applyTextDelta(text: string)')
    expect(block, '必须能定位 applyTextDelta').toContain('observerTurnActive.value = true')
    const suspendedIdx = block.indexOf('mainTurnSuspended.value')
    const shadowIdx = block.indexOf('agent.startAssistantMessage()')
    expect(suspendedIdx, 'applyTextDelta 内必须出现挂起采纳分支').toBeGreaterThan(-1)
    expect(
      suspendedIdx < shadowIdx,
      '挂起采纳分支必须在影子气泡创建之前（挂起时短路，不开影子）',
    ).toBe(true)
  })

  it('生命周期：applyTurnEnd / 新一轮发送 / run_cancelled 三处必须复位挂起态', () => {
    const end = fnBlock('function applyTurnEnd()')
    expect(end, 'turn_end 收口必须复位挂起态').toContain('mainTurnSuspended.value = false')
    const cancelled = fnBlock("case 'run_cancelled'")
    expect(cancelled, '用户取消必须复位挂起态').toContain('mainTurnSuspended.value = false')
    // 新一轮发送的复位：mainTurnSuspended 声明区到 sendMessage 之间至少三处 = false
    //（applyTurnEnd / run_cancelled / sendMessage），加上声明共 4 处出现。
    const hits = code.match(/mainTurnSuspended\.value = false/g) ?? []
    expect(hits.length, `复位点应 ≥3 处（实测 ${hits.length}）`).toBeGreaterThanOrEqual(3)
  })
})
