/**
 * 相对时间口径（创作空间列表/卡墙共用）：刚刚 / N 分钟前 / N 小时前 / N 天前 / M 月 N 日。
 * 承作品带口径；原 CanvasesPage 内联函数，§13.3 拆视图时抽为共享模块（两视图禁止各写一份）。
 */
export function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, Date.now() - t)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
