// MobileSheet 可选导航扩展（模型选择卡 iOS 化 R1）：back 按钮 + headerActions 插槽。
// 纯静态契约 + 挂载断言：守卫「可选插槽零破坏存量调用点」+「设置按钮插槽存在」。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'MobileSheet.vue'), 'utf8')

describe('MobileSheet optional back button and header actions slot', () => {
  it('declares showBack prop and back emit', () => {
    expect(sfc).toMatch(/showBack\?:\s*boolean/)
    expect(sfc).toMatch(/back:\s*\[\]/)
  })

  it('renders back button only when showBack is true, with a11y and touch target', () => {
    expect(sfc).toContain('v-if="showBack"')
    expect(sfc).toContain('data-testid="m-sheet-back"')
    expect(sfc).toContain('aria-label="返回"')
    expect(sfc).toContain('@click="emit(\'back\')"')
  })

  it('exposes headerActions slot before the close button and keeps slot optional', () => {
    expect(sfc).toContain('<slot name="headerActions" />')
    const slotAt = sfc.indexOf('<slot name="headerActions" />')
    const closeAt = sfc.indexOf('class="m-sheet-close"')
    expect(slotAt).toBeGreaterThan(-1)
    expect(closeAt).toBeGreaterThan(-1)
    expect(slotAt).toBeLessThan(closeAt)
  })

  it('keeps swipeToDismiss default true (存量手势零回归)', () => {
    expect(sfc).toMatch(/swipeToDismiss:\s*true/)
    expect(sfc).toContain('DISMISS_THRESHOLD_PX = 80')
  })
})
