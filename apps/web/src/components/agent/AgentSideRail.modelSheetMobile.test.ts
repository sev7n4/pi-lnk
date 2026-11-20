// 模型选择卡双形态 + 配置页守卫（2026-11-20 iOS 化 R2/R3）：
// PC 保留锚定 popover；移动端全宽 MobileSheet + 设置齿轮 + 同 Sheet 内配置二级页 + 上下文只读。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const vue = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const css = readFileSync(join(here, '../../styles/neo-node.css'), 'utf8')

describe('model selector dual-form (PC popover / mobile sheet)', () => {
  it('PC branch keeps UniversalModelSelector gated on isDesktopDock', () => {
    const at = vue.indexOf('<UniversalModelSelector')
    expect(at).toBeGreaterThan(-1)
    const region = vue.slice(at - 120, at + 200)
    expect(region).toContain('isDesktopDock')
  })

  it('mobile renders full-width MobileSheet titled 选择模型 with swipe default on', () => {
    expect(vue).toContain("'选择模型'")
    expect(vue).toContain('<MobileSheet')
    // 不传 swipeToDismiss=false ⇒ 默认 true（下滑关闭继承）
    const sheetAt = vue.indexOf('v-if="modelSheetOpen')
    const region = vue.slice(sheetAt, sheetAt + 400)
    expect(region).not.toContain(':swipe-to-dismiss="false"')
  })

  it('sheet header exposes settings gear via headerActions slot to open in-sheet config', () => {
    expect(vue).toContain('model-config-open')
    expect(vue).toContain('aria-label="模型配置"')
    expect(vue).toContain('#headerActions') // <template #headerActions> 插槽
  })

  it('config page lives in same sheet via view state + back button', () => {
    expect(vue).toMatch(/modelSheetView\s*=\s*ref<[^>]+>\(['"]list['"]\)/)
    expect(vue).toMatch(/:show-back=/)
    expect(vue).toContain('@back=')
    expect(vue).toContain('模型配置')
  })

  it('context window row is read-only (contextWindowLabel, no chevron/click)', () => {
    expect(vue).toContain('contextWindowLabel')
    const at = vue.indexOf('contextWindowLabel(')
    const region = vue.slice(at - 200, at + 200)
    expect(region).not.toContain('@click=')
  })

  it('old 12px inset patch removed from neo-node.css mobile override', () => {
    const at = css.indexOf('.dock-inline-card')
    expect(at).toBeGreaterThan(-1)
    const block = css.slice(at, at + 400)
    expect(block).not.toContain('left: 12px')
    expect(block).not.toContain('right: 12px')
  })
})
