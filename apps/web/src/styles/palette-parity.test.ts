/**
 * 跨端调色板一致性守卫（§238 / §4.2）
 *
 * ## 为什么需要这条测试
 *
 * §238 原文：
 *   ⛔ 不允许静态图是一套配色、节点图是另一套——那正是历史上「两套逻辑必然漂移」的复发。
 *
 * 现状（2026-10-09 起修）：pi-runtime 侧已有 `graph/palette.ts` 作为**唯一真相源**，
 * 而 `neowow-tokens.css` 的 graph 相关色值**仍是独立手写的一套**——
 * 同一语义（如「节点描边」「卡片底」）在两侧各有一个 hex，改一侧另一侧不会响。
 *
 * ## 为什么用「测试锁一致性」而不是「共享模块」
 *
 * ⛔ **pi-runtime 物理上不能依赖 `@lnkpi/shared`**：
 *   - `services/pi-runtime/src/independence.test.ts` 有两条 CI 守卫
 *     （源码零 import + package.json 零声明），违反即失败；
 *   - Dockerfile 只 `COPY services/pi-runtime/`，不 COPY `packages/shared`；
 *   - 源码注释明写「不能加：会改镜像构建链」。
 * 这是**有意的架构决策**：pi-runtime 要能被整体摘出去独立部署。
 *
 * ⇒ 所以「单一来源」只能是**pi-runtime 侧的定义 + 本测试的一致性约束**，
 *   而不是两处 import 同一个模块。测试就是那个「不会漂移」的执行机制。
 *
 * ## 为什么不用 CSS 变量做唯一来源
 *
 * pi-runtime 产出的是**内联 SVG 字符串**（要塞进 `canvasCommands[].svg`），
 * 无法消费 CSS 自定义属性 ⇒ 颜色必须以 TS 常量存在。
 * 反向从 CSS 抽色值再喂给 SVG 需要构建期生成，反而引入第二套机制。
 *
 * ## 判据
 *
 * 锁「**语义对**」而非「逐字节相同」：
 * - 浅色主题下 node 描边 / 卡片底 / 文本色必须等于 palette.ts 的对应常量；
 * - 深色主题下 node 底色必须是**非纯白**（§4.2(3) 硬判据：纯白落深底 = 刺眼白块）。
 *
 * ## 为什么深色也要逐字节锁（2026-10-09 补）
 *
 * 此前深色只有两条**结构**断言（"非纯白"、"与卡片底不同色"），
 * 实测这两条在旧值上全过，而旧值的真实表现是：
 *
 *   `--neo-node-border: rgba(255,255,255,0.08)` 合成后 #303036
 *     vs 合成节点底 #222229 = **1.21:1**
 *
 * ⇒ 节点边界**几乎不可见**，但结构断言完全测不出来。
 * 这就是「锁结构不锁数值」的典型假绿：断言问"是不是纯白"，
 * 缺陷却是"描边对比度差 19倍"。故深色改为**逐字节 + 实测 WCAG比值**双重锁。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

import {
  CARD_BG,
  DARK_CARD_BG,
  DARK_CONTAINER_STROKE,
  DARK_NODE_FILL,
  DARK_NODE_STROKE,
  DARK_TEXT_FILL,
  NODE_FILL,
  NODE_STROKE,
  SEVERITY,
  SEVERITY_DARK,
  TEXT_FILL,
} from '../../../../services/pi-runtime/src/graph/palette.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKENS_CSS = join(HERE, '..', 'styles', 'neowow-tokens.css')
const css = readFileSync(TOKENS_CSS, 'utf8')

/**
 * WCAG 2.1 相对亮度。
 *
 * 🔴 修过一次真缺陷（2026-10-10）：蓝通道系数曾是 **0.2992**，WCAG sRGB 规定是 **0.0722**。
 *    实测偏差最大 3.58（`#131318`/`#a89dff`：正确 7.88 vs 旧式 11.46），
 *    且偏差方向随含蓝量变化 ⇒ 对含蓝高的颜色**系统性偏高** ⇒ 不达标的配色会被判成达标（假绿）。
 *    本轮 7 条既有断言在两种公式下都恰好通过，所以它是**潜伏**风险而非已爆雷——
 *    但一条会系统性放水的守卫，它给的绿灯没有证据力。
 *
 * ⛔ 不要把它抽出去共享给 `design-token.test.ts`：后者需要一份**独立实现**互为交叉验证，
 *    共享一处实现会让「公式写错」这类缺陷同时骗过两边。
 */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`不是 6 位 hex：${hex}`)
  const n = parseInt(m[1]!, 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}

describe('守卫自身：亮度公式必须是 WCAG sRGB（防止再被写成 0.2992）', () => {
  // 这条直接锁系数本身：纯蓝的相对亮度按定义就等于蓝通道系数。
  // 若有人把 0.0722 改回 0.2992，这条**必然**先红，而不是等某条对比度断言碰巧翻车。
  it('纯蓝 #0000ff 的相对亮度 == 蓝通道系数 0.0722', () => {
    expect(luminance('#0000ff')).toBeCloseTo(0.0722, 4)
  })

  it('纯黑 0 / 纯白 1（sRGB 归一化端点）', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1, 6)
  })

  it('与 WCAG 参考值对齐：#777777 亮度 0.1845', () => {
    expect(luminance('#777777')).toBeCloseTo(0.1845, 3)
  })
})

/** WCAG 对比度。⛔ 别用不带 +0.05 的简写公式，会算出 0.22:1 这类假报警。 */
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

/** 取某个主题区块内的 CSS 变量值（深色 `:root` 或浅色 `[data-theme='light']`）。 */
function varIn(theme: 'dark' | 'light', name: string): string | undefined {
  // 先切出主题区块，再在其中找变量，避免跨区块串色
  const lightStart = css.indexOf(":root[data-theme='light']")
  expect(
    lightStart,
    'neowow-tokens.css 必须含浅色主题区块（否则下面全部读不到 = 空转）',
  ).toBeGreaterThan(0)
  const scope = theme === 'light' ? css.slice(lightStart) : css.slice(0, lightStart)
  const m = scope.match(new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'm'))
  return m?.[1]?.trim()
}

describe('跨端调色板一致性（§238：静态图与节点图不得两套配色）', () => {
  it('浅色主题：节点描边 / 卡片底 / 文本色与 palette.ts 一致', () => {
    expect(varIn('light', '--neo-graph-card-bg'), '卡片底漂移').toBe(CARD_BG)
    expect(varIn('light', '--neo-node-border'), '节点描边漂移').toBe(NODE_STROKE)
    expect(varIn('light', '--neo-text-primary'), '文本色漂移').toBe(TEXT_FILL)
  })

  it('浅色主题：节点底色是纯白（§4.2(3) 硬判据）', () => {
    const bg = varIn('light', '--neo-node-card-bg')
    expect(bg, '--neo-node-card-bg 在浅色主题下必须有定义').toBeTruthy()
    // 允许 rgba(255,255,255,a) 或 #fff —— 但底色本身必须是白
    const white = /^#fff(fff)?$/i.test(bg!) || /^rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/i.test(bg!)
    expect(white, `浅色主题节点底应为白（palette NODE_FILL=${NODE_FILL}），实际 ${bg}`).toBe(true)
  })

  it('⛔ 深色主题：节点底色禁止纯白（§4.2(3)：纯白落深底 = 刺眼白块）', () => {
    const bg = varIn('dark', '--neo-node-card-bg')
    expect(bg, '--neo-node-card-bg 在深色主题下必须有定义').toBeTruthy()
    const isPureWhite =
      /^#fff(fff)?$/i.test(bg!) ||
      /^rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*1(\.0+)?\s*\)/i.test(bg!)
    expect(
      isPureWhite,
      `深色主题节点底禁止纯白 ${bg} —— 这正是旧 SVG 卡片「字看不清 / 刺眼」的根因（§4.2(3)）`,
    ).toBe(false)
  })

  it('深色主题：节点底色与卡片底不同色（§4.2(3)：节点要比卡片亮一档）', () => {
    const nodeBg = varIn('dark', '--neo-node-card-bg')
    const cardBg = varIn('dark', '--neo-graph-card-bg')
    expect(nodeBg).toBeTruthy()
    expect(cardBg).toBeTruthy()
    expect(nodeBg, '节点底与卡片底同色 ⇒ 节点边界消失').not.toBe(cardBg)
  })

  it('severity 两档在 CSS 里都有定义，且与 palette.ts 一致', () => {
    for (const level of ['error', 'warn'] as const) {
      const v = varIn('light', `--neo-severity-${level}`)
      expect(v, `浅色主题必须定义 --neo-severity-${level}（§4.2(1) 强调色层）`).toBeTruthy()
      expect(v, `--neo-severity-${level} 漂移`).toBe(SEVERITY[level].stroke)
    }
    expect(SEVERITY.error.stroke).not.toBe(SEVERITY.warn.stroke) // 靠色相区分，不是亮度
  })

  it('⛔ 守卫自身有效：CSS 变量真能读到（防止上面全是空转）', () => {
    for (const name of ['--neo-graph-card-bg', '--neo-node-border', '--neo-text-primary']) {
      expect(varIn('light', name), `自检失败：浅色主题读不到 ${name}`).toBeTruthy()
      expect(varIn('dark', name), `自检失败：深色主题读不到 ${name}`).toBeTruthy()
    }
  })

  it('⛔ neowow-tokens.css 是合法 CSS（postcss 能解析）', () => {
    // 实战踩坑（2026-10-09）：在一个 /* … */ 注释内部又插了一个 /* … */，
    // 外层注释被提前闭合 ⇒ 剩余文本变成非法 CSS ⇒ postcss 报
    //「Unknown word」⇒ `vite build` 直接失败。
    // ⛔ 本地 `vite build` 可能命中缓存而不复现（我第一次就如此被骗），
    //   所以这条断言直接调postcss 解析，1 秒内暴露而不是等 CI 的 3 分钟 build。
    let err: Error | undefined
    try {
      postcss.parse(css, { from: TOKENS_CSS })
    } catch (e) {
      err = e as Error
    }
    expect(err, `neowow-tokens.css 语法错误（多半是注释嵌套/未闭合）：${err?.message}`).toBeUndefined()
  })

  it('⛔ CSS 注释没有嵌套（外层 /* 被内层 */ 提前闭合的根因）', () => {
    // 逐字符扫描：注释内出现第二个 /* 就是非法嵌套（CSS 不支持嵌套注释）
    const offenders: number[] = []
    const lines = css.split('\n')
    let inComment = false
    lines.forEach((line, idx) => {
      let i = 0
      while (i < line.length) {
        if (!inComment) {
          const open = line.indexOf('/*', i)
          if (open < 0) break
          inComment = true
          i = open + 2
        } else {
          const close = line.indexOf('*/', i)
          const nested = line.indexOf('/*', i)
          if (nested >= 0 && (close < 0 || nested < close)) offenders.push(idx + 1)
          if (close < 0) break
          inComment = false
          i = close + 2
        }
      }
    })
    expect(offenders, `这些行在注释内又开了 /*（CSS 不支持嵌套注释）：${offenders.join(', ')}`).toEqual([])
  })

})

/**
 * 深色主题 parity（2026-10-09 补）。
 *
 * ⛔ **本suite 不许断言「节点底 vs 卡片底 ≥ X」** —— 那条恒假：
 *   浅色两者本就只有 1.06:1、深色 1.17:1，**边界刻意由描边表达**
 *   （任何 ≥3:1 的底色差都要把底压到中灰，容器层会比节点还深、层次倒挂）。
 *   写这条断言的人会以为在保护对比度，实际只会逼出一个错误的视觉改版。
 */
describe('深色主题调色板一致性（§238 深色半边）', () => {
  it('深色：graph 卡片底 / 容器描边与 palette深色常量逐字节一致', () => {
    expect(varIn('dark', '--neo-graph-card-bg'), '深色卡片底漂移').toBe(DARK_CARD_BG)
    expect(varIn('dark', '--neo-graph-card-border'), '深色容器描边漂移').toBe(DARK_CONTAINER_STROKE)
  })

  it('⛔ 深色节点描边实测 ≥3:1（WCAG 非文本 AA）—— 这条锁的是数值不是结构', () => {
    // ⭐ 旧值 rgba(255,255,255,0.08) 合成后 #303036 vs 合成底 #222229 = 1.21:1，
    //   边界几乎不可见，而当时的两条结构断言全过 ⇒ 必须锁数值。
    const ratio = contrast(DARK_NODE_STROKE, DARK_NODE_FILL)
    expect(
      ratio,
      `深色节点描边 ${DARK_NODE_STROKE} vs 节点底 ${DARK_NODE_FILL} 仅 ${ratio.toFixed(2)}:1，` +
        `需≥3:1（WCAG 非文本 AA）。深底上描边是唯一边界来源，压暗= 边界消失`,
    ).toBeGreaterThanOrEqual(3)
    // vs 卡片底也要站得住（节点可能直接压在卡片上）
    expect(contrast(DARK_NODE_STROKE, DARK_CARD_BG)).toBeGreaterThanOrEqual(3)
  })

  it('⛔ 深色文本 vs 节点底实测 ≥4.5:1（WCAG 正文 AA）', () => {
    const ratio = contrast(DARK_TEXT_FILL, DARK_NODE_FILL)
    expect(
      ratio,
      `深色文本 ${DARK_TEXT_FILL} vs 节点底 ${DARK_NODE_FILL} 仅 ${ratio.toFixed(2)}:1，需 ≥4.5:1`,
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('⛔ 深色 severity 两档 vs 节点底实测 ≥3:1，且不复用浅色 hex', () => {
    for (const level of ['error', 'warn'] as const) {
      const ratio = contrast(SEVERITY_DARK[level].stroke, DARK_NODE_FILL)
      expect(
        ratio,
        `深色 severity.${level} ${SEVERITY_DARK[level].stroke} vs 节点底仅 ${ratio.toFixed(2)}:1，需 ≥3:1`,
      ).toBeGreaterThanOrEqual(3)
      // ⛔ 深底上复用浅色强调色 = 强调色沉底 ⇒ 等于没有强调
      expect(
        SEVERITY_DARK[level].stroke,
        `深色 severity.${level} 复用了浅色 hex，强调色在深底上会发闷`,
      ).not.toBe(SEVERITY[level].stroke)
    }
    // 仍靠色相区分，不是亮度（与浅色同一约束）
    expect(SEVERITY_DARK.error.stroke).not.toBe(SEVERITY_DARK.warn.stroke)
  })

  it('深色：节点底非纯白，且与卡片底不同色（§4.2(3) 结构判据仍保留）', () => {
    const bg = varIn('dark', '--neo-node-card-bg')
    expect(bg, '--neo-node-card-bg 在深色主题下必须有定义').toBeTruthy()
    expect(bg).not.toBe(DARK_CARD_BG)
  })

  it('两主题的「边界靠描边」关系一致（都不靠底色差）', () => {
    // ⭐ 这条锁的是**设计意图**：两个主题的底色差都应远低于 3:1，
    //   提醒后来者别把它当缺陷去"修"（那会让层次倒挂）。
    expect(contrast(NODE_FILL, CARD_BG)).toBeLessThan(3)
    expect(contrast(DARK_NODE_FILL, DARK_CARD_BG)).toBeLessThan(3)
  })
})
