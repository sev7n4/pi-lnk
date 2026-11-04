import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * C8 静态契约（规格 2026-11-03-credit-consumption-display-design.md §14.5）：
 * 渠道前缀 key（`platform::<model>` / `ch_<id>::<model>`）是渠道路由的内部结构，
 * 绝不允许出现在用户可见文案。本守卫全目录扫描 `apps/web/src`：
 * - `*.test.ts` 与 `model-display.ts`（映射器本体）整体白名单；
 * - 其余文件的**注释行**允许（文档取证需要引用违规样本），
 *   **代码行**出现即红（变异测试：在任意源码行加一个模板字面量即触发）。
 * 改白名单 = 审计动作（沿用 #689 纪律）。
 */

const SRC_ROOT = join(__dirname, '..')
const ALLOWLIST_FILES = new Set(['utils/model-display.ts'])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(ts|vue)$/.test(name)) yield p
  }
}

/** 注释行判定：trim 后以 //、* 、/* 开头（覆盖行注释与块注释延续行）。 */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

describe('C8 静态契约：渠道前缀 key 不进用户可见文案', () => {
  it('apps/web/src 非白名单源码的代码行不出现 platform:: / ch_xxx:: 前缀字面量', () => {
    const violations: string[] = []
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split('\\').join('/')
      if (rel.endsWith('.test.ts') || rel.endsWith('.test-d.ts')) continue
      if (ALLOWLIST_FILES.has(rel)) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return
        if (line.includes('platform::') || /ch_[A-Za-z0-9_-]+::/.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
        }
      })
    }
    expect(
      violations,
      `渠道前缀 key 泄漏到代码行（应经 utils/model-display.ts 的 resolveModelDisplayName 映射）：\n${violations.join('\n')}`,
    ).toEqual([])
  }, 30_000)

  it('变异自检：映射器本体确实剥前缀（防守卫与实现同时腐化）', async () => {
    const { stripChannelPrefix } = await import('./model-display')
    expect(stripChannelPrefix('platform::agnes-2.5-flash')).toBe('agnes-2.5-flash')
  })
})
