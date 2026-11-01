/**
 * runtime 侧节点生成终态写者硬零守卫（P1-B B2 包，spec §4.3-1）。
 *
 * B1 job 化后 runtime 工具域即返 job handle：节点终态由 Nest 落库 + 结算点直发通报，
 * runtime 不得再有任何节点 status 终态直写（waitForGenerationTerminal 等待臂 /
 * buildTerminalActions 终态广播已退役）。新增即违规——写者唯一性是 P1-C2 前置。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const FILES = ['canvas-write.ts', 'generation.ts', 'progress-ticker.ts']

/** 剥 // 行注释与 /* 块注释：守卫只扫代码（注释里的符号名提及不违规）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

// 仅节点 data patch 形态；`_signal: { status: "failed" }` 是 tool result 失败信号
// （P0-1 语义，非节点写），通过 `_signal:` 前缀排除。
const NODE_TERMINAL_PATTERN = /(?<!_signal: \{ )status: ?['"](completed|error|failed)['"]|NODE_GENERATION_STATUS/g

describe('runtime 节点终态写者硬零（P1-B B2）', () => {
  it('工具域源文件零节点 status 终态直写', () => {
    for (const f of FILES) {
      let src: string
      try {
        src = readFileSync(join(HERE, f), 'utf8')
      } catch {
        continue // progress-ticker.ts 可能已随等待臂退役
      }
      const code = stripComments(src)
      const hits = [...code.matchAll(NODE_TERMINAL_PATTERN)].map((m) => m[0])
      assert.deepEqual(
        hits,
        [],
        `${f} 出现节点终态写形态 ${JSON.stringify([...new Set(hits)])}——` +
          `生成终态写者唯一=Nest（persist + notifyTerminalNow），runtime 工具域即返 job handle。`,
      )
    }
  })

  it('等待臂符号不得回归（B1 已退役）', () => {
    for (const f of ['canvas-write.ts', 'generation.ts']) {
      const code = stripComments(readFileSync(join(HERE, f), 'utf8'))
      for (const sym of ['waitForGenerationTerminal', 'buildTerminalActions', 'withGenerationWait']) {
        assert.ok(
          !code.includes(sym),
          `${f} 出现已退役符号 ${sym}——等待臂/终态广播在 B1（PR #663）退役，不得回潮。`,
        )
      }
    }
  })
})
