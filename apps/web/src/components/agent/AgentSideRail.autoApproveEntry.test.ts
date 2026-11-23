// 授权自动生成 · 对话页落点守卫（2026-11-23 UI 迭代 §11：状态胶囊 + 锚定浮层）
//
// ⭐ 背景（用户拍板）：参考 WorkBuddy 权限胶囊的交互骨架——
//   ① 状态归位到 composer 工具行的**胶囊**（图标 + 文字 + 箭头），不做通栏卡片；
//   ② **说明与开关收进锚定浮层**（点开才解释「开了会怎样」，里面直接给开关）。
//   本文件锁住这些不变量（防回退）：
//   ① 通栏文字徽标不得复活；
//   ② 旧的「单击即收回」icon-only 按钮不得复活（收回必须走浮层开关，双向同处）；
//   ③ 入口位置 = composer 工具行，模型 chip 之后、发送键之前；
//   ④ 胶囊外观：关闭态弱化（无底色）、开启态琥珀高亮、零新令牌；
//   ⑤ 移动端走 icon-only + Sheet（裸条三件套纪律）；
//   ⑥ 提议卡与胶囊用**同一枚图形**（跨位置可识别性）；
//   ⑦ 面板说明必须写清作用域（图片与音频 / 视频仍逐次确认）；
//   ⑧ 触感开关**单一来源**（全局共享段），三个落点不得各自复制。
//
// 用源码契约范式（与本目录既有 AgentSideRail.*.test.ts 一致）：
// 组件体量过大，mount 成本高且易被无关依赖拖挂；契约断言更直接、变异必转红。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rail = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const control = readFileSync(join(here, 'AutoApproveControl.vue'), 'utf8')
const panel = readFileSync(join(here, 'AutoApprovePanel.vue'), 'utf8')
const timeline = readFileSync(join(here, 'AgentTurnTimeline.vue'), 'utf8')
const mainCss = readFileSync(join(here, '../../styles/main.css'), 'utf8')
const providerDialog = readFileSync(join(here, '../canvas/ProviderConfigDialog.vue'), 'utf8')
const profilePane = readFileSync(join(here, '../mobile/ProfilePane.vue'), 'utf8')

function rule(src: string, selector: string): string {
  // ⚠️ 只在 <style> 段内搜索：模板注释里出现同名字面量会把 indexOf 带偏
  //    （曾把模板插值 {{ ... }} 当成规则体 —— 断言因此读到无关片段）。
  const styleAt = src.lastIndexOf('<style')
  const scope = styleAt >= 0 ? src.slice(styleAt) : src
  const at = scope.indexOf(selector)
  if (at < 0) return ''
  const open = scope.indexOf('{', at)
  const close = scope.indexOf('}', open)
  return open >= 0 && close > open ? scope.slice(open, close + 1) : ''
}

describe('授权自动生成 · 对话页落点（状态胶囊 + 锚定浮层守卫）', () => {
  it('① 通栏文字徽标已删除，源码不得再出现其类名与 testid', () => {
    expect(rail).not.toContain('agent-auto-approve-line')
    expect(rail).not.toContain('agent-auto-approve-revoke')
    expect(rail).not.toContain('agent-auto-approve-text')
    expect(rail).not.toContain('data-testid="agent-auto-approve-line"')
    expect(rail).not.toContain('data-testid="agent-auto-approve-revoke"')
    // 也不许以别的名字把「已授权自动生成」长文字塞回系统层
    expect(rail).not.toContain('已授权自动生成</span>')
  })

  it('② 旧的「单击即收回」icon-only 按钮不得复活（收回走浮层开关，双向同处）', () => {
    expect(rail).not.toContain('agent-auto-approve-toggle')
    expect(rail).not.toContain('auto-approve-toggle')
    expect(rail).not.toContain('onRevokeAutoApprove')
    expect(control).not.toContain('onRevokeAutoApprove')
  })

  it('③ 入口 = AutoApproveControl，位置在模型 chip 之后、发送键之前', () => {
    expect(rail).toContain('<AutoApproveControl :desktop="isDesktopDock" :read-only="props.readOnly" />')
    const at = rail.indexOf('<AutoApproveControl')
    const paramsAt = rail.indexOf('class="agent-dock-params"')
    const primaryAt = rail.indexOf('class="agent-dock-primary"')
    expect(paramsAt).toBeGreaterThan(-1)
    expect(primaryAt).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(paramsAt)
    expect(at).toBeLessThan(primaryAt)
  })

  it('④ 胶囊关闭态弱化（无底色无边框），开启态琥珀高亮且**无描边**（§12）', () => {
    const base = rule(control, '.auto-approve-chip {')
    expect(base).toContain('background: transparent')
    expect(base).toContain('border: 0.5px solid transparent')
    expect(base).not.toContain('var(--lnk-warning-bg)')
    const on = rule(control, '.auto-approve-chip.is-on')
    expect(on).toContain('color: var(--lnk-warning)')
    expect(on).toContain('background: var(--lnk-warning-bg)')
    // §12 Q1：描边是「按钮」语义，柔底才是「状态」语义 ⇒ 开启态不得再描边
    expect(on).not.toContain('border-color')
    expect(on).not.toContain('var(--lnk-warning-border)')
  })

  it('④ 零新令牌：只用既有 --lnk-* 三件套（禁 --neo-* 前缀与裸色值）', () => {
    const base = rule(control, '.auto-approve-chip {')
    expect(base).not.toContain('--neo-')
    expect(base).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(base).not.toMatch(/rgba?\(/)
    // 琥珀三件套之外的 warning 变体不存在 ⇒ 不得引用
    expect(base).not.toContain('var(--lnk-amber')
    expect(base).not.toContain('var(--lnk-caution')
  })

  it('⑤ 移动端与 PC **同一枚胶囊** + 底部 Sheet，裸条顺序规则指向组件根（§12）', () => {
    expect(control).toContain('<MobileSheet')
    // §12：移动端不再有独立的 icon-only 触发器分支（统一为同一枚胶囊）
    expect(control).not.toContain('data-testid="auto-approve-trigger"')
    expect(control).not.toContain('.auto-approve-trigger {')
    // ⭐ 正向断言：胶囊按钮**只有一个**（两端共用），不得再分叉出第二枚触发器
    //    （只查「trigger 消失」不够：分叉成别的 testid 也算回退 ⇒ 本轮变异实测踩到）。
    expect(control.split('class="auto-approve-chip"').length - 1).toBe(1)
    expect(control.split('data-testid="auto-approve-chip"').length - 1).toBe(1)
    expect(control).toContain('data-testid="auto-approve-chip"')
    expect(rail).toContain('.agent-panel-mobile-dock .composer-bare-bar .auto-approve-control')
    const r = rule(rail, '.agent-panel-mobile-dock .composer-bare-bar .auto-approve-control')
    expect(r).toContain('order: 2')
    // 窄屏让位：模型 chip 链式放开 min-width:0（§12 实测 320px 靠截断让位）
    // ⚠️ 断言要落到**规则体**（min-width:0 真的存在），不能只断言选择器字符串
    //    （改名后选择器仍是子串 ⇒ 假绿，本轮变异实测踩到）。
    const yieldRule = rule(rail, '.agent-panel-mobile-dock .composer-bare-bar .agent-dock-params > .dock-ghost-ctl {')
    expect(yieldRule).toContain('min-width: 0')
    const spanRule = rule(rail, '.agent-panel-mobile-dock .composer-bare-bar .agent-dock-params > .dock-ghost-ctl > span {')
    expect(spanRule).toContain('min-width: 0')
  })

  it('§12-1 胶囊上不得出现中文长文案「自动生成」/「每次先问」（长文案下沉到浮层卡片）', () => {
    // 只取**胶囊按钮的内部内容**（可见文本）——胶囊的 aria-label/title 与浮层 dialog
    // 的 aria-label、Sheet 标题属于「说明性文案」，本就该出现功能名，不在此禁。
    const btnAt = control.indexOf('class="auto-approve-chip"')
    const btnEnd = control.indexOf('</button>', btnAt)
    expect(btnAt).toBeGreaterThan(-1)
    expect(btnEnd).toBeGreaterThan(btnAt)
    const chipInner = control.slice(btnAt, btnEnd)
    expect(chipInner).not.toContain('自动生成')
    expect(chipInner).not.toContain('每次先问')
    // 开启态只留 `[auto]` 短标记（mono 语义标记）
    expect(chipInner).toContain('data-testid="auto-approve-chip-auto"')
    expect(chipInner).toContain('[auto]')
    // 两个表述必须在浮层卡片里（AutoApprovePanel）说明
    expect(panel).toContain('自动生成')
    // ⚠️ 「每次先问」在面板里出现**两次**（说明段 + 括注）⇒ 变异必须全量替换，
    //    只改一处会假绿（本轮变异实测踩到）。
    expect(panel.split('每次先问').length - 1).toBe(2)
    // 胶囊的无障碍描述必须**带状态词**（否则读屏用户只听到功能名、听不出状态）
    expect(control).toContain('当前每次生成都先问你')
    expect(control).toContain('已开启，agent 生成图片与音频时不再逐次确认')
  })

  it('§12-2 `[auto]` 标记走既有 mono 令牌，零新令牌', () => {
    const auto = rule(control, '.auto-approve-chip-auto {')
    expect(auto).toContain('var(--lnk-font-mono)')
    expect(auto).not.toContain('--neo-')
    expect(auto).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(auto).not.toMatch(/rgba?\(/)
  })

  it('§12-3 移动端胶囊**不带箭头**（移动开底部 Sheet，箭头语义相反）', () => {
    // 箭头只对 PC 渲染
    expect(control).toContain('v-if="props.desktop"\n        class="auto-approve-chip-caret"')
    expect(control).toContain("'is-mobile': !props.desktop")
  })

  it('⑥ 提议卡与 composer 胶囊用同一枚图形', () => {
    expect(timeline).toContain("import AutoApproveGlyph from '@/components/agent/AutoApproveGlyph.vue'")
    expect(timeline).toContain('<AutoApproveGlyph :on="autoApproveAuthorized" :size="16" />')
    expect(control).toContain("import AutoApproveGlyph from './AutoApproveGlyph.vue'")
  })

  it('⑥ 提议卡授权入口仍是 icon-only（形状纪律不因本刀回退）', () => {
    expect(timeline).toContain('class="icon-btn auto-approve-action"')
    expect(timeline).not.toMatch(/data-test="authorize-auto"[\s\S]{0,400}:disabled="autoApproveAuthorized"/)
  })

  it('⑦ 面板说明必须写清作用域（图片与音频免确认 / 视频仍逐次确认）', () => {
    expect(panel).toContain('图片与音频')
    expect(panel).toContain('视频仍会逐次确认')
    expect(panel).toContain('role="switch"')
    expect(panel).toContain('data-testid="auto-approve-panel-switch"')
  })

  it('⑧ 触感开关单一来源：全局共享段定义，两个既有落点不得自带定义', () => {
    const shared = rule(mainCss, '.auto-approve-switch {')
    expect(shared).toContain('width: 44px')
    expect(shared).toContain('height: 26px')
    expect(shared).toContain('var(--lnk-border-subtle)')
    // ON 色 = 琥珀（不是 accent）：本能力语义是「agent 正在替你行动」的注意态
    const onRule = rule(mainCss, ".auto-approve-switch[aria-checked='true']")
    expect(onRule).toContain('var(--lnk-warning)')
    expect(onRule).not.toContain('--lnk-accent')
    // 旋钮随主题（深色主题下亮琥珀轨道 + 白旋钮对比不足）
    expect(rule(mainCss, '.auto-approve-knob {')).toContain('var(--lnk-surface-canvas)')
    // 三个落点：共享段 + 组件模板；PC 设置弹窗与移动设置不得再定义自己的规则
    expect(providerDialog).not.toContain('.auto-approve-switch {')
    expect(profilePane).not.toContain('.auto-approve-switch {')
    expect(providerDialog).not.toContain('.auto-approve-knob {')
    expect(profilePane).not.toContain('.auto-approve-knob {')
  })
})
