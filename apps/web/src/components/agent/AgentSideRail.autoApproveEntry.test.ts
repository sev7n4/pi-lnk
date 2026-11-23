// 授权自动生成 · 对话页落点守卫（2026-11-23 UI 迭代 §11：状态胶囊 + 锚定浮层）
//
// ⭐ 背景（用户拍板）：参考 WorkBuddy 权限胶囊的交互骨架——
//   ① 状态归位到 composer 工具行的**胶囊**（图标 + 文字 + 箭头），不做通栏卡片；
//   ② **说明与开关收进锚定浮层**（点开才解释「开了会怎样」，里面直接给开关）。
//   本文件锁住这些不变量（防回退）：
//   ① 通栏文字徽标不得复活；
//   ② 旧的「单击即收回」icon-only 按钮不得复活（收回必须走浮层开关，双向同处）；
//   ③ 入口位置 = composer 工具行，模型 chip 之后、发送键之前；
//   ④ 胶囊外观：关闭态弱化（无底色）、开启态琥珀高亮、**无描边无柔底**、零新令牌；
//   ⑤ 移动端走**同一枚胶囊** + Sheet（裸条三件套纪律），**收缩态入口本体不渲染**
//      （§14：DOM 级 v-if —— CSS 隐藏会让元素在场，形态切换瞬间被同一次触摸误触）；
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
    expect(rail).toContain(':desktop="isDesktopDock"')
    expect(rail).toContain(':read-only="props.readOnly"')
    expect(rail).toContain(':collapsed="mobileBarIdle"')
    const at = rail.indexOf('<AutoApproveControl')
    const paramsAt = rail.indexOf('class="agent-dock-params"')
    const primaryAt = rail.indexOf('class="agent-dock-primary"')
    expect(paramsAt).toBeGreaterThan(-1)
    expect(primaryAt).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(paramsAt)
    expect(at).toBeLessThan(primaryAt)
  })

  it('④ 胶囊关闭态弱化（无底色无边框），开启态琥珀高亮且**无描边无柔底**（§12 / §13）', () => {
    const base = rule(control, '.auto-approve-chip {')
    expect(base).toContain('background: transparent')
    expect(base).toContain('border: 0.5px solid transparent')
    expect(base).not.toContain('var(--lnk-warning-bg)')
    const on = rule(control, '.auto-approve-chip.is-on')
    expect(on).toContain('color: var(--lnk-warning)')
    // §12 Q1：描边是「按钮」语义 ⇒ 开启态不得再描边
    expect(on).not.toContain('border-color')
    expect(on).not.toContain('var(--lnk-warning-border)')
    // §13 Q1：用户指认「背景边框仍未去掉」——生产实测证实描边已透明，
    //    剩下的是琥珀柔底圆角块（bg=rgba(138,82,0,0.1)）⇒ 开启态也不铺底。
    //    ⚠️ 断言要落到**规则体**（真的没有柔底），不能只查 `--lnk-warning-bg`
    //    是否出现在别的规则里。
    expect(on).toContain('background: transparent')
    expect(on).not.toContain('var(--lnk-warning-bg)')
    // hover 也回到中性面（不得再铺琥珀块）
    const onHover = rule(control, '.auto-approve-chip.is-on:hover')
    expect(onHover).not.toContain('var(--lnk-warning-bg-hover)')
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
    // 开启态只留 `Auto` 短标记（§13：去掉方括号，首字母大写）
    expect(chipInner).toContain('data-testid="auto-approve-chip-auto"')
    expect(chipInner).toContain('>Auto</span>')
    // 方括号标记已废除（§13 用户裁定：「去掉[]，仅保留 Auto」）
    expect(chipInner).not.toContain('[auto]')
    // 两个表述必须在浮层卡片里（AutoApprovePanel）说明
    expect(panel).toContain('自动生成')
    // ⚠️ 「每次先问」在面板里出现**两次**（说明段 + 括注）⇒ 变异必须全量替换，
    //    只改一处会假绿（本轮变异实测踩到）。
    expect(panel.split('每次先问').length - 1).toBe(2)
    // 胶囊的无障碍描述必须**带状态词**（否则读屏用户只听到功能名、听不出状态）
    expect(control).toContain('当前每次生成都先问你')
    expect(control).toContain('已开启，agent 生成图片与音频时不再逐次确认')
  })

  it('§12-2 `Auto` 标记走既有 mono 令牌，零新令牌', () => {
    const auto = rule(control, '.auto-approve-chip-auto {')
    expect(auto).toContain('var(--lnk-font-mono)')
    expect(auto).not.toContain('--neo-')
    expect(auto).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(auto).not.toMatch(/rgba?\(/)
  })

  it('§13-1 移动端裸条空闲态纪律：输入行 / 模型 chip / 发送键隐藏（入口由 §14 组件级接管）', () => {
    // idle 态（is-idle）时裸条只剩「＋ + 提示语」，模型 chip / 发送键 / 输入行全隐藏
    // ⚠️ `rule()` 只截取 `{...}` 规则体（选择器列表在体之外）⇒
    //    断言分两步：① 选择器列表里**确实列出了**这三项（正向，防假绿）；
    //    ② 规则体里**确实**是 `display: none`。
    expect(rail).toContain(
      '.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-composer__input-wrap,\n' +
      '.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-dock-params,\n' +
      '.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-dock-primary {',
    )
    const idleRule = rule(rail, '.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-composer__input-wrap,')
    expect(idleRule).toContain('display: none')
    // 只影响移动端裸条作用域，PC 端不受影响。
    // ⚠️ 判据只能看**作用域前缀**：移动端规则的选择器列表跨行且每行都带
    //    `.agent-panel-mobile-dock` 前缀 ⇒ 用「命中行 + 上一行都带前缀」判定。
    const idleLines = rail.split('\n')
    const idx = idleLines.findIndex((l) => l.includes('.is-idle .agent-dock-primary'))
    expect(idx).toBeGreaterThan(-1)
    expect(idleLines[idx]).toContain('.agent-panel-mobile-dock')
    expect(idleLines[idx - 1]).toContain('.agent-panel-mobile-dock')
  })

  /* ---- §14 防误弹三道防线（真机走查：收缩态点输入框 ⇒ 凭空弹出自动生成设置卡片）---- */

  it('§14-1 收缩态**入口本体不渲染**（DOM 级 v-if），不得再用 CSS 隐藏', () => {
    // ① CSS 级隐藏（元素仍在场）⇒ 形态切换瞬间会被同一次触摸的 click 命中
    //    （真机 touchend 落点判定）⇒ 必须从 CSS 隐藏规则里移除
    expect(rail).not.toContain('.is-idle .auto-approve-control')
    // ② 父级必须把收缩态传下去（mobileBarIdle = 移动端 && idle 形态 && 未展开 && 无技能）
    expect(rail).toContain(':collapsed="mobileBarIdle"')
    // ③ 组件里 chip 用 v-if 不渲染（不是 display:none）
    expect(control).toContain('v-if="!props.collapsed"')
    // ④ 根容器**保留**（防线 B 要它常驻记录 pointerdown）+ is-collapsed 只消除占位
    expect(control).toContain("'is-collapsed': props.collapsed")
    const collapsedRule = rule(control, '.auto-approve-control.is-collapsed')
    expect(collapsedRule).toContain('display: none')
  })

  it('§14-2 click 意图守卫：pointerdown 落点不在 chip 内 ⇒ 忽略该 click', () => {
    // ⚠️ 必须 capture + document：裸条/画布会 stopPropagation，冒泡阶段收不到 ⇒ 守卫形同虚设
    expect(control).toContain("document.addEventListener('pointerdown', onDocPointerDown, true)")
    expect(control).toContain('chipRef.value.contains(node)')
    // 忽略判据：有过 pointerdown 记录、且落点不在 chip 内
    expect(control).toContain('if (pointerDownSeen && !pointerDownOnChip) return')
    // 芯片的 click 必须走守卫（不得直接写 open = !open）
    expect(control).toContain('@click="onChipClick"')
    expect(control).not.toContain('@click="open = !open"')
  })

  it('§14-3 形态复位：转为收缩态时关掉 open（Sheet 跨形态不残留）', () => {
    // Sheet 经 Teleport 挂 body ⇒ 父级 display:none 杀不掉它 ⇒ 必须显式复位
    expect(control).toMatch(/watch\(\s*\(\) => props\.collapsed/)
    expect(control).toContain('if (v) open.value = false')
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
