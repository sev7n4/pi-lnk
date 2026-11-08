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
 * 第十刀（2026-11-08）将 applyTextDelta / applyTurnEnd 迁入 `useAgentObserver`：
 * 该两处断言改读 composable；handleEvent / finally / run_cancelled / 基座仍由 SFC 承载。
 *
 * ⚠️ 断言前一律 stripComments：注释里写有事故成因与事件名，全文扫描会假绿。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')
const obs = readFileSync(join(here, './useAgentObserver.ts'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const sfcCode = stripComments(sfc)
const obsCode = stripComments(obs)

function fnBlock(src: string, signature: string): string {
  const re = new RegExp(`${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\\}`)
  return src.match(re)?.[0] ?? ''
}

describe('AgentSideRail turn_suspended 挂起契约（挂起 ≠ 断链）', () => {
  it('handleEvent 必须消费 turn_suspended：置位挂起态、不得追加任何断链/失败文案', () => {
    // case 体在 switch 内层，收口是缩进 `    }`（fnBlock 的行首 `}` 匹配不到）⇒ 用专用正则。
    const block = sfcCode.match(/case 'turn_suspended': \{[\s\S]*?\n    \}/)?.[0] ?? ''
    expect(block, '必须能定位 turn_suspended case（事件契约消费侧）').toContain(
      'mainTurnSuspended.value = true',
    )
    expect(
      block,
      '挂起不是断链：case 体内禁止 appendText（安抚文案只属于真网络异常的 catch 分支）',
    ).not.toContain('appendText')
  })

  it('挂起态必须并入「回合进行中基座」（流式归一后 creditsLineVisible 是唯一基座消费方）', () => {
    // 2026-11-03 流式归一：liveTimeline 钉底退役，等待呈现改由消息流内联 timeeline 承接
    // （渲染不依赖 active 判定，挂起期 proposal/question 卡随消息流持续可见）；
    // 仍依赖「isStreaming ∪ mainTurnSuspended」基座的存续消费方 = 会话积分常驻条显隐。
    // 挂起等待期也在消耗挂账期 ⇒ 基座若丢挂起态，常驻条在等待期熄灭 = 契约回归。
    const block = fnBlock(sfcCode, 'const creditsLineVisible = computed(() =>')
    expect(block, '基座必须是 isStreaming ∪ mainTurnSuspended 并集').toContain(
      'agent.isStreaming || mainTurnSuspended.value',
    )
  })

  it('finally 的「本轮无文本回复」兜底必须豁免挂起回合（挂起回合等模型续写，不是空回合）', () => {
    // 该文案前 ~600 字符窗口内必须出现挂起门禁（finally 块内同型语句多处，
    // fnBlock 的首个匹配可能落在别的函数）。
    const anchor = sfcCode.indexOf('（本轮无文本回复')
    expect(anchor, '必须能定位空回合兜底文案').toBeGreaterThan(-1)
    const window = sfcCode.slice(Math.max(0, anchor - 600), anchor)
    expect(window, '空回合兜底必须带 !mainTurnSuspended.value 门禁').toContain(
      '!mainTurnSuspended.value',
    )
  })

  it('finally 的「本轮无文本回复」兜底必须豁免发言被拒（P0：turnRefusal≠null 时不补误导文案）', () => {
    // 诊断结论：前端「已并入进行中任务」callout（agent.turnRefusal）已承载 steer 并入反馈，
    // 此处若仍补「本轮无文本回复」会与正确 callout 自相矛盾。守卫须落在文案之前。
    const anchor = sfcCode.indexOf('（本轮无文本回复')
    expect(anchor, '必须能定位空回合兜底文案').toBeGreaterThan(-1)
    const window = sfcCode.slice(Math.max(0, anchor - 600), anchor)
    expect(window, '空回合兜底必须带 !agent.turnRefusal 门禁').toContain('!agent.turnRefusal')
  })

  it('applyTextDelta 旁听采纳：挂起回合的续跑文本必须采纳原 assistant 消息（禁止影子气泡）', () => {
    const block = fnBlock(obsCode, 'function applyTextDelta(text: string)')
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
    const end = fnBlock(obsCode, 'function applyTurnEnd()')
    expect(end, 'turn_end 收口必须复位挂起态').toContain('mainTurnSuspended.value = false')
    const cancelled = fnBlock(sfcCode, "case 'run_cancelled'")
    expect(cancelled, '用户取消必须复位挂起态').toContain('mainTurnSuspended.value = false')
    // 新一轮发送的复位：mainTurnSuspended 声明区到 sendMessage 之间至少三处 = false
    //（applyTurnEnd / run_cancelled / sendMessage），加上声明共 4 处出现。
    const sfcHits = sfcCode.match(/mainTurnSuspended\.value = false/g) ?? []
    const obsHits = obsCode.match(/mainTurnSuspended\.value = false/g) ?? []
    const hits = sfcHits.length + obsHits.length
    expect(hits, `复位点应 ≥3 处（实测 ${hits}）`).toBeGreaterThanOrEqual(3)
  })
})
