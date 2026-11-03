import { describe, it, expect, afterEach } from 'vitest'
import { isTerminalWriteTapEnabled } from './prisma.module'

describe('PrismaModule terminal-write-tap flag 解析（Review Focus #1）', () => {
  const original = process.env.LNKPI_TERMINAL_WRITE_TAP
  afterEach(() => {
    if (original === undefined) delete process.env.LNKPI_TERMINAL_WRITE_TAP
    else process.env.LNKPI_TERMINAL_WRITE_TAP = original
  })

  it('未设置 → 开（缺省开）', () => {
    delete process.env.LNKPI_TERMINAL_WRITE_TAP
    expect(isTerminalWriteTapEnabled()).toBe(true)
  })
  it('= "true" → 开', () => {
    process.env.LNKPI_TERMINAL_WRITE_TAP = 'true'
    expect(isTerminalWriteTapEnabled()).toBe(true)
  })
  it('= "false" → 关（精确字符串判据）', () => {
    process.env.LNKPI_TERMINAL_WRITE_TAP = 'false'
    expect(isTerminalWriteTapEnabled()).toBe(false)
  })
  it('其他值（"0"/"off"/"FALSE"/""）→ 视为开，仅 "false" 关', () => {
    for (const v of ['0', 'off', 'FALSE', '']) {
      process.env.LNKPI_TERMINAL_WRITE_TAP = v
      expect(isTerminalWriteTapEnabled()).toBe(true)
    }
  })
})
