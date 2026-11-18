// UI 美化 §4.2（2026-11-18）：技能 sheet 双形态守卫——
// 移动端走 MobileSheet（把手/遮罩/safe-area 一次吃满），PC 保留锚定 popover（避免 1440px 全宽底栏）。
// F1（2026-11-17）旧的「移动端 .skill-sheet-card fixed CSS」判据随基座统一改写，防回潮意图保留。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const mobileBlock = sfc.match(/@media \(max-width: 767px\) \{[\s\S]*?\n\}/)?.[0] ?? ''

describe('技能 sheet 双形态（移动端 MobileSheet / PC 锚定 popover）', () => {
  it('移动端分支由 MobileSheet 承载 SkillPickSheet', () => {
    expect(sfc).toContain('<MobileSheet')
    expect(sfc).toContain('v-if="skillSheetOpen && !isDesktopDock"')
    expect(sfc).toContain('title="选择技能"')
    expect(sfc).toContain(':subtitle="selectedSkillIds.length ? `已选 ${selectedSkillIds.length}` : \'默认由平台路由\'"')
  })

  it('PC 分支原地锚定 skill-sheet-card（禁 Teleport，不走全宽底栏）', () => {
    // #949 生产 CDP 复测：PC 分支 Teleport to body 会丢锚定上下文，
    // absolute bottom-full 相对 body ⇒ y=-766 整卡在视口上方不可见。
    // PC 必须原地渲染（<template v-else>），锚定语义由父容器提供。
    expect(sfc).not.toContain('<Teleport v-else to="body">')
    expect(sfc).toContain('<template v-else>')
    expect(sfc).toContain('neo-popover skill-sheet-card absolute bottom-full left-0 z-30')
    expect(sfc).toContain('skill-sheet-head')
  })

  it('移动端不再有 skill-sheet-card 的 fixed 补丁 CSS（基座已统一）', () => {
    expect(mobileBlock).not.toContain('.skill-sheet-card')
  })

  it('两端共用同一个纯内容 SkillPickSheet，emit 接线未丢', () => {
    const uses = sfc.match(/<SkillPickSheet/g) ?? []
    expect(uses).toHaveLength(2)
    for (const evt of ['@toggle', '@clear', '@close', '@manage']) {
      expect(sfc).toContain(evt)
    }
  })

  it('R2（二轮 2026-11-18）：移动分支传 embedded（滚动权移交 m-sheet-body，灭触摸死区）', () => {
    // 移动分支的 SkillPickSheet 必须带 embedded；PC 锚定卡分支不传（内层滚动保留）。
    const mobileUse = sfc.slice(sfc.indexOf('<MobileSheet'), sfc.indexOf('</MobileSheet>'))
    expect(mobileUse).toContain('embedded')
    // 全文件 embedded 恰好 1 处（只在移动分支），PC 分支零命中
    expect((sfc.match(/\bembedded\b/g) ?? []).length).toBe(1)
  })

  it('R1（二轮 2026-11-18）：PC 锚定卡限宽 max-w min(92vw,560px)，禁 min-content 横向爆宽', () => {
    expect(sfc).toContain('max-w-[min(92vw,560px)]')
  })
})
