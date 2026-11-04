/**
 * P3 D5：queued「排队中」徽标的渲染契约（静态——3000+ 行 SFC 不挂载，
 * 同 observerWiring 既有结论；stripComments 防注释假绿）。
 *
 * 数据链路：server getMessages 读时派生 queued → store 透传 → 气泡徽标；
 * 实时清除 = turn_ack{messageId} → agent.consumeQueued（AgentSideRail handleEvent）。
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

const code = stripComments(src)

describe('queued 徽标渲染契约（P3 D5）', () => {
  it('user 气泡内必须有 queued 徽标（role 门 + data-testid 供行为测试锚定）', () => {
    const i = code.indexOf('data-testid="queued-badge"')
    expect(i, '徽标必须存在且可被行为测试锚定').toBeGreaterThan(-1)
    // role 门：徽标 v-if 必须带 user 角色判定（assistant 行不渲染）
    const before = code.slice(Math.max(0, i - 300), i)
    expect(before, 'v-if 必须带 role 门').toContain("msg.role === 'user'")
    expect(before).toContain('msg.queued')
  })

  it('turn_ack{messageId} 必须接 consumeQueued（徽标随消费实时清除）', () => {
    const i = code.indexOf("case 'turn_ack'")
    expect(i, 'handleEvent 必须消费 turn_ack').toBeGreaterThan(-1)
    const block = code.slice(i, i + 600)
    expect(block).toContain('consumeQueued')
    // mode 门：只有裁定为并入（steer/followup）才清除（run 无排队语义）
    expect(block).toContain("d.mode !== 'run'")
    expect(block).toContain('d.messageId')
  })
})
