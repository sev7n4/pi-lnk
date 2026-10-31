/**
 * 移动端 live 钉显 + 状态行退役（2026-10-31 猴子/仙人掌/皮皮虾回合生产实证）。
 *
 * 取证结论（会话 cmvwads7g003up801s82h0zqh 等）：
 * 1. 「第 2 轮全盲」真凶 = 滚动跟随闩锁：用户上滑回看上一轮产出 ⇒ followLatest=false ⇒
 *    本轮实时内容在滚动流底部（折叠线以下）静默增长，仅「●有新消息」小点提示。
 *    第 1 轮恒正常（空白屏闩锁闭合）、第 2 轮起恒盲（上滑回看）。
 * 2. 用户裁决：每次发消息后必须实时看到全量 SSE 对话流；composer 上方的
 *    状态行（"等待你在画布上确认生成 还剩 N 分钟"等）整条退役，只保留 SSE 对话流。
 *
 * 修复结构：
 * - 滚动流内 live 块（AgentExecutionTrace / AgentTurnTimeline）加 !isMobileLayout 门禁（桌面不变）；
 * - 移动端在 agent-system-layer 顶部渲染同款 live 钉显块（进层即继承
 *   「画布视图默认隐藏 + 白名单放行」机制，2026-10-21 根治规格）；
 * - agent-turn-status 状态行（turnStatus / settledDismissed / nowSec ticker / CSS）全删；
 * - 挂起回合（已收到 turn_suspended）主流断链静默——等待卡是单一真相。
 * 源码契约型测试（无挂载）：AgentSideRail.vue 体量过大，挂载型用例见
 * AgentSideRail.waitSettle.test.ts 的取舍说明。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripComments } from './agentSingleScrollOwner.test'

const railPath = resolve(__dirname, 'AgentSideRail.vue')

describe('移动端 live 钉显 + 状态行退役（2026-10-31）', () => {
  const rail = stripComments(readFileSync(railPath, 'utf8'))

  it('① 状态行整条退役：模板/testid/computed/CSS 无残留', () => {
    expect(rail, 'data-testid="turn-status-line" 应删除').not.toMatch(/turn-status-line/)
    expect(rail, 'data-testid="turn-status-dismiss" 应删除').not.toMatch(/turn-status-dismiss/)
    expect(rail, '.agent-turn-status CSS 应删除').not.toMatch(/\.agent-turn-status/)
    expect(rail, 'turnStatus computed 应删除').not.toMatch(/const turnStatus = computed/)
    expect(rail, 'settledDismissed 应删除').not.toMatch(/settledDismissed/)
    expect(rail, 'nowSec ticker 应删除').not.toMatch(/statusTicker/)
    expect(rail, 'turnStatusLine import 应删除').not.toMatch(/turnStatusBar'/)
    expect(rail, 'describeActivityFromTimeline import 应删除').not.toMatch(/activityLine'/)
  })

  it('② 滚动流内 live 块必须挂 !isMobileLayout 门禁（桌面行为不变）', () => {
    expect(
      rail,
      'AgentExecutionTrace v-if 须含 !isMobileLayout',
    ).toMatch(/v-if="!isMobileLayout && liveTrace && !liveTimeline"/)
    expect(
      rail,
      'AgentTurnTimeline v-else-if 须含 !isMobileLayout',
    ).toMatch(/v-else-if="!isMobileLayout && liveTimeline"/)
  })

  it('③ 移动端钉显镜像块存在于 agent-system-layer 内（继承画布视图默认隐藏机制）', () => {
    const iLayer = rail.indexOf('class="agent-system-layer"')
    expect(iLayer, '系统层容器应存在').toBeGreaterThan(-1)
    // 钉显块必须落在系统层之后（系统层之前的 isMobileLayout template 属其他区域）
    const iPin = rail.indexOf('<template v-if="isMobileLayout">', iLayer)
    expect(iPin, '系统层内应有移动端钉显块').toBeGreaterThan(-1)
    // 钉显块内是同一套 live 组件与接线（事件处理不丢）
    // 注：断言拆成属性名/处理器名两段——完整 `attr="handler"` 连写在本仓 vitest
    // 环境下曾出现字节一致却匹配失败的怪异现象（node 直跑同样复现），拆段后稳定。
    const pinBlock = rail.slice(iPin, iPin + 2400)
    expect(pinBlock).toMatch(/AgentTurnTimeline/)
    expect(pinBlock).toMatch(/:parts="liveTimeline\.parts"/)
    expect(pinBlock).toMatch(/@confirm-proposal/)
    expect(pinBlock).toMatch(/onInlineConfirmProposal/)
    expect(pinBlock).toMatch(/@cancel-proposal/)
    expect(pinBlock).toMatch(/onInlineCancelProposal/)
    expect(pinBlock).toMatch(/@ask-submit/)
    expect(pinBlock).toMatch(/onAskSubmit/)
  })

  it('④ 挂起回合断链静默：catch 先判 mainTurnSuspended（turn_suspended 后断链是预期形态）', () => {
    // 锚点用软断链文案本身（源码中唯一），校验其前方的分支顺序
    const iBanner = rail.indexOf('连接已断开；你的确认仍在等待中')
    expect(iBanner, '软断链分支（pendingProposal）应保留').toBeGreaterThan(-1)
    const window = rail.slice(Math.max(0, iBanner - 900), iBanner)
    const iSusp = window.lastIndexOf('if (mainTurnSuspended.value) {')
    expect(
      iSusp,
      '软断链分支之前必须先有挂起静默分支（挂起回合不追加任何断链文案）',
    ).toBeGreaterThan(-1)
  })
})
