// 授权自动生成 · 对话页落点守卫（2026-11-23 UI 迭代）
//
// ⭐ 背景（用户投诉）：「composer 上方这么宽一个常驻卡片，对话页被污染了」。
// 病根 = 用「文字块」承载了一个「开关状态」：8 个字占了 composer 正上方的黄金视觉位。
// 本次迭代把它迁到 composer 工具行（单枚 15px 琥珀盾牌图标），并把提议卡里的长文字按钮图标化。
//
// 本文件锁三条不变量（防回退）：
// ① **通栏徽标不得复活**（`.agent-auto-approve-line` / `agent-auto-approve-revoke` 一律不许出现）；
// ② composer 工具行图标：仅已授权时渲染 + 点击即收回 + 零背景块 + 零新令牌；
// ③ 提议卡与 composer 用**同一枚图形**（跨位置可识别性）。
//
// 用源码契约范式（与本目录既有 AgentSideRail.*.test.ts 一致）：
// 组件体量过大，mount 成本高且易被无关依赖拖挂；契约断言更直接、变异必转红。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rail = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const timeline = readFileSync(join(here, 'AgentTurnTimeline.vue'), 'utf8')

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

describe('授权自动生成 · 对话页落点（2026-11-23 UI 迭代守卫）', () => {
  it('① 通栏文字徽标已删除，源码不得再出现其类名与 testid', () => {
    expect(rail).not.toContain('agent-auto-approve-line')
    expect(rail).not.toContain('agent-auto-approve-revoke')
    expect(rail).not.toContain('agent-auto-approve-text')
    expect(rail).not.toContain('data-testid="agent-auto-approve-line"')
    expect(rail).not.toContain('data-testid="agent-auto-approve-revoke"')
    // 也不许以别的名字把「已授权自动生成」长文字塞回系统层
    expect(rail).not.toContain('已授权自动生成</span>')
  })

  it('② composer 工具行内是单枚图标按钮：仅已授权渲染 + 点击即收回', () => {
    expect(rail).toContain('data-testid="agent-auto-approve-toggle"')
    expect(rail).toContain('class="auto-approve-toggle"')
    expect(rail).toContain('v-if="autoApproveAuthorized"')
    expect(rail).toContain('@click="onRevokeAutoApprove"')
    // 图标本体：实心琥珀态（状态徽标形态）
    expect(rail).toContain('<AutoApproveGlyph :on="true" :size="15" />')
    // 可访问性文案在（视觉零文字，但读屏可读）
    expect(rail).toContain('aria-label="已授权自动生成，点击收回授权"')
  })

  it('② 图标默认零背景块（无背景/无边框），hover 才出琥珀柔底', () => {
    const r = rule(rail, '.auto-approve-toggle')
    expect(r).toContain('width: 24px')
    expect(r).toContain('height: 24px')
    expect(r).toContain('background: transparent')
    expect(r).toContain('border: 0.5px solid transparent')
    // hover 才上色 ⇒ 默认态在 composer 里是「零污染」的
    const hover = rule(rail, '.auto-approve-toggle:hover')
    expect(hover).toContain('background: var(--lnk-warning-bg)')
  })

  it('② 零新令牌：只用既有 --lnk-warning 三件套（禁 --neo-* 前缀）', () => {
    const r = rule(rail, '.auto-approve-toggle')
    expect(r).toContain('var(--lnk-warning)')
    expect(r).not.toContain('--neo-')
    // 组件内不得出现未定义的令牌（琥珀三件套之外的 warning 变体不存在）
    expect(r).not.toContain('var(--lnk-amber')
    expect(r).not.toContain('var(--lnk-caution')
  })

  it('② 移动端裸条摊平后图标仍在（display:contents ⇒ 需显式 order）', () => {
    expect(rail).toContain('.agent-panel-mobile-dock .composer-bare-bar .auto-approve-toggle')
    const r = rule(rail, '.agent-panel-mobile-dock .composer-bare-bar .auto-approve-toggle')
    expect(r).toContain('order: 2')
  })

  it('③ 提议卡与 composer 用同一枚图形（AutoApproveGlyph）', () => {
    expect(timeline).toContain("import AutoApproveGlyph from '@/components/agent/AutoApproveGlyph.vue'")
    expect(timeline).toContain('<AutoApproveGlyph :on="autoApproveAuthorized" :size="16" />')
    expect(rail).toContain("import AutoApproveGlyph from '@/components/agent/AutoApproveGlyph.vue'")
  })

  it('③ 提议卡授权入口是 icon-only（无长文字按钮），且已授权态不再 disabled', () => {
    // 同排次级动作一律 icon-only：形状纪律
    expect(timeline).toContain('class="icon-btn auto-approve-action"')
    expect(timeline).not.toContain('class="btn-secondary"\n            data-test="authorize-auto"')
    // 禁用态会让用户收不回授权 ⇒ 已授权态必须可点（toggle）
    expect(timeline).not.toMatch(/data-test="authorize-auto"[\s\S]{0,400}:disabled="autoApproveAuthorized"/)
  })
})
