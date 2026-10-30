// P1-5 移动端底部裸条（Task 10 + fix-1）：全屏 sheet + 遮罩 + 「看画布」退回按钮退役，
// 三态共条（idle / stacked / queued）。fs-scan 断言配对有效性（否定断言必配肯定断言）。
// fix-1（F2）：距离/位置断言一律在「切出模板区 + 剥离 HTML 注释」后的文本上做 indexOf
// 顺序断言——注释锚（comment anchor）会让位置正则空转成假绿。
// 注：brief 里的 `__dirname` 在 vitest ESM 下不存在，这里用 fileURLToPath(import.meta.url)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

/** 根模板区（首个 <template> 到最后一个 </template>）+ 剥离 HTML 注释（含触发注释锚的历史记录） */
const tpl = sfc
  .slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>'))
  .replace(/<!--[\s\S]*?-->/g, '')

describe('mobile bare bar structure (P1-5)', () => {
  it('full-screen backdrop + view-canvas escape removed (paired with bar presence)', () => {
    // 真实类名已核实：遮罩 = agent-mobile-backdrop；退回按钮 = agent-view-canvas-btn
    expect(sfc).not.toContain('agent-mobile-backdrop')
    expect(sfc).not.toContain('agent-view-canvas-btn')
    expect(tpl).toContain('composer-bare-bar')
  })
  it('idle bar: ＋ inside the bar (order: bar surface before its ＋ control), hint present', () => {
    // 存在性配对（防空集假绿）+ 顺序断言（条表面在先、条内 ＋ 在后）
    expect(tpl).toContain('composer-bare-bar')
    expect(tpl).toContain('aria-label="更多"')
    // A1（2026-10-22）：裸条提示位改为「轮换当前相的短金句」——不再写死。
    // 真意图不变的两条不变式：① 提示位仍存在 ② 条上不得承诺已下线的语音能力。
    // ⚠️ 判据按「行为」写、不按「常量名」写：常量名是可重构的实现细节，锁它会在改实现时假红。
    expect(tpl).toContain('{{ mobileBarIdleHint }}')
    expect(sfc).not.toContain('按住说话')
    // 轮换而非写死：取值来自 BARE_HINT_POOL，且空池兜底是「点按输入」（不是语音文案）
    expect(sfc).toContain('BARE_HINT_POOL[currentUtterancePhase.value]')
    expect(sfc).toContain("return '点按输入'")
    expect(tpl.indexOf('composer-bare-bar')).toBeLessThan(tpl.indexOf('aria-label="更多"'))
  })
  it('status line & interject options live ABOVE the bar (system layer)', () => {
    // 2026-10-31：长条 composer-status-line 已下线，流式 running 态改由 turn-status-line
    // （系统层，位于 composer-bare-bar 之前）统一承载。判据同步改为 turn-status-line。
    expect(tpl).toContain('data-testid="turn-status-line"')
    expect(tpl).toContain('composer-bare-bar')
    expect(tpl.indexOf('data-testid="turn-status-line"')).toBeLessThan(tpl.indexOf('composer-bare-bar'))
  })
  it('history popover retired（ADR-0015 单对话 + 2026-10-27 三页顶栏重构 T5）', () => {
    // 有效性配对：popover 原地渲染的形态与向上展开规则都必须**整体退役**；
    // 历史入口由多对话 UI 退役收敛（「1 项目 = 1 对话」，无历史可列）
    expect(tpl).not.toContain('historyOpen')
    expect(tpl).not.toContain('neo-popover absolute right-0 top-full')
    // 移动端作用域翻转规则一并删除（不留死样式）
    const rule = sfc.match(
      /\.agent-panel-mobile-dock \.agent-panel-header \.neo-popover\s*\{[^}]*\}/,
    )
    expect(rule, '移动端历史 popover 规则应已随功能退役删除').toBeNull()
  })
  it('pure module contract: barShape routes the three bar shapes', () => {
    // 有效性断言：mobileBarLayout 的 barShape 被组件消费（防空集假绿——类名存在但没接线）；
    // barShape 调用点在 script（computed），故断言对象是 sfc 而非 tpl
    expect(sfc).toContain("from './composer/mobileBarLayout'")
    expect(sfc).toContain('barShape({ hasRefs:')
  })
  it('input row renders UNCONDITIONALLY — v-else must not pair with the refs strip (2026-10-21 regression)', () => {
    // #532 下线语音时删除了 `<template v-if="holdActive">` 录音块，input-wrap 上的 v-else
    // 静默改挂到 AgentRefStrip 的 v-if="pendingAttachmentItems.length" 上 ⇒ 有引用 chip 时
    // 输入行（MentionInput textarea）整行不渲染，用户无法输入（画布 ◎ 拾取 / 多选加引用后必现）。
    // 修法 = input-wrap 无条件渲染（空闲态由 .is-idle 的 display:none 隐藏，不靠模板条件）。
    // 否定断言配肯定断言（fs-scan 配对有效性）：裸条存在 + 输入行无条件存在。
    expect(tpl).toContain('composer-bare-bar')
    expect(tpl).toContain('<div class="agent-composer__input-wrap">')
    // 输入行不得再挂在任何 v-if/v-else 链上：v-else 形态一旦回归即失败
    expect(tpl).not.toContain('v-else class="agent-composer__input-wrap"')
    expect(tpl).not.toMatch(/v-if[^>]*class="agent-composer__input-wrap"/)
    // 有效性：引用芯片行确实在模板里（否则上面的配对是空集假绿）
    expect(tpl).toContain('v-if="pendingAttachmentItems.length"')
    // 顺序：AgentRefStrip（芯片行）在前，输入行紧随其后（同贸 agent-composer 容器内）
    expect(tpl.indexOf('v-if="pendingAttachmentItems.length"')).toBeLessThan(
      tpl.indexOf('<div class="agent-composer__input-wrap">'),
    )
  })
})
