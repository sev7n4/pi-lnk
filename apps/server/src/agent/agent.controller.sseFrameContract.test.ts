/**
 * A1（P1a，计划 2026-11-11-sse-event-firstclass-p1a.md §1.3）：`GET /runs/events`
 * SSE 帧契约静态源码测试——剥注释后扫描，防注释假绿。
 *
 * 判据：
 *   1. runEvents 端点写 `retry: 3000` 帧，且位于 `: observer-ready` 注释帧**之前**
 *      （浏览器须在建立期拿到重连间隔）；
 *   2. flag-off 旧主流 SSE 分支（chat/conversation 的兼容回滚面）**不含** retry 写行
 *      ——该分支有「逐字节不变」承诺（controller 内注释钉死）。
 *
 * 变异自检：删 retry 写行 ⇒ RED（人工执行：去掉该行后跑本文件应红）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 锚定本文件位置（不受 vitest cwd 影响）：与 agent.controller.ts 同级于 src/agent/。 */
const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'agent.controller.ts')

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+\/\/.*$/gm, '')
}

describe('A1 · /runs/events SSE 帧契约（P1a retry 行）', () => {
  const raw = readFileSync(FILE, 'utf8')
  const code = stripComments(raw)

  it('runEvents 写 retry: 3000 且先于 observer-ready 注释帧', () => {
    expect(code).toContain(`res.write('retry: 3000\\n\\n')`)
    const retryIdx = code.indexOf(`res.write('retry: 3000\\n\\n')`)
    const readyIdx = code.indexOf(`res.write(': observer-ready\\n\\n')`)
    expect(retryIdx).toBeGreaterThan(-1)
    expect(readyIdx).toBeGreaterThan(-1)
    expect(retryIdx).toBeLessThan(readyIdx)
  })

  it('retry 写行落在 runEvents 端点体内（@Get("runs/events") 之后、下一个端点装饰器之前）', () => {
    const start = code.indexOf(`@Get('runs/events')`)
    const nextEndpoint = code.indexOf(`@Post('sessions/:sessionId/answers')`)
    const retryIdx = code.indexOf(`res.write('retry: 3000\\n\\n')`)
    expect(start).toBeGreaterThan(-1)
    expect(nextEndpoint).toBeGreaterThan(start)
    expect(retryIdx).toBeGreaterThan(start)
    expect(retryIdx).toBeLessThan(nextEndpoint)
  })

  it('flag-off 旧主流 SSE 分支不含 retry 写行（逐字节不变回滚面）', () => {
    const legacyBranch = code.slice(code.indexOf(`@Post('chat/conversation')`))
    expect(legacyBranch).not.toContain(`res.write('retry: 3000\\n\\n')`)
  })
})
