import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-10-14 生产反馈（阻塞等待确认时历史对话无法上下滑动）—— **2026-10-09 已修过一次，本次是复发**。
 *
 * 复发机制（2026-10-09 的修复没解决根因，只是打了一处补丁）：
 *   `.agent-input-area--scrollable` 的 max-height 限高**一直存在**（AgentSideRail.vue 样式区），
 *   但启用条件 `hasDockPresentation = showCancelledCallout`（:923）**只认「已停止」态**。
 *   该判定的注释自证了退化过程：「2026-10-06：门控/定稿卡片全部下线，只剩『已停止』提示仍钉在这里」
 *   —— 限高条件从结构不变量（「dock 有内容」）退化成内容枚举（「dock 里只有取消提示」）。
 *   ⇒ propose 等待确认 / ask 卡 / 活跃 live timeline **全部退回无上限**：
 *   `agent-input-area`(shrink-0) 被撑高 ⇒ `chat-wrap`(flex-1 min-h-0) 压到 0 高 ⇒ 历史既看不见也滑不动。
 *
 * 2026-10-09 的修复只给 `AgentExecutionTrace(dense)` 的步骤 `<ul>` 加了 max-height，
 * 而阻塞期实际走的是**没有任何上限**的 `AgentTurnTimeline(dense)` ⇒ 修了通电的那根线。
 *
 * 本测试锁**结构不变量**而非具体魔数：
 *   只要 dock 出现任一展示态，就必须限高 —— 未来新增任何 dock 内容自动受保护。
 * 上一轮的回归测试锁的是「单个组件的 style 字符串」，新组件一诞生就绕过了它（本次复发即证据）。
 */

const sideRail = readFileSync(
  resolve(__dirname, 'AgentSideRail.vue'),
  'utf8',
)

/** 取出 hasDockPresentation 的 computed 定义体。 */
function dockLimitGate(): string {
  const m = sideRail.match(/const hasDockPresentation = computed\(([\s\S]*?)\n\)/)
  expect(m, 'AgentSideRail.vue 应仍有 hasDockPresentation 判定').toBeTruthy()
  return m![1]
}

describe('AgentSideRail — dock 限高门控必须是结构不变量（防 2026-10-09 同类复发）', () => {
  it('限高限定的展示态包含 live timeline（阻塞期钉底内容，无上限会撑爆滚动区）', () => {
    const gate = dockLimitGate()
    expect(
      gate,
      `hasDockPresentation 必须把 liveTimeline 计入（阻塞期钉底活体内容当前无 max-height）；实际判定=${gate.trim()}`,
    ).toMatch(/liveTimeline/)
  })

  it('限高限定的展示态包含 propose 等待态（用户反馈的原始复现场景）', () => {
    const gate = dockLimitGate()
    expect(
      gate,
      `hasDockPresentation 必须把 proposeWait 计入（等待确认时 dock 必须限高）；实际判定=${gate.trim()}`,
    ).toMatch(/proposeWait/)
  })

  it('限高判定不得只认「已取消」一种展示态（那是 2026-10-06 的退化起点）', () => {
    const gate = dockLimitGate()
    expect(
      gate,
      `hasDockPresentation 不能等价于 showCancelledCallout —— 该退化正是本次复发根因；实际判定=${gate.trim()}`,
    ).not.toMatch(/^\s*=>\s*showCancelledCallout\.value\s*$/)
  })

  it('CSS 侧限高仍然存在（门控修好也不可删样式，二者互为防线）', () => {
    expect(sideRail).toContain('.agent-input-area--scrollable')
    expect(sideRail).toMatch(/agent-input-area--scrollable[\s\S]{0,200}max-height/)
  })
})
