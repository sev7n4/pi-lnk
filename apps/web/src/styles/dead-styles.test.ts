import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 死样式棘轮（2026-10-13）：确认删除的 CSS 类不得复活。
 * 首条：`.neo-media-info-summary--overlay`（PR #385 资产 hover 层删规格条后
 * 全库无模板引用，遗留死块）。复活的正确方式是连引用一起加回——届时应删本锚。
 */
const DEAD_SELECTORS = ['.neo-media-info-summary--overlay']

describe('死样式棘轮：已清理的 CSS 选择器不得复活', () => {
  it('neo-node.css 不含已清死的 --overlay 修饰类', () => {
    const css = readFileSync(join(HERE, 'neo-node.css'), 'utf8')
    for (const sel of DEAD_SELECTORS) {
      expect(css, `${sel} 已确认为死样式，不得回潮`).not.toContain(sel)
    }
    // 有效性断言：基类仍在（证明读对了文件，防空集假绿）
    expect(css).toContain('.neo-media-info-summary {')
  })
})
