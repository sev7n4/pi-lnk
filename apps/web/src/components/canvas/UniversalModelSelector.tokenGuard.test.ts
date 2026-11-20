// 模型卡令牌守卫（2026-11-20）：选中态禁用随主题翻转的 hi-bg/hi-text，
// 统一用主题稳定的 accent 三件套；模型选项逻辑抽 composable 供 PC/移动双形态共用。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'UniversalModelSelector.vue'), 'utf8')

describe('UniversalModelSelector token & composable guard', () => {
  it('no legacy flip tokens hi-bg/hi-text', () => {
    expect(sfc).not.toContain('--neo-hi-bg')
    expect(sfc).not.toContain('--neo-hi-text')
    expect(sfc).not.toContain('--lnk-hi-bg')
    expect(sfc).not.toContain('--lnk-hi-text')
  })

  it('selected row uses theme-stable accent trio', () => {
    expect(sfc).toContain('--lnk-accent-subtle')
    expect(sfc).toContain('--lnk-accent-text')
    expect(sfc).toContain('--lnk-accent-border')
  })

  it('option logic extracted to shared composable (PC/移动双形态共用)', () => {
    expect(sfc).toContain('useModelSelectorOptions')
  })
})
