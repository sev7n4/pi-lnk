// P1-6.1 / P1-6.2（Task 11）：--neo-* 消费棘轮
//
// 棘轮语义：components/agent/** 内 --neo-* 出现次数只允许减少、不允许增加。
// 基线 = Task 11 实施前实测（grep -oE '\-\-neo-' components/agent 递归 *.vue/*.ts
// 出现次数 = 379；此前 B12 的 157 是行计数口径，出现次数口径更严，故重测）。
// 每清扫一批就把 NEO_BASELINE 手工下调到新实测值——只允许调低。
//
// 注：守卫自身文件不计入——本文件含字面 `--neo-` 正则与注释，会污染计数。
// 注：brief 里的 `__dirname` 在 vitest ESM 下不存在，这里用 fileURLToPath(import.meta.url)。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const SELF = 'neoUsageRatchet.test.ts'

function countNeoTokens(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countNeoTokens(p)
    else if (e.name !== SELF && (e.name.endsWith('.vue') || e.name.endsWith('.ts')))
      n += (readFileSync(p, 'utf8').match(/--neo-/g) ?? []).length
  }
  return n
}

// Task 11 实施前实测 379（AgentSideRail.vue 141 处已全部迁 --lnk-*，本批 -141）。
// 清扫后实测 238。只允许下调。
const NEO_BASELINE = 238

describe('--neo-* usage ratchet (P1-6.2 / B12)', () => {
  it('count in components/agent only decreases', () => {
    expect(countNeoTokens(here)).toBeLessThanOrEqual(NEO_BASELINE)
  })
})

describe('composer token sweep (P1-6.1)', () => {
  it('AgentSideRail.vue contains zero --neo-*（composer 迁移完成后全文件清零）', () => {
    const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
    expect(sfc.match(/--neo-/g) ?? []).toEqual([])
  })
})
