// A1b（2026-10-22）：画布节点「加入 Agent 引用」锚在移动端常显。
//
// 背景：桌面端该锚是 hover/选中/focus 才显形的幽灵态（opacity:0 + pointer-events:none）。
// 移动端没有 hover，用户必须「先选中节点」才知道有这个锚 —— 这是 attachment 相
// 素材入口不可发现的一环。
//
// 判据卡「移动端常显 + PC 契约不动」，不卡具体数值：
//  ① @media (max-width: 767px) 内该锚显形且可点
//  ② 基线规则（媒体查询外）仍保持隐藏 —— PC 观感契约不得被顺手改掉
//  ③ 常显后仍是幽灵态（透明底），不得套 hi-bg 实心盘 —— 否则画布上每个节点
//     都亮一个盘，与「选中才点亮」的既有语义冲突。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'neo-node.css'), 'utf8')

const SELECTOR = '.neo-node-agent-add--title'

/**
 * 取某选择器在给定范围内的第一条规则体（到第一个 } 为止）。
 *
 * ⚠️ 必须锚定行首（`^[\t ]*选择器 {`），不能用 indexOf：CSS 里有更靠前的
 * **组合选择器**也以同一段文本结尾（如 `.neo-node-wrapper:hover .neo-node-agent-add--title {`），
 * indexOf 会命中它 ⇒ 读到的规则体完全不是基线的那条，判据直接失真。
 */
function ruleBody(scope: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = scope.match(new RegExp(`^[\\t ]*${escaped}\\s*\\{`, 'm'))
  if (!m || m.index === undefined) return ''
  const brace = m.index + m[0].length - 1
  return scope.slice(brace, scope.indexOf('}', brace))
}

const mqStart = css.indexOf('@media (max-width: 767px)')
const mobileBlock = mqStart < 0 ? '' : css.slice(mqStart, css.indexOf('\n}', mqStart))

describe('A1b 节点引用锚移动端常显', () => {
  it('移动端媒体查询内该锚显形且可点', () => {
    const mobile = ruleBody(mobileBlock, SELECTOR)
    expect(mobile).toContain('opacity: 1')
    expect(mobile).toContain('pointer-events: auto')
  })

  it('PC 基线仍隐藏：hover 显形契约未被改动', () => {
    // 存在性配对：先确认基线规则还在，再确认它仍是隐藏的
    const base = ruleBody(css, SELECTOR)
    expect(base).toContain('opacity: 0')
    expect(base).toContain('pointer-events: none')
  })

  it('常显后保持幽灵态：不套 hi-bg 实心盘', () => {
    // ⚠️ 本文件**任何位置**（含注释）都不要写完整的 neowow 旧令牌前缀字面量：
    // 棘轮（neoUsageRatchet.test.ts）扫描 src 下所有 .ts/.vue/.css 统计该前缀
    // 出现次数、只许减不许增，且只排除它自身 —— 写全了会让全仓计数 +1，直接破闸门。
    // （本注释因此只能写「旧令牌前缀」而不能写全。）'hi-bg' 已足够表意。
    const mobile = ruleBody(mobileBlock, SELECTOR)
    expect(mobile).not.toContain('hi-bg')
  })
})
