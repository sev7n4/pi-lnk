import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

/**
 * 2026-11-22 临时阶段条（spec 2026-11-22-turn-phase-progress-design.md §6/§9.1-2）：
 * 阶段小结 = 临时进度 + 完成时收口 —— streaming 且未收口才渲染；收口/历史轮整块消失；
 * 无真实数据不渲染（禁 0/0 占位）；令牌只用 --lnk-*（禁 --neo-* / --lnk-hi-* 状态色）。
 */

const parts: TimelinePart[] = [
  { kind: 'tool', id: 'k1', toolName: 'get_canvas_summary', status: 'done', ms: 800 },
  { kind: 'tool', id: 'k2', toolName: 'upsert_media_node', status: 'running' },
] as TimelinePart[]
const mountStrip = (streaming: boolean, ps: TimelinePart[] = parts) =>
  mount(AgentTurnTimeline, { props: { parts: ps, streaming, canvasNodes: [] } })

describe('AgentTurnTimeline — 临时阶段条', () => {
  it('streaming=true 才渲染，三阶段顺序 + 格式（「状态」· statusLabel）', () => {
    const w = mountStrip(true)
    const strip = w.find('[data-testid="turn-phase-strip"]')
    expect(strip.exists()).toBe(true)
    const rows = strip.findAll('.turn-phase-strip__row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('「探索中」')
    expect(rows[0]!.text()).toContain('已完成')
    expect(rows[0]!.text()).toContain('小结：')
    expect(rows[1]!.text()).toContain('「创作中」')
    expect(rows[1]!.text()).toContain('进行中')
    expect(rows[2]!.text()).toContain('待开始')
    expect(w.text()).not.toContain('0/0')
  })

  it('streaming=false（历史轮）整块消失，既有摘要 notice 仍在', () => {
    const withSummary = [
      ...parts,
      { kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张 · 用时 2s', tone: 'info' },
    ] as TimelinePart[]
    const w = mountStrip(false, withSummary)
    expect(w.find('[data-testid="turn-phase-strip"]').exists()).toBe(false)
    expect(w.text()).toContain('已生成 1 张')
  })

  it('收口（notice:turn-summary 到达）后 strip 消失而摘要保留（streaming 仍 true 的竞态）', () => {
    const finalized = [
      ...parts,
      { kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张', tone: 'info' },
    ] as TimelinePart[]
    const w = mountStrip(true, finalized)
    expect(w.find('[data-testid="turn-phase-strip"]').exists()).toBe(false)
    expect(w.text()).toContain('已生成 1 张')
  })

  it('taskProgress 传入时 detail 出现在活跃阶段；不传不造数', () => {
    const withProp = mount(AgentTurnTimeline, {
      props: {
        parts, streaming: true, canvasNodes: [],
        taskProgress: {
          items: [{ id: '1', title: '写脚本', activeForm: '正在编写脚本', status: 'running' }],
          finished: false,
        },
      },
    })
    expect(withProp.find('[data-testid="turn-phase-strip"]').text()).toContain('正在编写脚本')
    expect(mountStrip(true).find('[data-testid="turn-phase-strip"]').text()).not.toContain('正在编写脚本')
  })

  it('阶段条只用 --lnk-* 令牌，不含 --neo-* / --lnk-hi-*', () => {
    const css = wStyle()
    expect(css).toMatch(/--lnk-accent-subtle|--lnk-text-secondary/)
    expect(css).not.toMatch(/--neo-|--lnk-hi-bg|--lnk-hi-text/)
  })
})

function wStyle() {
  // 源码契约：样式块内令牌白名单（组件 DS 大，不做渲染态计算）
  const src = readFileSync(resolve(__dirname, 'AgentTurnTimeline.vue'), 'utf8')
  return src.slice(src.indexOf('.turn-phase-strip'), src.indexOf('</style>'))
}
