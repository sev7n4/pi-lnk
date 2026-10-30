import { BadRequestException } from '@nestjs/common'

/**
 * H1-a（规格 §5.2/§8）：历史分页游标。seq 就绪（2026-10-21 Task 7）后由 seq 游标替换，
 * 本模块届时整体退役——所有分页语义收敛在这一个文件里，替换面最小。
 */
export interface CursorRow {
  createdAt: Date
  id: string
}

export function encodeCursor(row: CursorRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): CursorRow {
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw new BadRequestException('malformed cursor')
  }
  const sep = decoded.lastIndexOf('|')
  const iso = sep > 0 ? decoded.slice(0, sep) : ''
  const id = sep > 0 ? decoded.slice(sep + 1) : ''
  const ts = new Date(iso)
  if (!iso || !id || Number.isNaN(ts.getTime())) {
    throw new BadRequestException('malformed cursor')
  }
  return { createdAt: ts, id }
}

/**
 * rows 必须已按 (createdAt desc, id desc) 排序且完成 superseded 过滤；page 输出 asc。
 *
 * @param rawCount DB 原始行数（superseded 过滤**之前**的 findMany 返回值）。用于 hasMore
 *   兜底判断：getMessages 只 overfetch `take*2` 行，superseded 重负载线程（重跑多）里
 *   过滤后 visible 可能 ≤ take，但窗口外仍有更早行 ⇒ 若只看 visible.length 会误判
 *   hasMore=false 静默截断历史（H1-a 要解决的「长对话不丢头部」的反面）。
 *   rawCount 缺省回退为 rows.length（纯内存分页、无 overfetch 语义时沿用旧逻辑）。
 */
export function paginateVisibleRows<T extends CursorRow>(rows: T[], take: number, rawCount = rows.length) {
  const page = rows.slice(0, take)
  // hasMore：窗口被打满（rawCount >= take*2）即保守判定「可能还有更早行」——即便
  // 过滤后 visible ≤ take 也下发游标；下一页空返回时再收掉按钮（宁可多一页空翻，不丢历史）。
  const hasMore = rawCount >= take * 2 || rows.length > take
  // 游标仅在还有下一页时下发（hasMore=false ⇒ nextCursor=null，见「尾部无游标」用例）
  const nextCursor = hasMore && page.length ? encodeCursor(page[page.length - 1]) : null
  return { page: [...page].reverse(), hasMore, nextCursor }
}
