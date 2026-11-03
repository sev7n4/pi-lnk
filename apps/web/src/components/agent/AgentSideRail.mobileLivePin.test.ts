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
    // 2026-11-03 审计改锚（WorkBuddy 同款灰字上线）：退役的是「播报式状态行」
    // （turnStatusLine UI + describeActivityFromTimeline 的 tool-only 旧读数）。
    // 新灰字 = activityLine.turnLiveStatus（时间线全谱派生、与对话流内联卡同源），
    // 是用户裁决的新功能，非状态行复生——故只禁旧读数函数，放行 turnLiveStatus。
    expect(rail, 'describeActivityFromTimeline import 不得复生').not.toMatch(
      /describeActivityFromTimeline/,
    )
    expect(rail, 'turnLiveStatus（新灰字数据源）必须存在').toMatch(/turnLiveStatus/)
  })

  it('②③ 流式归一：钉底/镜像双轨防复生（live 内容必须在消息流内联）', () => {
    // 2026-11-03 流式归一：本用例原锁「滚动流 live 块挂 !isMobileLayout 门禁 + 系统层镜像块」
    // （2026-10-31 第 2 轮全盲的修复形态）。该形态是移动端三象（信封割裂/中间空白/
    // 刷新前后两套渲染）的根源，已整体退役；此处反向锁死，防止钉底/镜像双轨复生：
    // live 消息与历史必须走同一条内联渲染通道（WorkBuddy 同构）。
    expect(
      rail,
      '消息流内 live 抑制（liveTimelineMessageId 互斥）不得复生',
    ).not.toMatch(/liveTimelineMessageId/)
    expect(
      rail,
      '桌面钉底块（!isMobileLayout && liveTrace/liveTimeline）不得复生',
    ).not.toMatch(/!isMobileLayout && live/)
    expect(
      rail,
      '移动端系统层钉显镜像块（<template v-if="isMobileLayout">）不得复生',
    ).not.toContain('<template v-if="isMobileLayout">')
    expect(
      rail,
      '钉底 dense 变体类名不得复生',
    ).not.toMatch(/agent-live-trace/)
    // 内联通道存续校验：消息流内 AgentTurnTimeline 不带任何消息级互斥
    expect(
      rail,
      '内联 AgentTurnTimeline 必须存在且无 live 互斥',
    ).toMatch(/v-if="useTimeline\(msg\)"/)
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
