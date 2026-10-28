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

/* ---------------- 判据 4.5：状态三件套与阴影（品牌 IP 一致性） ---------------- */

/**
 * 状态三件套（-text / -bg / -border）守卫。
 *
 * IP 语义：状态灯是「锚灯」的信号灯形态——确定性必须可读。
 * - bg 是 alpha 底色（文字对比度由"实色文字压合成底"保证，见下方合成守卫）；
 * - border 是描边，弱于文字对比度要求；
 * - 状态文字永远用实色 --lnk-{v}（AA 守卫已在"语义前景色对比度"覆盖）。
 */

/** 解析 rgba(...) 的 [r,g,b,a]；解析失败返回 null。 */
function parseRgba(raw: string): [number, number, number, number] | null {
  const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(raw)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

/** 把 rgba 前景合成到不透明底色上，返回 6 位 hex。 */
function compositeOver(fgRgba: [number, number, number, number], bgHex: string): string {
  const n = parseInt(bgHex.slice(1), 16)
  const bg = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const [r, g, b, a] = fgRgba
  const mix = (f: number, s: number) => Math.round(a * f + (1 - a) * s)
  return (
    '#' +
    [mix(r, bg[0]!), mix(g, bg[1]!), mix(b, bg[2]!)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

const STATUS_KEYS = ['success', 'warning', 'error', 'info'] as const
const SHADOW_LEVELS = ['xs', 'sm', 'md', 'lg', 'xl'] as const

describe('状态三件套（-bg / -border / 实色文字）', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const key of STATUS_KEYS) {
      it(`${theme} · ${key}：bg/border alpha 在既定域内`, () => {
        const bgRaw = blocks[theme].decls.get(`--lnk-${key}-bg`)
        const borderRaw = blocks[theme].decls.get(`--lnk-${key}-border`)
        expect(bgRaw, `${theme} 缺 --lnk-${key}-bg`).toBeTruthy()
        expect(borderRaw, `${theme} 缺 --lnk-${key}-border`).toBeTruthy()
        const bg = parseRgba(bgRaw!)
        const border = parseRgba(borderRaw!)
        expect(bg, `${theme} --lnk-${key}-bg 必须是 rgba（底色允许透明度）`).toBeTruthy()
        expect(border, `${theme} --lnk-${key}-border 必须是 rgba`).toBeTruthy()
        // 底色 tint 太重会吞掉层次（变成实色块），太轻会看不见
        expect(bg![3], `${theme} ${key}-bg alpha=${bg![3]}（要求 0.06–0.2）`).toBeGreaterThanOrEqual(0.06)
        expect(bg![3]).toBeLessThanOrEqual(0.2)
        // 描边必须比底色实，否则三件套塌成两件
        expect(border![3], `${theme} ${key}-border alpha=${border![3]}（要求 0.25–0.5）`).toBeGreaterThanOrEqual(0.25)
        expect(border![3]).toBeLessThanOrEqual(0.5)
        expect(border![3]).toBeGreaterThan(bg![3])
      })

      it(`${theme} · ${key}：实色状态文字压合成底（4 表面最差）≥ 4.5:1`, () => {
        const scope = blocks[theme]
        const fg = resolve(`--lnk-${key}`, scope)
        const bgRaw = scope.decls.get(`--lnk-${key}-bg`)
        expect(fg, `${theme} 缺 --lnk-${key}（或引用未定义）`).toBeTruthy()
        expect(bgRaw, `${theme} 缺 --lnk-${key}-bg`).toBeTruthy()
        const bgRgba = parseRgba(bgRaw!)!
        let worst = Number.POSITIVE_INFINITY
        for (const s of SURFACES) {
          const surface = resolve(s, scope)
          expect(surface, `${theme} 缺 ${s}`).toBeTruthy()
          const chipBg = compositeOver(bgRgba, surface!)
          worst = Math.min(worst, contrast(fg!, chipBg))
        }
        expect(
          worst,
          `${theme} 状态文字 ${key} 压 -bg 合成底最差 ${worst.toFixed(2)}:1（要求 ≥4.5:1）`,
        ).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

describe('状态底 hover 档（-bg-hover / -border-hover）', () => {
  // IP 语义：hover 是「锚灯变亮」——必须可感知加深，但不能深到变实色块吞掉层次。
  // 纯 alpha 加深在 AA 约束下空间不足 0.01（不可感知），故 dark 靠基色深化（400→600）、
  // light 靠 alpha 微增 + border-hover 主导。守卫判定用「合成底亮度」而非 alpha。
  for (const theme of ['dark', 'light'] as const) {
    for (const key of STATUS_KEYS) {
      it(`${theme} · ${key}-bg-hover：合成底比 -bg 更深且未成实色块`, () => {
        const scope = blocks[theme]
        const bgRaw = scope.decls.get(`--lnk-${key}-bg`)
        const hoverRaw = scope.decls.get(`--lnk-${key}-bg-hover`)
        expect(hoverRaw, `${theme} 缺 --lnk-${key}-bg-hover`).toBeTruthy()
        const bg = parseRgba(bgRaw!)
        const hover = parseRgba(hoverRaw!)
        expect(hover, `${theme} --lnk-${key}-bg-hover 必须是 rgba`).toBeTruthy()
        // 可感知加深：hover 合成底（压最暗表面 canvas）亮度必须 < bg 合成底
        const canvas = resolve('--lnk-surface-canvas', scope)
        expect(canvas, `${theme} 缺 --lnk-surface-canvas`).toBeTruthy()
        const bgLum = luminance(compositeOver(bg!, canvas!))
        const hoverLum = luminance(compositeOver(hover!, canvas!))
        expect(
          hoverLum,
          `${theme} ${key}-bg-hover 合成底亮度 ${hoverLum.toFixed(4)} 必须 < bg ${bgLum.toFixed(4)}（hover 必须可感知加深）`,
        ).toBeLessThan(bgLum)
        expect(
          hover![3],
          `${theme} ${key}-bg-hover alpha=${hover![3]} 过重会吞掉层次（要求 ≤0.3）`,
        ).toBeLessThanOrEqual(0.3)
      })

      it(`${theme} · ${key}-border-hover：比 -border 更实（主 hover 信号）`, () => {
        const scope = blocks[theme]
        const borderRaw = scope.decls.get(`--lnk-${key}-border`)
        const hoverRaw = scope.decls.get(`--lnk-${key}-border-hover`)
        expect(hoverRaw, `${theme} 缺 --lnk-${key}-border-hover`).toBeTruthy()
        const border = parseRgba(borderRaw!)
        const hover = parseRgba(hoverRaw!)
        expect(hover, `${theme} --lnk-${key}-border-hover 必须是 rgba`).toBeTruthy()
        expect(
          hover![3],
          `${theme} ${key}-border-hover alpha=${hover![3]} 必须 > border ${border![3]}`,
        ).toBeGreaterThan(border![3])
        expect(hover![3]).toBeLessThanOrEqual(0.6)
      })

      it(`${theme} · ${key}：实色状态文字压 hover 合成底（4 表面最差）≥ 4.5:1`, () => {
        const scope = blocks[theme]
        const fg = resolve(`--lnk-${key}`, scope)
        const hoverRaw = scope.decls.get(`--lnk-${key}-bg-hover`)
        expect(fg, `${theme} 缺 --lnk-${key}`).toBeTruthy()
        expect(hoverRaw, `${theme} 缺 --lnk-${key}-bg-hover`).toBeTruthy()
        const hoverRgba = parseRgba(hoverRaw!)!
        let worst = Number.POSITIVE_INFINITY
        for (const s of SURFACES) {
          const surface = resolve(s, scope)
          const chipBg = compositeOver(hoverRgba, surface!)
          worst = Math.min(worst, contrast(fg!, chipBg))
        }
        expect(
          worst,
          `${theme} 状态文字 ${key} 压 -bg-hover 合成底最差 ${worst.toFixed(2)}:1（要求 ≥4.5:1）`,
        ).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

describe('阴影（锚链）：五档成对、深海更重、档位单调加重', () => {
  for (const level of SHADOW_LEVELS) {
    it(`${level}：深色投影必须比浅色重（深海 vs 阳光海面）`, () => {
      const darkRaw = blocks.dark.decls.get(`--lnk-shadow-${level}`)
      const lightRaw = blocks.light.decls.get(`--lnk-shadow-${level}`)
      expect(darkRaw, `深色缺 --lnk-shadow-${level}`).toBeTruthy()
      expect(lightRaw, `浅色缺 --lnk-shadow-${level}`).toBeTruthy()
      const darkA = parseRgba(darkRaw!)
      const lightA = parseRgba(lightRaw!)
      expect(darkA, `深色 shadow-${level} 首段必须是 rgba`).toBeTruthy()
      expect(lightA, `浅色 shadow-${level} 首段必须是 rgba`).toBeTruthy()
      expect(
        darkA![3],
        `shadow-${level} 深色 alpha ${darkA![3]} 必须 > 浅色 ${lightA![3]}（IP：深色=无光深海，投影是唯一深度线索）`,
      ).toBeGreaterThan(lightA![3])
    })
  }

  it('深色五档 alpha 单调不降（锚链越深越沉）', () => {
    const alphas = SHADOW_LEVELS.map((lv) => {
      const raw = blocks.dark.decls.get(`--lnk-shadow-${lv}`)
      expect(raw, `深色缺 --lnk-shadow-${lv}`).toBeTruthy()
      const p = parseRgba(raw!)
      expect(p, `深色 shadow-${lv} 首段必须是 rgba`).toBeTruthy()
      return p![3]!
    })
    for (let i = 0; i < alphas.length - 1; i++) {
      expect(
        alphas[i + 1]!,
        `阴影档位 ${i}→${i + 1} 未单调加重：${alphas.join(' ≤ ')}`,
      ).toBeGreaterThanOrEqual(alphas[i]!)
    }
  })
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
    const head = ['--lnk-text-2xl', '--lnk-text-3xl', '--lnk-text-4xl', '--lnk-text-display-1', '--lnk-text-display-2', '--lnk-text-display-3']
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
 *    改渐变 = 动品牌资产；不改 = 渐变末端白字低于 AA。
 *    F-5 已处置：`.btn-primary` 改用实色 `var(--lnk-accent)`（白字压实色紫 ≥4.5 AA 达标），
 *    品牌渐变退为「英雄资产」令牌（`bg-brand-gradient`，见 tailwind.config.js），保留此锁以防其再承载小字白标。
 *    唯一合法形态：hero 大面 + dim/25 恒黑层（2026-10-20 P1 起不再绑定具名组件，改为纯令牌级契约）。
 *    真正的取舍记在 Design_system.md F-5。
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

  it('hero 位（未来白字压渐变消费方）：白字压 dim/25 恒黑合成底，全渐变 ≥ AA 4.5', () => {
    // 品牌渐变退为英雄资产后，唯一合法的「白字压渐变」形态是 hero 大面 + dim/25 恒黑层。
    // 2026-10-20 P1：中部横幅（CarouselBanner）已移除，本断言从「与组件耦合」升级为
    // 「纯令牌级契约」—— 未来任何 hero 消费方（如首屏签名画面若改用渐变）都必须满足。
    const dim = [0, 0, 0, 0.25] as [number, number, number, number]
    for (const stop of ['#6d5dfc', '#8a5cf6', '#b45cf0']) {
      const bg = compositeOver(dim, stop)
      const ratio = contrast('#ffffff', bg)
      expect(
        ratio,
        `白字压 dim/25 × ${stop} 合成底只有 ${ratio.toFixed(2)}:1（压层不足或渐变被改亮）`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

/**
 * 签名画面令牌：深海墨底三件套。
 *
 * 深底是**主题不变式**（两主题同值 #131318），所以「两主题同名成对」照常覆盖；
 * 但通用最差表面扫描（SURFACES 四表层）管不到它 —— surface-signature 不在那四层里，
 * 而它又比四表层都更深，若只靠通用扫描，把 on-signature 文字改暗也不会有人拦。
 * 故这里补一条专用对比度断言。
 */
describe('签名画面：深海墨底上的文字', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const token of [
      '--lnk-text-on-signature',
      '--lnk-text-on-signature-muted',
      '--lnk-accent-on-signature',
    ] as const) {
      it(`${theme} · ${token} 压 surface-signature ≥ AA 4.5`, () => {
        const scope = blocks[theme]
        const fg = resolve(token, scope)
        const bg = resolve('--lnk-surface-signature', scope)
        expect(fg, `${theme} 缺 ${token}`).toBeTruthy()
        expect(bg, `${theme} 缺 --lnk-surface-signature`).toBeTruthy()
        const c = contrast(fg!, bg!)
        expect(c, `${theme} ${token} 压深海墨底只有 ${c.toFixed(2)}:1，要求 ≥4.5:1`).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('surface-signature 是主题不变式：深浅两主题同值', () => {
    const dark = resolve('--lnk-surface-signature', blocks.dark)
    const light = resolve('--lnk-surface-signature', blocks.light)
    expect(dark).toBeTruthy()
    // 签名画面是「三处豁免位」之一：深海墨底不随主题翻转。
    // 若哪天它开始翻转，首屏在浅色主题下就不再是签名画面了。
    expect(light, 'surface-signature 必须深浅同值（主题不变式）').toBe(dark)
  })

  it('签名面上的容器面 surface-on-signature：主题不变式 + 托得起 on-signature 文字', () => {
    const dark = resolve('--lnk-surface-on-signature', blocks.dark)
    const light = resolve('--lnk-surface-on-signature', blocks.light)
    expect(dark, '深色主题缺 --lnk-surface-on-signature').toBeTruthy()
    expect(light, '浅色主题缺 --lnk-surface-on-signature').toBeTruthy()
    expect(light, 'surface-on-signature 必须深浅同值（主题不变式）').toBe(dark)
    // 这条正是「浅色主题下签名输入框白字压浅面静默不可见」的守卫：
    // 容器面若改成随主题翻转的浅面，on-signature 浅字对比度会跌破 AA 而被拦下。
    for (const theme of ['dark', 'light'] as const) {
      const bg = resolve('--lnk-surface-on-signature', blocks[theme])!
      const fg = resolve('--lnk-text-on-signature', blocks[theme])!
      const c = contrast(fg, bg)
      expect(
        c,
        `${theme} on-signature 文字压 surface-on-signature 只有 ${c.toFixed(2)}:1，要求 ≥4.5:1`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  /**
   * 印章（落款锚）配色：2026-10-22 用户实测指出「深色/浅色主题下锚的颜色放反了，
   * 白天应该放白色高亮的」。根因是锚盘走了 --lnk-hi-bg/--lnk-hi-text 这对
   * **随主题翻转**的令牌，而签名底是**不翻转**的恒深墨底 ⇒ 浅色主题下盘面翻成近黑，
   * 整颗锚沉进墨里。故印章配色必须是主题不变式，且与签名底有足够反差。
   */
  it('印章配色是主题不变式：盘面恒白、刻痕恒墨（深浅同值）', () => {
    for (const token of ['--lnk-stamp-face-on-signature', '--lnk-stamp-ink-on-signature'] as const) {
      const dark = resolve(token, blocks.dark)
      const light = resolve(token, blocks.light)
      expect(dark, `深色主题缺 ${token}`).toBeTruthy()
      expect(light, `浅色主题缺 ${token}`).toBeTruthy()
      expect(
        light,
        `${token} 必须深浅同值（主题不变式）：若随主题翻转，浅色下锚会反色沉进墨底`,
      ).toBe(dark)
    }
    // 刻痕压盘面：印章 glyph 是品牌主标记，必须清晰可读
    for (const theme of ['dark', 'light'] as const) {
      const face = resolve('--lnk-stamp-face-on-signature', blocks[theme])!
      const ink = resolve('--lnk-stamp-ink-on-signature', blocks[theme])!
      const c = contrast(ink, face)
      expect(
        c,
        `${theme} 印章刻痕压盘面只有 ${c.toFixed(2)}:1，要求 ≥4.5:1`,
      ).toBeGreaterThanOrEqual(4.5)
      // 盘面压签名底：这一条正是「颜色放反」的直接守卫——
      // 若盘面翻成近黑，它与恒深签名底的对比度会塌到 1.2:1 量级而被拦下。
      const onSig = contrast(face, resolve('--lnk-surface-signature', blocks[theme])!)
      expect(
        onSig,
        `${theme} 印章盘面压签名底只有 ${onSig.toFixed(2)}:1，盘面必须恒白才浮得出墨面`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

/* ============================================================
   z-index 语义阶梯（规格 2026-10-27 顶栏 §13.2/B4）
   viewer 按钮被顶栏遮挡事故的治本守卫：全屏竞争层必须消费
   令牌且保持 chrome < viewer < modal 单调。
   ============================================================ */
describe('z-index 语义阶梯消费（§13.2）', () => {
  // 既有 L1 层级阶梯（base<canvas-ui<chrome<dock<popover<overlay<modal<toast<debug）
  // 已由「非颜色阶梯 > 层级阶梯单调递增」把关；本块只锁「全屏竞争层必须消费令牌」。
  // 档位映射（§13.2/B2 v2）：三顶栏→chrome(40)、MobileNodeViewer→overlay(200)、
  // MobileSheet→modal(1000)——viewer 治本靠 Teleport（下条），z 值单调由既有阶梯保证。
  const consumers: Array<[string, string, RegExp]> = [
    ['components/mobile/MobileTopBar.vue', 'chrome', /z-index:\s*var\(--lnk-z-chrome\)/],
    ['components/canvas/WorkspaceTopBar.vue', 'chrome', /z-index:\s*var\(--lnk-z-chrome\)/],
    ['components/mobile/MobileNodeViewer.vue', 'overlay', /z-index:\s*var\(--lnk-z-overlay\)/],
    ['components/mobile/MobileSheet.vue', 'modal', /z-index:\s*var\(--lnk-z-modal\)/],
  ]
  it('全屏竞争层四文件必须消费 z 令牌，不得回写裸数字', () => {
    for (const [file, token, re] of consumers) {
      const src = readFileSync(join(HERE, '..', file), 'utf8')
      expect(src, `${file} 必须消费 var(--lnk-z-${token})`).toMatch(re)
    }
  })

  it('MobileNodeViewer 根元素必须 Teleport 到 body（§13.2/B3：脱离 shell 祖先 stacking context）', () => {
    const src = readFileSync(join(HERE, '..', 'components/mobile/MobileNodeViewer.vue'), 'utf8')
    const tpl = src.slice(src.indexOf('<template>'), src.indexOf('</template>'))
    expect(tpl).toMatch(/<Teleport to="body">/)
    // 有效性配对：viewer 根 testid 必须在 Teleport 内部（防"加了 Teleport 但包错层"）
    const tele = tpl.match(/<Teleport to="body">([\s\S]*?)<\/Teleport>/)?.[1] ?? ''
    expect(tele).toContain('data-testid="mobile-viewer"')
  })
})
