/**
 * run 失败零感知修复（2026-11-17，U-3 活体复测未竟的根因刀）。
 *
 * 生产实证（CMV 观察流抓帧）：model_not_found 失败轮的 Nest observer SSE **已经**
 * 派生 `error` 事件（seq 13，message=404 model_not_found）——Nest/runtime 链路无缺陷。
 * UI 静默的断裂层在前端：失败轮全程无 text_delta ⇒ assistant 消息压根不被创建 ⇒
 * `case 'error'` 里的 `agent.appendText('⚠️ …')` 走「无 assistant 消息时静默 no-op」
 * 分支（stores/agent.ts appendText），用户屏幕上什么都不出现。
 *
 * 修复：改走 `appendTurnNotice`（store 既有兜底通道——先确保 assistant 消息存在
 * 再落文本，2026-10-07 LaneBusy 零事件生产事故的专用修复，见
 * agent.zeroEventNotice.test.ts）。与那次事故同构：零文本失败轮 = 零事件轮。
 *
 * ⚠️ AgentSideRail.vue 是 3000 行 SFC，挂载代价远高于收益（observerWiring 既有
 * 结论）⇒ 沿用「静态接线契约」范式锁住本刀。断言前 stripComments，防注释假绿。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const sfcCode = stripComments(sfc)

/** `case 'error'` 分支块（非贪婪匹配到首个 4 空格缩进的块结束）。 */
const errorCase = sfcCode.match(/case 'error': \{[\s\S]*?\n    \}/)?.[0] ?? ''

describe('AgentSideRail case error：失败轮文案必须走兜底通道（零感知修复）', () => {
  it('① error 分支用 appendTurnNotice（无 assistant 消息时也保证可见）', () => {
    expect(errorCase, '必须能定位 case error 分支块').not.toBe('')
    expect(errorCase, '失败轮可能零文本（无 assistant 消息），appendText 会静默 no-op').toContain(
      'agent.appendTurnNotice(',
    )
  })

  it('② error 分支不得残留裸 appendText（静默 no-op 即本刀根因）', () => {
    expect(errorCase).not.toContain('agent.appendText(')
  })

  it('③ friendly 文案映射仍在（model_not_found 桶别被顺手删掉）', () => {
    expect(errorCase).toContain('friendlyAssistantError(')
  })
})
