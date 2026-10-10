/**
 * 主题用法守卫 —— 两件事：
 *
 * **A. 棘轮（ratchet）**：深色专用写法只许减少、不许增加。
 *    一次性清完 46k 行不现实，但「不许更糟」是可以立刻执行的。
 *    基线在 `theme-usage-baseline.json`，每清扫一批就手工下调并把数字写进 PR 说明。
 *
 * **B. 机制不变量**：防止主题机制被搬回懒加载模块（历史缺陷，见 index.html 注释）。
 *
 * ## 为什么是「计数 ≤ 基线」而不是「必须为 0」
 *
 * 写 0 会立刻红、且红得没有信息量 —— 剩下 500+ 处是背景/描边/渐变，
 * 语义各不相同，不能靠 codemod 盲改（改错背景色比不改更糟）。
 * 棘轮保证的是**方向**：新增代码不许再引入深色专用写法。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')
const WEB_ROOT = join(HERE, '..', '..')

const BASELINE: Record<string, number> = JSON.parse(
  readFileSync(join(HERE, 'theme-usage-baseline.json'), 'utf8'),
)

const PATTERNS: Record<string, RegExp> = {
  'text-white': /text-white/g,
  'bg-black': /bg-black/g,
  'bg-white-slash': /bg-white\//g,
  'border-white-slash': /border-white\//g,
  'arbitrary-hex': /(?:text|bg|border)-\[#/g,
  'brand-blue-6366f1': /#6366f1/gi,
  'brand-blue-818cf8': /#818cf8/gi,
  'inline-rgba': /rgba\(/g,
}

/**
 * 一次遍历读完并把 8 个模式全统计完。
 *
 * ⛔ 早期写法是「每个模式各自扫一遍全盘」= 182 个文件被读了 8 次，
 *    首条用例实测 5.9s，超过 vitest 默认 5s 超时 ⇒ **在 CI 慢机器上必然 flake**。
 *    而且它红的方式是「Test timed out」，看不出到底是超时还是真超标，误导排查。
 */
function scanAll(dir: string): Record<string, number> {
  const acc: Record<string, number> = {}
  for (const k of Object.keys(PATTERNS)) acc[k] = 0

  const files: string[] = []
  ;(function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.vue')) files.push(p)
    }
  })(dir)

  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const [name, re] of Object.entries(PATTERNS)) {
      re.lastIndex = 0
      const m = src.match(re)
      if (m) acc[name]! += m.length
    }
  }
  return acc
}

const FILE_COUNT = (function countVue(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countVue(p)
    else if (e.name.endsWith('.vue')) n += 1
  }
  return n
})(SRC)

const COUNTS = scanAll(SRC)

describe('深色专用写法棘轮（只许减少）', () => {
  it('⛔ 守卫自身有效：扫描到的 .vue 文件数 > 100（否则全是空转）', () => {
    expect(
      FILE_COUNT,
      '一个 .vue 都没扫到 —— 路径错了，下面每条断言都会「恒过且零证据」',
    ).toBeGreaterThan(100)
  })

  it('⛔ 守卫自身有效：COUNTS 里至少有一个非零（防止统计逻辑空转）', () => {
    const nonzero = Object.entries(COUNTS).filter(([, v]) => v > 0)
    expect(
      nonzero.length,
      '所有模式统计都是 0 —— 要么正则写错，要么根本没读到文件',
    ).toBeGreaterThan(0)
  })

  it('⛔ 基线文件里每一条模式都有对应实现（防止基线写了却没人统计）', () => {
    for (const key of Object.keys(PATTERNS)) {
      expect(BASELINE[key], `基线缺少 ${key}`).toBeTypeOf('number')
    }
  })

  for (const name of Object.keys(PATTERNS)) {
    it(`${name}：${BASELINE[name]} → 不得增加`, () => {
      const actual = COUNTS[name]!
      expect(
        actual,
        `${name} 从基线 ${BASELINE[name]} 涨到 ${actual}。\n` +
          `新增代码不应引入深色专用写法 —— 请改用语义类（text-fg / bg-surface-* / border-line-*）。\n` +
          `若本批是有意清扫，请同步下调 theme-usage-baseline.json 并在 PR 里写明。`,
      ).toBeLessThanOrEqual(BASELINE[name]!)
    })
  }

  it('⛔ text-white 在 .vue 中必须是 0（白字在浅色主题下直接消失）', () => {
    expect(COUNTS['text-white']).toBe(0)
  })
})

describe('主题机制不变量', () => {
  const html = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8')

  it('⛔ index.html 必须在首屏前同步设置主题（不得依赖任何懒加载模块）', () => {
    // 历史缺陷：主题曾由 useCanvasTheme.ts 的模块级副作用设置，而该模块只被 CanvasPage
    // import，17 条路由全懒加载 ⇒ 16 条永不求值 ⇒ 主题属性从未落地。
    const script = html.slice(0, html.indexOf('</head>'))
    expect(script, '引导脚本必须在 </head> 之前').toContain("setAttribute('data-theme'")
    expect(script, '必须尊重系统偏好 prefers-color-scheme').toContain('prefers-color-scheme')
    expect(script, '必须读用户显式选择').toContain("localStorage.getItem('lnkpi-canvas-theme')")
  })

  it('⛔ 不得再出现旧属性名（两个属性 = 两个真相源）', () => {
    // 拆开写是为了不让它匹配到本文件自身
    const legacy = 'data-' + 'canvas-theme'
    const hits: string[] = []
    ;(function walk(d: string) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.vue') && readFileSync(p, 'utf8').includes(legacy)) hits.push(p)
      }
    })(SRC)
    for (const f of ['index.html', 'tailwind.config.js']) {
      if (readFileSync(join(WEB_ROOT, f), 'utf8').includes(legacy)) hits.push(f)
    }
    for (const f of ['styles/neowow-tokens.css', 'styles/neo-node.css', 'styles/main.css']) {
      if (readFileSync(join(SRC, f), 'utf8').includes(legacy)) hits.push(f)
    }
    expect(hits, `这些文件还在用旧属性名 ${legacy}`).toEqual([])
    // 全量读 .vue（182 个）。正常机器 <1s，但本仓沙箱每次 readFileSync 有约 29ms
    // 固定开销（实测 547 文件 = 14.9s，且热读不打折），并发下会翻数倍 ⇒
    // 沿用 randomId.guard.test.ts 的先例显式放宽，避免「Test timed out」这种
    // 看不出是超时还是真超标的红。
  }, 30000)

  it('⛔ useCanvasTheme.ts 不得在模块顶层调用 applyTheme（副作用不许回来）', () => {
    const src = readFileSync(join(SRC, 'composables/useCanvasTheme.ts'), 'utf8')
    const topLevel = src
      .split('\n')
      .filter((l) => /^applyTheme\(/.test(l))
    expect(
      topLevel,
      '模块级副作用会让主题再次依赖「该模块是否被 import」，而它只被画布页 import',
    ).toEqual([])
  })

  it('⛔ design-tokens.css 必须被 main.css 引入（Tailwind 颜色类全是 var(--lnk-*)）', () => {
    const main = readFileSync(join(SRC, 'styles/main.css'), 'utf8')
    expect(
      main,
      '缺失时不会报错，只会静默产出没有颜色的规则 —— 这正是本项目最难查的一类 bug',
    ).toContain("@import './design-tokens.css'")
  })
})

/**
 * `neowow-tokens.css` 的浅色缺口守卫。
 *
 * 深色块定义了 65 个变量，浅色块此前只覆写了 51 个 ⇒ 14 个「静默沿用深色值」。
 * 其中 `--neo-electric #22d3ee` 压白底只有 1.7:1、`--neo-warm #f59e0b` 约 2.1:1
 * ⇒ 浅色主题下这些强调色等于看不见，且不报任何错。
 */
describe('neowow-tokens.css 浅色覆写完整性', () => {
  /** 主题无关的变量（尺寸 / 模糊半径 / 圆角）：不需要浅色覆写，进了白名单就不会红。 */
  const THEME_NEUTRAL = [
    '--neo-agent-expanded-width',
    '--neo-agent-rail-width',
    '--neo-glass-blur',
    '--neo-glass-lite-blur',
    '--neo-header-height',
    '--neo-radius-lg',
    '--neo-radius-md',
    '--neo-sidebar-width',
  ]

  function keysIn(scope: string): string[] {
    return [...scope.matchAll(/^\s*(--neo-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!)
  }

  it('⛔ 除白名单外，深色块的每个变量都要有浅色覆写', () => {
    const css = readFileSync(join(SRC, 'styles/neowow-tokens.css'), 'utf8')
    const at = css.indexOf(":root[data-theme='light']")
    expect(at, '找不到浅色主题区块').toBeGreaterThan(0)
    const dark = new Set(keysIn(css.slice(0, at)))
    const light = new Set(keysIn(css.slice(at)))

    expect(dark.size, '守卫自身：深色块应当读到一整套变量，否则下面恒过').toBeGreaterThan(50)

    const missing = [...dark].filter((k) => !light.has(k)).sort()
    const unexpected = missing.filter((k) => !THEME_NEUTRAL.includes(k))
    expect(
      unexpected,
      `这些变量只在深色块有定义，浅色主题会静默沿用深色值：\n` +
        `  ${unexpected.join('\n  ')}\n` +
        `若确实是主题无关的（尺寸/模糊/圆角），请加进 THEME_NEUTRAL 白名单。`,
    ).toEqual([])
  })

  it('白名单里的变量确实都是主题无关的（防止有人把颜色塞进白名单绕过）', () => {
    expect(THEME_NEUTRAL.every((k) => !/color|bg|text|border|accent|electric|warm|shadow/.test(k))).toBe(
      true,
    )
  })
})
