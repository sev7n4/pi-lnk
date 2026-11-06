import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * presentation/ 令牌守卫（Ruling 3）。
 *
 * 抓 NodeTileView.vue:920-921 那类「真实渲染组件里的裸色」——design-token.test.ts
 * 只解析 design-tokens.css，扫不到 .vue 的 <style scoped>，故补这一道。
 *
 * 规则：presentation/ 下**非 --neo- 遗留文件**的 <style scoped> 不允许出现裸 hex / rgba。
 *  - 裸色一律走 --lnk-* 令牌；var(--x, #fallback) 里的 fallback 不算裸色（先剔除）。
 *  - 含 --neo- 的文件是历史遗留（沿用旧设计变量 + 自带 fallback），整文件豁免，
 *    不在此守卫范围（避免误伤无关旧代码）。
 */
const HERE = dirname(fileURLToPath(import.meta.url))

function scopedBareColors(source: string): string[] {
  const style = /<style scoped>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? ''
  // 先剥 CSS 注释，再剥 var(... 含 fallback) 表达式，避免误判 fallback 颜色。
  const stripped = style
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/var\([^)]*\)/g, '')
  const hits: string[] = []
  for (const m of stripped.matchAll(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g)) {
    hits.push(m[0])
  }
  return hits
}

describe('presentation/ 样式令牌守卫', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.vue'))

  it('每个非 --neo- 遗留组件的 scoped 样式无裸 hex / rgba', () => {
    const violations: Array<{ file: string; colors: string[] }> = []
    for (const f of files) {
      const abs = join(HERE, f)
      const src = readFileSync(abs, 'utf8')
      if (src.includes('--neo-')) continue // 历史遗留，整文件豁免
      const hits = scopedBareColors(src)
      if (hits.length) violations.push({ file: f, colors: hits })
    }
    expect(
      violations,
      violations.map((v) => `${v.file}: ${v.colors.join(', ')}`).join('\n'),
    ).toHaveLength(0)
  })

  it('guard 自身有效：NodeTileView 不应含有裸色（回归此前 920-921 裸色问题）', () => {
    const src = readFileSync(join(HERE, 'NodeTileView.vue'), 'utf8')
    expect(src.includes('--neo-')).toBe(false)
    expect(scopedBareColors(src)).toHaveLength(0)
  })
})
