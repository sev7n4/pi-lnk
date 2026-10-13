/**
 * RB-D7 契约镜像（shared/Zod 侧）：fixture 是唯一 SSOT。
 * 断言 validateSidebarAttachments 对每个条目的过/拒矩阵；
 * rejectReason=non-array 时错误文案必须中文可行动（含「attachments 必须是数组」），
 * 不得是 TypeError 的 "items.map is not a function"（PR-A 终审 M-3）。
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { validateSidebarAttachments, SIDEBAR_ATTACHMENT_MAX } from './sidebarAttachments'

interface FixtureEntry {
  name: string
  note: string
  attachments: unknown
  expectZod: 'pass' | 'reject'
  rejectReason?: 'shape' | 'limit' | 'non-array'
}

const fixture: FixtureEntry[] = JSON.parse(
  await readFile(fileURLToPath(new URL('../fixtures/sidebar-attachments-contract.json', import.meta.url)), 'utf8'),
) as FixtureEntry[]

describe('sidebar attachments 契约矩阵（RB-D7 fixture SSOT）', () => {
  it('fixture 本身有效（非空、字段齐）', () => {
    expect(fixture.length).toBeGreaterThanOrEqual(5)
    for (const e of fixture) {
      expect(e.name, e.note).toBeTruthy()
      expect(['pass', 'reject']).toContain(e.expectZod)
      if (e.expectZod === 'reject') expect(e.rejectReason).toBeTruthy()
    }
  })

  for (const e of fixture) {
    it(`[${e.name}] Zod ${e.expectZod}${e.rejectReason ? `（${e.rejectReason}）` : ''}`, () => {
      if (e.expectZod === 'pass') {
        expect(() => validateSidebarAttachments(e.attachments as never)).not.toThrow()
        return
      }
      try {
        validateSidebarAttachments(e.attachments as never)
        expect.unreachable(`${e.name} 应被拒绝`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        expect(msg).not.toMatch(/items\.map is not a function/)
        if (e.rejectReason === 'limit') expect(msg).toContain(`最多添加 ${SIDEBAR_ATTACHMENT_MAX}`)
        if (e.rejectReason === 'non-array') expect(msg).toContain('attachments 必须是数组')
      }
    })
  }
})
