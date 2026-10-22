/**
 * SP-B 对齐/分布的 **agent 通道接线**契约（AgentSideRail → CanvasPage.handleArrangeNodes）。
 *
 * ⛔ 这条链路是「对齐」在 agent 侧**唯一**的入口：AgentSideRail 收 canvas_command，
 *    转成 `arrangeNodes` 事件交给 CanvasPage 执行。若这里把 mode 收窄成
 *    'grid' | 'along_edges'，align / distribute 就永远不可达（**静默失效**：
 *    用户的「对齐」意图会被静默执行成「网格重排」）。
 *
 * 页面级 SFC 在 vitest 里直接 import 会超时（实测 environment 29s / 整文件 45s），
 * 故本文件走「读源码 + 静态断言」，与 CanvasPage.groupResize.test.ts /
 * CanvasPage.snapGuides.test.ts 同一形式。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'AgentSideRail.vue'), 'utf8')

/** 截出 arrange_nodes 分支的片段（到下一个 else if 为止）。 */
function arrangeBranch(): string {
  const start = src.indexOf("cmd.type === 'arrange_nodes'")
  expect(start, 'AgentSideRail 里找不到 arrange_nodes 分支').toBeGreaterThan(0)
  const end = src.indexOf('} else if', start + 10)
  return src.slice(start, end > 0 ? end : start + 2000)
}

describe('AgentSideRail：arrangeNodes 事件透传 align/distribute', () => {
  it('⛔ mode 原样透传，不得收窄成 grid/along_edges 两值', () => {
    const branch = arrangeBranch()
    expect(branch, 'mode 必须来自 cmd.mode（缺省才回 grid）').toContain('mode: cmd.mode ??')
    expect(
      branch,
      '⛔ 不得把非 along_edges 的 mode 收窄成 grid（会把「对齐」静默变成「网格重排」）',
    ).not.toMatch(/mode:\s*cmd\.mode\s*===\s*'along_edges'\s*\?/)
  })

  it('align 带 alignMode、distribute 带 axis（缺参不臆造）', () => {
    const branch = arrangeBranch()
    expect(branch).toMatch(
      /\.\.\.\(cmd\.mode === 'align' && cmd\.alignMode \? \{ alignMode: cmd\.alignMode \} : \{\}\)/,
    )
    expect(branch).toMatch(
      /\.\.\.\(cmd\.mode === 'distribute' && cmd\.axis \? \{ axis: cmd\.axis \} : \{\}\)/,
    )
  })

  it('事件负载类型含四 mode + alignMode + axis', () => {
    const at = src.indexOf('arrangeNodes: [payload:')
    expect(at, '找不到 arrangeNodes 事件声明').toBeGreaterThan(0)
    const decl = src.slice(at, at + 700)
    expect(decl).toContain("'grid' | 'along_edges' | 'align' | 'distribute'")
    expect(decl).toContain('alignMode?:')
    expect(decl).toContain('axis?:')
  })

  it('canvas_command 的 mode 字段类型也含四值（否则 TS 层就把 align 收窄掉了）', () => {
    const at = src.indexOf('const cmd = event.data as {')
    expect(at, '找不到 canvas_command 的 cmd 类型声明').toBeGreaterThan(0)
    const cmdType = src.slice(at, at + 1400)
    expect(cmdType).toContain("mode?: 'grid' | 'along_edges' | 'align' | 'distribute'")
    expect(cmdType).toContain('alignMode?:')
    expect(cmdType).toContain('axis?:')
  })
})
