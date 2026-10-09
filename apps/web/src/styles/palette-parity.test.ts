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
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  CARD_BG,
  NODE_FILL,
  NODE_STROKE,
  SEVERITY,
  TEXT_FILL,
} from '../../../../services/pi-runtime/src/graph/palette.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKENS_CSS = join(HERE, '..', 'styles', 'neowow-tokens.css')
const css = readFileSync(TOKENS_CSS, 'utf8')

/** 取某个主题区块内的 CSS 变量值（深色 `:root` 或浅色 `[data-canvas-theme='light']`）。 */
function varIn(theme: 'dark' | 'light', name: string): string | undefined {
  // 先切出主题区块，再在其中找变量，避免跨区块串色
  const lightStart = css.indexOf(":root[data-canvas-theme='light']")
  expect(lightStart, 'neowow-tokens.css 必须含浅色主题区块（否则下面全部读不到 = 空转）').toBeGreaterThan(0)
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
})
