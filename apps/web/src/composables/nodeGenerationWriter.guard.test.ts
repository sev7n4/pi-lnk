/**
 * 节点生成终态写者 ratchet 守卫（P1-B B2 包，spec 2026-11-01-p1b-generation-job-design §4.3）。
 *
 * 结构事实（2026-11-01 B2 侦察实锤，修正 SDD B3 判据措辞）：
 * - Nest 无画布节点推送通道（persist 只落库）；studio 手动生成线完成回调不回写节点
 *   （controller 注释明说 "client polls"）⇒ 前端轮询投影（applyStudioRecord）是手动
 *   生成路径**唯一**的终态呈现机制，不可撤除。
 * - 因此 B3 的治本落点 = 判定权收归 Nest（U6 无产物翻失败在 complete 系与 run-audio 结算点）
 *   + 前端投影纯化（applyStudioRecord 不再本地判定）+ 本守卫 ratchet 防再生长。
 *
 * 白名单分类（14+1 处，逐类理由）：
 * - 投影（SSOT record → 节点 data）：applyStudioRecord completed 投影、buildPollingFailurePatch
 * - Nest 不可见失败兜底（Nest 永远看不到这次尝试，前端是唯一见证者）：patchGenerationError
 *   （API 失败）、模型停用/blob/audioOnly 本地校验、平台回退取消缺 id/cancel 请求失败/
 *   material 面取消（Nest materialService 不广播画布）、fallback 处理 catch
 * - 结算等待超时兜底（waitForRunGroupMemberSettled）
 *
 * 新增终态写点 ⇒ 计数上涨 ⇒ 本守卫红 ⇒ 必须来此登记理由或撤除（ratchet 纪律）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const TERMINAL_WRITE_PATTERN =
  /status: (NODE_GENERATION_STATUS\.(completed|error)|['"](?:completed|error)['"])/g

/** 文件 → 允许的终态写点数（ratchet：只许减不许增）。 */
const RATCHET: Record<string, number> = {
  'useNodeGeneration.ts': 14,
  '../utils/generationDiagnostic.ts': 1,
  '../utils/generationPollGate.ts': 0,
}

/** U6 本地判定回归锁：这些符号已被收归 Nest（B2），任何形式回归都违规。 */
const BANNED_SYMBOLS = ['describeCompletedWithoutOutput', 'noOutputNotice']

function countMatches(rel: string): number {
  const src = readFileSync(join(HERE, rel), 'utf8')
  // 剥注释与测试面：只扫代码行（单行剥 // 注释）
  const code = src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  return [...code.matchAll(TERMINAL_WRITE_PATTERN)].length
}

describe('节点生成终态写者 ratchet（P1-B B2）', () => {
  it('终态写点数不超过 ratchet 白名单（新增必须来此登记）', () => {
    for (const [rel, allowed] of Object.entries(RATCHET)) {
      const n = countMatches(rel)
      expect(
        n,
        `${rel} 终态写点 ${n} > 白名单 ${allowed}。节点生成终态写者收敛是 P1-B B3 判据：` +
          `新增写点必须在 nodeGenerationWriter.guard.test.ts 登记理由（Nest 不可见兜底/投影），` +
          `或收归 Nest（走 persist 广播/record 投影）。`,
      ).toBeLessThanOrEqual(allowed)
    }
  })

  it('U6 本地判定符号不得回归（判定权已收归 Nest complete*/run-audio 结算点）', () => {
    for (const rel of Object.keys(RATCHET)) {
      const src = readFileSync(join(HERE, rel), 'utf8')
      for (const sym of BANNED_SYMBOLS) {
        expect(
          src.includes(sym),
          `${rel} 出现被收归的本地判定符号 ${sym}——U6 判定权在 Nest（studio.service complete* ` +
            `与 agent-canvas-tools run-audio 结算点），前端只投影 record.status。`,
        ).toBe(false)
      }
    }
  })

  it('Nest U6 判定锚在位（防误删；本测试与 Nest 改动同包落地）', () => {
    // 相对 web 目录向上到仓库根；CI 与本地均在仓库根跑，路径锚定 worktree 结构。
    const root = join(HERE, '../../../..')
    const studioSrc = readFileSync(
      join(root, 'apps/server/src/studio/studio.service.ts'),
      'utf8',
    )
    expect(
      studioSrc.includes('U6 判定收归 Nest'),
      'studio.service complete* 的 U6 判定注释锚丢失——无产物翻失败链的判定被误删会导致 ' +
        'completed 无产物回归（2026-10-04 教训）。',
    ).toBe(true)
    const canvasSrc = readFileSync(
      join(root, 'apps/server/src/agent/agent-canvas-tools.service.ts'),
      'utf8',
    )
    expect(
      canvasSrc.includes('U6 判定收归 Nest'),
      'run-audio 结算点 U6/终态投影修正锚丢失。',
    ).toBe(true)
  })
})
