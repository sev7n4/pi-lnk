import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, paginateVisibleRows } from './messages-cursor'

const row = (id: string, iso: string) => ({ id, createdAt: new Date(iso) })

describe('encodeCursor/decodeCursor', () => {
  it('往返一致（Review Focus #2/#3 地基）', () => {
    const r = row('m1', '2026-10-28T10:00:00.000Z')
    expect(decodeCursor(encodeCursor(r))).toEqual(r)
  })
  it('畸形输入抛错而非静默空页', () => {
    expect(() => decodeCursor('not-a-cursor!!')).toThrow()
    expect(() => decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toThrow()
    expect(() => decodeCursor(Buffer.from('bad-date|x', 'utf8').toString('base64url'))).toThrow()
  })
})

describe('paginateVisibleRows', () => {
  const rows = [
    row('m4', '2026-10-28T10:03:00.000Z'),
    row('m3', '2026-10-28T10:02:00.000Z'),
    row('m2', '2026-10-28T10:01:00.000Z'),
    row('m1', '2026-10-28T10:00:00.000Z'),
  ]
  it('首页取最新 take 条，输出 asc，尾部 hasMore=false 无游标', () => {
    const p = paginateVisibleRows(rows.slice(0, 3), 5)
    // 输入 desc [m4,m3,m2]（take=5 > 3，全量成页）⇒ asc 输出 [m2,m3,m4]。
    // brief 原稿期望 ['m1','m2','m3'] 系笔误：m1 不在输入内，任何实现都无法满足。
    expect(p.page.map((r) => r.id)).toEqual(['m2', 'm3', 'm4'])
    expect(p.hasMore).toBe(false)
    expect(p.nextCursor).toBeNull()
  })
  it('hasMore=true 时游标指向本页最早一行（asc 首行）', () => {
    const p = paginateVisibleRows(rows, 2)
    expect(p.page.map((r) => r.id)).toEqual(['m3', 'm4'])
    expect(p.hasMore).toBe(true)
    expect(p.nextCursor).toBe(encodeCursor(row('m3', '2026-10-28T10:02:00.000Z')))
  })
  it('同毫秒行按 id 决胜（Review Focus #3：页边界不重不漏）', () => {
    const tied = [row('b', '2026-10-28T10:00:00.000Z'), row('a', '2026-10-28T10:00:00.000Z')]
    const p = paginateVisibleRows(tied, 1)
    expect(p.page[0]!.id).toBe('b')
    // 游标必须指向页内 desc 序末行（= 本页最早一行 b）：下一页 where id < b 才能取回 a。
    // 若指向页外行 a，则 id < a 永远取不到 a ⇒ 同毫秒页边界丢行。
    expect(p.nextCursor).toBe(encodeCursor(row('b', '2026-10-28T10:00:00.000Z')))
  })
  it('空输入得空页', () => {
    expect(paginateVisibleRows([], 10)).toEqual({ page: [], hasMore: false, nextCursor: null })
  })
  it('P1：overfetch 满窗但 superseded 过滤后 visible<take 仍判 hasMore=true（不静默截断）', () => {
    // 复现 getMessages：DB 返回 10 行（take*2，take=5）其中 6 条 superseded 被滤掉，
    // 仅 4 条 visible 进入分页。旧逻辑 visible.length(4) > take(5) ⇒ false，会隐藏更早历史；
    // 正确：rawCount=10 === take*2 ⇒ 保守 hasMore=true，下发游标，下一页空返回时再收按钮。
    const visible = [
      row('m4', '2026-10-28T10:03:00.000Z'),
      row('m3', '2026-10-28T10:02:00.000Z'),
      row('m2', '2026-10-28T10:01:00.000Z'),
      row('m1', '2026-10-28T10:00:00.000Z'),
    ]
    const p = paginateVisibleRows(visible, 5, 10)
    expect(p.hasMore).toBe(true)
    expect(p.nextCursor).not.toBeNull()
    // 页内容仍是 asc 的前 take 条，不受 rawCount 影响
    expect(p.page.map((r) => r.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })
  it('P1：rawCount<take*2 且 visible≤take 时判 hasMore=false（确无更早行）', () => {
    // DB 只回了 6 行（< take*2=10），过滤后 2 条 visible，确无窗口外行 ⇒ false。
    const visible = [row('m2', '2026-10-28T10:01:00.000Z'), row('m1', '2026-10-28T10:00:00.000Z')]
    const p = paginateVisibleRows(visible, 5, 6)
    expect(p.hasMore).toBe(false)
    expect(p.nextCursor).toBeNull()
  })
})
