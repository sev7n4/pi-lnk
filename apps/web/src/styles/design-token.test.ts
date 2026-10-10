/**
 * Design Token 守卫（墨流 Ink Flow · v2）
 *
 * ## 为什么需要这条测试
 *
 * 2026-10-09 前端诊断实测：旧令牌体系 `--neo-*` 存在三类**静默**缺陷，
 * 全部是"代码看着对、线上悄悄坏"的形态：
 *
 *   1. **成对性缺失**：深色块 74 个变量 / 浅色块 60 个 —— 14 个只在深色有定义，
 *      浅色主题静默继承深色值；另有 4 个（severity-*）只在浅色有，深色下整条声明失效。
 *   2. **对比度不达标**：`--neo-text-muted` 深 3.60:1 / 浅 2.60:1，均低于 WCAG AA 4.5:1。
 *      根因是"用 rgba 白透明度当文字色"——透明度文字的对比度随所在表面变化，
 *      单一令牌根本无法保证。故本体系规定：**文字色一律实色 hex**。
 *   3. **引用未定义**：13 个 token 被引用却从未定义（`--neo-success` / `--neo-danger` /
 *      `--neo-panel` / `--neo-fg` …），导致整条 Tailwind 任意值声明在计算值阶段失效，
 *      表现为"没有边框、没有底色"且**不报任何错**。
 *
 * ⇒ 这三类都不能靠自觉，只能靠测试锁。
 *
 * ## 关于亮度公式（⛔ 必读）
 *
 * 本文件使用 **WCAG 2.1 正确系数**：R 0.2126 / G 0.7152 / **B 0.0722**。
 *
 * ⚠️ `palette-parity.test.ts:82` 的 `luminance()` 用的是 **0.2992** 作为蓝通道系数，
 *    这是错的（0.2992 是 YCbCr/模拟亮度时代的系数，不是 WCAG sRGB 系数）。
 *    实测偏差最大 **3.58**，且方向随含蓝量变化（对含蓝高的色系统性偏高）。
 *    ⇒ 偏高的后果是"不达标的配色被判为达标"（假绿）。
 *    ⇒ 本测试**故意不复用**那个函数，而是内联正确实现；修 palette-parity 时需一并核对。
 *
 * ## 判据
 *
 * - L2 语义变量在深色块与浅色块中**严格同名成对**（集合相等）；
 * - 每个文字/语义前景色对其**可能落到的每一个表面**的对比度，取**最差值** ≥ 4.5:1；
 * - 主色按钮：白字压在 accent 与 accent-hover 上均 ≥ 4.5:1；
 * - 文件内每个 `var(--lnk-*)` 引用都必须在 L1 或同块中有定义；
 * - 非颜色阶梯：间距 4 的倍数、圆角/层级/时长单调递增、正文行高 ≥1.45、标题行高 ≤1.35。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKENS_CSS = join(HERE, 'design-tokens.css')
const css = readFileSync(TOKENS_CSS, 'utf8')

/* ---------------- 基础设施 ---------------- */

/** WCAG 2.1 相对亮度。⛔ B 通道系数是 0.0722，不是 0.2992（见文件头说明）。 */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`不是 6 位 hex：${hex}`)
  const n = parseInt(m[1]!, 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}

/** WCAG 对比度。⛔ 别用不带 +0.05 的简写公式。 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

interface Block {
  /** 变量名 -> 原始值（可能含 var() 引用） */
  decls: Map<string, string>
}

const parsed = postcss.parse(css)
const blocks: Record<'base' | 'dark' | 'light', Block> = {
  base: { decls: new Map() },
  dark: { decls: new Map() },
  light: { decls: new Map() },
}

for (const rule of parsed.nodes) {
  if (rule.type !== 'rule') continue
  const sel = (rule as unknown as { selector: string }).selector
  const target =
    sel.includes("data-theme='light'") ? 'light'
    : sel.includes("data-theme='dark'") ? 'dark'
    : sel.trim() === ':root' ? 'base'
    : null
  if (!target) continue
  for (const node of (rule as unknown as { nodes: Array<{ type: string; prop?: string; value?: string }> }).nodes) {
    if (node.type === 'decl' && node.prop?.startsWith('--lnk-') && node.value) {
      blocks[target].decls.set(node.prop, node.value.trim())
    }
  }
}

/** 递归解析 var() 直到拿到 hex；解析不出来（rgba/gradient）返回 null。 */
function resolve(name: string, scope: Block, depth = 0): string | null {
  if (depth > 8) return null
  const raw = scope.decls.get(name) ?? blocks.base.decls.get(name)
  if (!raw) return null
  if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return raw.length === 7 ? raw.toLowerCase() : raw
  const m = /^var\(\s*(--lnk-[a-z0-9-]+)\s*\)$/.exec(raw)
  if (m) return resolve(m[1]!, scope, depth + 1)
  return null
}

const SURFACES = ['--lnk-surface-canvas', '--lnk-surface-sunken', '--lnk-surface-base', '--lnk-surface-raised'] as const
const TEXT_TOKENS = ['--lnk-text-primary', '--lnk-text-secondary', '--lnk-text-muted'] as const
const FG_TOKENS = [
  '--lnk-accent-text', '--lnk-energy', '--lnk-credit',
  '--lnk-success', '--lnk-warning', '--lnk-error', '--lnk-info',
] as const

/** 对某主题，算出 token 在所有表面上的最差对比度。 */
function worstContrast(theme: 'dark' | 'light', token: string): number {
  const scope = blocks[theme]
  const fg = resolve(token, scope)
  expect(fg, `${theme} 主题的 ${token} 必须能解析成实色 hex（禁止用 rgba 透明度当文字色）`).toBeTruthy()
  let worst = Number.POSITIVE_INFINITY
  for (const s of SURFACES) {
    const bg = resolve(s, scope)
    expect(bg, `${theme} 主题的 ${s} 必须能解析成实色 hex`).toBeTruthy()
    worst = Math.min(worst, contrast(fg!, bg!))
  }
  return worst
}

/* ---------------- 判据 1：成对性 ---------------- */

describe('L2 语义变量成对性', () => {
  it('深色块与浅色块的 L2 变量名集合必须完全相等', () => {
    const dark = new Set([...blocks.dark.decls.keys()])
    const light = new Set([...blocks.light.decls.keys()])
    const onlyDark = [...dark].filter((k) => !light.has(k))
    const onlyLight = [...light].filter((k) => !dark.has(k))

    // 非空守卫：防止"两边都解析为空"导致断言恒过（空集假绿）
    expect(dark.size, '深色块必须解析出变量（否则是解析器失效的假绿）').toBeGreaterThan(20)
    expect(light.size, '浅色块必须解析出变量').toBeGreaterThan(20)

    expect(onlyDark, `仅在深色定义、浅色会静默继承深色值的变量：${onlyDark.join(', ')}`).toEqual([])
    expect(onlyLight, `仅在浅色定义、深色下整条声明会失效的变量：${onlyLight.join(', ')}`).toEqual([])
  })
})

/* ---------------- 判据 2：对比度 ---------------- */

describe('文字对比度（WCAG AA 4.5:1，取最差表面）', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const token of TEXT_TOKENS) {
      it(`${theme} · ${token}`, () => {
        const worst = worstContrast(theme, token)
        expect(
          worst,
          `${theme} 主题 ${token} 在某一个表面上的对比度只有 ${worst.toFixed(2)}:1（要求 ≥4.5:1）`,
        ).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

describe('语义前景色对比度（作为文字/图标时）', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const token of FG_TOKENS) {
      it(`${theme} · ${token}`, () => {
        const worst = worstContrast(theme, token)
        expect(
          worst,
          `${theme} 主题 ${token} 作为文字/图标时最差对比度 ${worst.toFixed(2)}:1（要求 ≥4.5:1）`,
        ).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

describe('主色按钮可读性', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const state of ['--lnk-accent', '--lnk-accent-hover', '--lnk-accent-active'] as const) {
      it(`${theme} · 白字压在 ${state} 上`, () => {
        const scope = blocks[theme]
        const fg = resolve('--lnk-text-on-accent', scope)
        const bg = resolve(state, scope)
        expect(fg, `${theme} 缺 --lnk-text-on-accent`).toBeTruthy()
        expect(bg, `${theme} 缺 ${state}（或引用了未定义变量）`).toBeTruthy()
        const c = contrast(fg!, bg!)
        expect(c, `${theme} 主色按钮（${state} = ${bg}）白字对比度 ${c.toFixed(2)}:1，要求 ≥4.5:1`).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

/* ---------------- 判据 3：引用完整性 ---------------- */

describe('引用完整性', () => {
  it('文件内每个 var(--lnk-*) 引用都必须有定义', () => {
    const defined = new Set([
      ...blocks.base.decls.keys(),
      ...blocks.dark.decls.keys(),
      ...blocks.light.decls.keys(),
    ])
    const referenced = new Set<string>()
    for (const m of css.matchAll(/var\(\s*(--lnk-[a-z0-9-]+)/g)) referenced.add(m[1]!)

    expect(referenced.size, '必须扫到引用（否则是正则失效的假绿）').toBeGreaterThan(20)

    const dangling = [...referenced].filter((r) => !defined.has(r))
    expect(
      dangling,
      `引用了但未定义的 token（整条声明会静默失效）：${dangling.join(', ')}`,
    ).toEqual([])
  })
})

/* ---------------- 判据 5：非文本对比度（WCAG 1.4.11，3:1） ---------------- */

describe('非文本对比度：焦点环与状态边框（WCAG 1.4.11，≥3:1）', () => {
  // 焦点环看不清是最常见的 A11y 回归：诊断实测本项目 8 处 outline:none 无替代样式。
  // 这里锁的是"焦点色本身"够不够亮，实现侧还必须真的画出来（见 Design_system.md §6）。
  for (const theme of ['dark', 'light'] as const) {
    for (const token of ['--lnk-border-focus', '--lnk-error'] as const) {
      it(`${theme} · ${token}`, () => {
        const scope = blocks[theme]
        const fg = resolve(token, scope)
        expect(fg, `${theme} 缺 ${token}（或引用了未定义变量）`).toBeTruthy()
        let worst = Number.POSITIVE_INFINITY
        for (const s of SURFACES) {
          const bg = resolve(s, scope)
          expect(bg, `${theme} 缺 ${s}`).toBeTruthy()
          worst = Math.min(worst, contrast(fg!, bg!))
        }
        expect(
          worst,
          `${theme} 主题 ${token} 最差非文本对比度 ${worst.toFixed(2)}:1（要求 ≥3:1）`,
        ).toBeGreaterThanOrEqual(3)
      })
    }
  }
})

/* ---------------- 判据 4：非颜色阶梯 ---------------- */

describe('非颜色阶梯', () => {
  const num = (name: string) => {
    const v = blocks.base.decls.get(name)
    expect(v, `缺 ${name}`).toBeTruthy()
    return parseFloat(v!)
  }

  it('间距全部为 4 的倍数', () => {
    const spaces = Array.from(blocks.base.decls.keys())
      .filter((k) => /^--lnk-space-\d+$/.test(k))
      .map((k) => num(k))
    expect(spaces.length, '必须解析出间距档位').toBeGreaterThanOrEqual(10)
    const offGrid = spaces.filter((v) => v % 4 !== 0)
    expect(offGrid, `脱离 4px 网格的间距：${offGrid.join(', ')}`).toEqual([])
  })

  it('圆角阶梯单调递增', () => {
    const seq = ['--lnk-radius-xs', '--lnk-radius-sm', '--lnk-radius-md', '--lnk-radius-lg', '--lnk-radius-xl', '--lnk-radius-2xl'].map(num)
    for (let i = 0; i < seq.length - 1; i++) {
      expect(seq[i + 1]!, `圆角在 ${i} 档未递增：${seq.join(' < ')}`).toBeGreaterThan(seq[i]!)
    }
  })

  it('层级阶梯单调递增', () => {
    const seq = ['--lnk-z-base', '--lnk-z-canvas-ui', '--lnk-z-chrome', '--lnk-z-dock', '--lnk-z-popover', '--lnk-z-overlay', '--lnk-z-modal', '--lnk-z-toast', '--lnk-z-debug'].map(num)
    for (let i = 0; i < seq.length - 1; i++) {
      expect(seq[i + 1]!, `层级在 ${i} 档未递增：${seq.join(' < ')}`).toBeGreaterThan(seq[i]!)
    }
  })

  it('动效时长阶梯单调递增', () => {
    const seq = ['--lnk-duration-instant', '--lnk-duration-fast', '--lnk-duration-base', '--lnk-duration-slow', '--lnk-duration-slower'].map(num)
    for (let i = 0; i < seq.length - 1; i++) {
      expect(seq[i + 1]!, `时长在 ${i} 档未递增`).toBeGreaterThan(seq[i]!)
    }
  })

  it('正文行高 ≥1.45，标题行高 ≤1.35', () => {
    const body = ['--lnk-text-2xs', '--lnk-text-xs', '--lnk-text-sm', '--lnk-text-base', '--lnk-text-md']
    const head = ['--lnk-text-2xl', '--lnk-text-3xl', '--lnk-text-4xl']
    for (const b of body) {
      const size = num(b)
      const lh = num(b.replace('--lnk-text-', '--lnk-lh-'))
      expect(lh / size, `${b} 行高比 ${(lh / size).toFixed(2)} 低于 1.45`).toBeGreaterThanOrEqual(1.45)
    }
    for (const h of head) {
      const size = num(h)
      const lh = num(h.replace('--lnk-text-', '--lnk-lh-'))
      expect(lh / size, `${h} 行高比 ${(lh / size).toFixed(2)} 高于 1.35`).toBeLessThanOrEqual(1.35)
    }
  })

  it('控件尺寸满足最小点击目标', () => {
    expect(num('--lnk-control-sm')).toBeGreaterThanOrEqual(32)
    expect(num('--lnk-control-md')).toBeGreaterThanOrEqual(40)
    expect(num('--lnk-control-lg')).toBeGreaterThanOrEqual(48)
    expect(num('--lnk-touch-target')).toBeGreaterThanOrEqual(44)
  })
})

/**
 * 品牌锚点锁定 + 一处已知偏差（F-5）。
 *
 * 品牌渐变 `#6d5dfc → #8a5cf6 → #b45cf0` 是品牌评审过的资产，两个主题同值。
 * 但它的**亮端承载白字时达不到 AA**：实测
 *   白字压起点 #6d5dfc = 4.54 ✅｜中段 #8a5cf6 = 4.25 ❌｜终点 #b45cf0 = 3.67 ❌
 *
 * ⛔ 这是「已测量、已知、待品牌决策」的偏差，不是 bug 修复项：
 *    改渐变 = 动品牌资产；不改 = `.btn-primary` 的渐变末端白字低于 AA。
 *    下面只锁「不许更糟」（≥3:1 大字 AA），真正的取舍记在 Design_system.md F-5。
 */
describe('品牌锚点', () => {
  it('⛔ 品牌渐变的三个色标不得漂移', () => {
    // 渐变定义在 L2（两主题各一份同值），不在 :root 基础块里
    const g = blocks.dark.decls.get('--lnk-accent-gradient') ?? ''
    for (const stop of ['#6d5dfc', '#8a5cf6', '#b45cf0']) {
      expect(g.toLowerCase(), `品牌渐变缺少色标 ${stop}`).toContain(stop)
    }
  })

  it('品牌渐变亮端承载白字：当前 3.67:1（低于 AA 4.5，已记录为 F-5）——不得跌破大字 AA 3:1', () => {
    const ratio = contrast('#ffffff', '#b45cf0')
    expect(
      ratio,
      `白字压渐变末端只有 ${ratio.toFixed(2)}:1。已知偏差（F-5），但不得低于 3:1 —— 否则连大字都不可读`,
    ).toBeGreaterThanOrEqual(3)
  })
})
