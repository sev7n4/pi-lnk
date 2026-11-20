// 模型卡令牌守卫（2026-11-20，2026-11-21 R2 扩展）：选中态禁用随主题翻转的 hi-bg/hi-text，
// 统一用主题稳定的 accent 三件套；模型选项逻辑抽 composable 供 PC/移动双形态共用；
// 列表行渲染抽 ModelOptionRow 单源（本刀起 accent 三件套住在行组件里，此处跨文件锁）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'UniversalModelSelector.vue'), 'utf8')
const rowSfc = readFileSync(join(here, '../agent/ModelOptionRow.vue'), 'utf8')

describe('UniversalModelSelector token & composable guard', () => {
  it('no legacy flip tokens hi-bg/hi-text', () => {
    expect(sfc).not.toContain('--neo-hi-bg')
    expect(sfc).not.toContain('--neo-hi-text')
    expect(sfc).not.toContain('--lnk-hi-bg')
    expect(sfc).not.toContain('--lnk-hi-text')
    expect(rowSfc).not.toContain('--neo-hi-bg')
    expect(rowSfc).not.toContain('--neo-hi-text')
    expect(rowSfc).not.toContain('--lnk-hi-bg')
    expect(rowSfc).not.toContain('--lnk-hi-text')
  })

  it('selected row uses theme-stable accent trio（选中态渲染已迁至共用行组件 ModelOptionRow）', () => {
    expect(sfc).toContain('ModelOptionRow')
    expect(rowSfc).toContain('--lnk-accent-subtle')
    expect(rowSfc).toContain('--lnk-accent-text')
    expect(rowSfc).toContain('--lnk-accent-border')
  })

  it('option logic extracted to shared composable (PC/移动双形态共用)', () => {
    expect(sfc).toContain('useModelSelectorOptions')
  })

  it('no legacy dock-inline-card anchor hook (mobile uses full-width Sheet)', () => {
    expect(sfc).not.toContain('dock-inline-card')
  })
})
