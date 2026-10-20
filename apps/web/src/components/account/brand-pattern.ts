/**
 * 品牌纹样确定性生成（规格 D2）：同 userId 永远同图案，无头像用户不再共享公司 logo。
 *
 * 只产出几何数据，不产出颜色 —— 颜色一律由调用方消费 L2 令牌，
 * 这样纹样才能做到「主题不变式」（见 BrandPatternAvatar：墨点走 --lnk-dim-rgb 恒黑通道）。
 */
export interface PatternDot {
  /** 0–100（%） */
  x: number
  y: number
  /** 6–18（%） */
  r: number
  /** 0.18–0.32 */
  alpha: number
}

/** FNV-1a 32bit：短、稳、零依赖。 */
function hash(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const DOTS = 3

/**
 * 由 seed 派生墨点布局。纯函数：同输入必同输出，无内部状态、不读外部时钟。
 * 空 seed 退化为 'lnk' 固定种子（不抛错）。
 */
export function brandPattern(seed: string): { dots: PatternDot[] } {
  let h = hash(seed || 'lnk')
  // 在哈希链上继续推进取数：每次调用都改变 h，避免三个墨点取到同一个值
  const next = (max: number) => {
    h = (Math.imul(h, 0x01000193) + 0x9e3779b9) >>> 0
    return h % max
  }
  const dots: PatternDot[] = Array.from({ length: DOTS }, () => ({
    x: next(101),
    y: next(101),
    r: 6 + next(13),
    alpha: Number((0.18 + next(15) / 100).toFixed(2)),
  }))
  return { dots }
}
