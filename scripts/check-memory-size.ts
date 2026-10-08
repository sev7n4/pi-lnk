#!/usr/bin/env tsx
/**
 * 记忆字符护栏：扫描 MEMORY.md 是否超过配额，超限即非零退出。
 *
 * 设计依据：docs/superpowers/specs/2026-10-08-workbuddy-three-layer-memory-design.md §4.1（G1–G3）
 *   - L3 工作区记忆 MEMORY.md ≤ 3000 字符
 *   - L2 个人记忆   MEMORY.md ≤ 4000 字符
 *   超出即被注入截断（高频判据反而读不全）—— 这是主动约束，不是 bug。
 *
 * 计数：Unicode 码点（[...s].length），并去除结尾单个换行；emoji 代理对按 1 字符计。
 *
 * 用法：
 *   pnpm memory:check                 # 扫描默认两处（仓库内 L3 + 家目录 L2）
 *   node scripts/check-memory-size.ts # 同上，等价于 pnpm 入口
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = resolve(process.cwd())

interface Check {
  label: string
  file: string
  limit: number
}

/** 仓库内 L3 + 家目录下所有 L2（user-*-personal） */
function findTargets(): Check[] {
  const targets: Check[] = []
  const l3 = resolve(ROOT, '.workbuddy/memory/MEMORY.md')
  targets.push({ label: 'L3 工作区记忆 (.workbuddy/memory/MEMORY.md)', file: l3, limit: 3000 })

  const wbHome = resolve(homedir(), '.workbuddy')
  if (existsSync(wbHome)) {
    for (const d of readdirSync(wbHome)) {
      if (/^user-.*-personal$/.test(d)) {
        const f = join(wbHome, d, 'MEMORY.md')
        if (existsSync(f)) {
          targets.push({ label: `L2 个人记忆 (~/.workbuddy/${d}/MEMORY.md)`, file: f, limit: 4000 })
        }
      }
    }
  }
  return targets
}

function countChars(p: string): number {
  let s = readFileSync(p, 'utf8')
  if (s.endsWith('\n')) s = s.slice(0, -1)
  return [...s].length
}

function main(): void {
  const targets = findTargets()
  let errors = 0
  for (const t of targets) {
    if (!existsSync(t.file)) {
      console.log(`○ 跳过（不存在）：${t.label}`)
      continue
    }
    const n = countChars(t.file)
    const pct = ((n / t.limit) * 100).toFixed(0)
    if (n > t.limit) {
      console.log(`✗ ${t.label}：${n} 字符 > 硬限 ${t.limit}（${pct}%）—— 超限！注入会被截断`)
      errors++
    } else if (n > t.limit * 0.85) {
      console.log(`! ${t.label}：${n} 字符 / 硬限 ${t.limit}（${pct}%）—— 接近上限，建议压缩`)
    } else {
      console.log(`✓ ${t.label}：${n} 字符 / 硬限 ${t.limit}（${pct}%）`)
    }
  }

  if (errors > 0) {
    console.log(
      `\n记忆字符护栏：发现 ${errors} 处超限。请压缩 MEMORY.md（数字/file:line 下沉 MEMORY-details.md），再提交。`,
    )
    process.exit(1)
  }
  console.log('\n记忆字符护栏：全部在配额内。')
}

main()
