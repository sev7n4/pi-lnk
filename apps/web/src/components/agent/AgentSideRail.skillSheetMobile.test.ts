// F1（2026-11-17 P3 真机四缺陷）移动端技能 sheet 定位守卫（fs-scan，与 AgentSideRail 其他守卫同惯例）。
// D1 根因：技能 sheet 与 attachCard 同走 Teleport to body，但只有 attach-card 有移动端 fixed/z90 覆盖；
// skill-sheet-card 停在 base 的 absolute bottom-full z-30 ⇒ 实测 rect.y=-382（视口上方）、z30<遮罩 z85，
// 移动端完全不可见。此守卫锁「技能 sheet 复用 attach-card 同款底部抽屉 CSS」，防回潮。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

// 取 @media (max-width: 767px) 中含 .skill-sheet-card 的规则块
const mobileBlockMatch = sfc.match(/@media \(max-width: 767px\) \{[\s\S]*?\.skill-sheet-card[\s\S]*?\n\}/)
const mobileBlock = mobileBlockMatch?.[0] ?? ''

describe('F1 移动端技能 sheet 底部抽屉定位', () => {
  it('skill-sheet-card 落在 max-width:767px 媒体查询内', () => {
    expect(mobileBlock).toContain('.skill-sheet-card')
  })

  it('移动端 skill-sheet-card 升为 fixed 贴底、z-index 90（高于遮罩 z85）', () => {
    const rule = mobileBlock.slice(mobileBlock.indexOf('.attach-card,'))
    expect(rule).toContain('position: fixed')
    expect(rule).toContain('bottom: 0')
    expect(rule).toMatch(/z-index:\s*90/)
  })

  it('移动端 skill-sheet-card 带 safe-area 内垫 + 贴底无 mb-1 悬空', () => {
    expect(mobileBlock).toContain('env(safe-area-inset-bottom')
    const selfRule = mobileBlock.slice(mobileBlock.lastIndexOf('.skill-sheet-card {'))
    expect(selfRule).toContain('margin-bottom: 0')
  })

  it('base 仍保留 absolute bottom-full z-30（PC popover 不回退）', () => {
    expect(sfc).toContain('neo-popover skill-sheet-card absolute bottom-full left-0 z-30')
  })
})
