/**
 * 重跑分支线程（fork key）的**接线契约**（multi-device Phase 1 · 2026-10-26）。
 *
 * 为什么需要静态契约：`AgentSideRail.vue` 是 3000+ 行 SFC，挂载它需要整套
 * store / fetch / auth 桩，代价远高于收益（observerWiring 同款结论）。而 fork key 的
 * 三个接线点恰恰是「多端共享对话 × ③ 重跑」正确性的全部——漏掉任何一个：
 *   - 漏 ① ⇒ 重跑结果刷新后丢失（bootstrap 弹回共享线程）；
 *   - 漏 ② ⇒ 用户显式「返回主对话」活不过一次刷新（bootstrap 弹回分支）；
 *   - 漏 ③ ⇒ bootstrap 根本不看 fork key，①②全成死代码。
 *
 * ⚠️ 断言前一律 `stripComments`：本仓把迁移说明写进注释，
 * 全文扫描会让注释里的函数名被当成代码命中（假绿）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/** 剥注释后的源码（所有断言都基于它）。 */
const code = stripComments(src)

/** `case 'thread_forked'` 分支块（到下一个 `case '` 为止）。 */
const forkedBlock = code.match(/case 'thread_forked':\s*\{[\s\S]*?break/)?.[0] ?? ''

/** `selectThread` 函数体（到下一个顶层函数声明为止）。 */
const selectThreadBlock = code.match(/async function selectThread\([\s\S]*?\n\}/)?.[0] ?? ''

describe('AgentSideRail 重跑分支线程（fork key）接线', () => {
  it('① thread_forked 到达时必须持久化分支线程（否则刷新丢重跑结果）', () => {
    expect(forkedBlock, '必须能定位 thread_forked 处理分支').toContain('agentThreadId.value = nextThreadId')
    expect(forkedBlock, '必须写 fork key（persistForkedThreadId）').toContain('persistForkedThreadId(props.sessionId, nextThreadId)')
  })

  it('② selectThread 切回共享线程时必须清 fork key（否则刷新被弹回分支）', () => {
    expect(selectThreadBlock, '必须能定位 selectThread 函数体').toContain('async function selectThread')
    expect(
      selectThreadBlock,
      '切换到共享线程（= sessionId）后必须 clearForkedThreadId，否则 resolveBootstrapThreadId 会把本端弹回重跑分支',
    ).toContain('clearForkedThreadId(props.sessionId)')
  })

  it('③ bootstrap 必须经 resolveBootstrapThreadId 收敛（不得绕过 fork key 恢复逻辑直取缓存）', () => {
    expect(code, 'bootstrapThread 必须走 resolveBootstrapThreadId').toContain(
      'agentThreadId.value = await resolveBootstrapThreadId(props.sessionId',
    )
  })
})
