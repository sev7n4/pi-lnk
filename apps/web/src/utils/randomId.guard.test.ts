import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 静态守卫：web 侧源码**不得**直接调用 `crypto.randomUUID()`。
 *
 * 该 API 只在安全上下文（HTTPS / localhost）存在，生产 CVM 是明文
 * `http://ip:port` → 同步抛 TypeError。历史上已被踩两次（canvasEditor、
 * useSelectionGenerate），第三次发生在 /answers 提交路径：用户点完选项卡
 * 一律「提交失败，请重试」，而 nginx 侧 0 条请求记录（请求没发出去）。
 * 统一走 `randomId()`（内置降级），这条守卫负责防止再犯。
 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|vue|js)$/.test(entry)) out.push(full)
  }
  return out
}

/** 逐行去掉行注释与跨行的块注释（块状态跨行保持），避免把说明文案判成真实调用。 */
function* stripComments(lines: string[]): Generator<string> {
  let inBlock = false
  for (const raw of lines) {
    let s = raw
    if (inBlock) {
      const end = s.indexOf('*/')
      if (end < 0) {
        yield ''
        continue
      }
      s = s.slice(end + 2)
      inBlock = false
    }
    for (;;) {
      const start = s.indexOf('/*')
      if (start < 0) break
      const end = s.indexOf('*/', start + 2)
      if (end < 0) {
        s = s.slice(0, start)
        inBlock = true
        break
      }
      s = s.slice(0, start) + s.slice(end + 2)
    }
    const lineStart = s.indexOf('//')
    if (lineStart >= 0) s = s.slice(0, lineStart)
    yield s
  }
}

describe('web 源码不得直接调用 crypto.randomUUID', () => {
  it('无裸调用（注释与测试文本除外）', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file)
      if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      // 只认「带左括号的真实调用」，说明文案里的 `crypto.randomUUID` 名词不算
      Array.from(stripComments(lines)).forEach((line, i) => {
        if (line.includes('crypto.randomUUID(')) {
          offenders.push(`${rel}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
    // 遍历 src 全量文件，宽放超时（默认 5s 在慢机器上会误报）
  }, 30000)
})
