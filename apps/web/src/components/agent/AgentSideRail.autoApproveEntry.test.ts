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

  it('④ 胶囊关闭态弱化（无底色无边框），开启态琥珀高亮', () => {
    const base = rule(control, '.auto-approve-chip {')
    expect(base).toContain('background: transparent')
    expect(base).toContain('border: 0.5px solid transparent')
    expect(base).not.toContain('var(--lnk-warning-bg)')
    const on = rule(control, '.auto-approve-chip.is-on')
    expect(on).toContain('color: var(--lnk-warning)')
    expect(on).toContain('background: var(--lnk-warning-bg)')
    expect(on).toContain('border-color: var(--lnk-warning-border)')
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

  it('⑤ 移动端：icon-only 触发器 + 底部 Sheet，裸条顺序规则指向组件根', () => {
    expect(control).toContain('data-testid="auto-approve-trigger"')
    expect(control).toContain('<MobileSheet')
    // 裸条纪律：移动端不得出现文字胶囊
    expect(control).toContain("v-if=\"props.desktop\"")
    expect(rail).toContain('.agent-panel-mobile-dock .composer-bare-bar .auto-approve-control')
    const r = rule(rail, '.agent-panel-mobile-dock .composer-bare-bar .auto-approve-control')
    expect(r).toContain('order: 2')
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
