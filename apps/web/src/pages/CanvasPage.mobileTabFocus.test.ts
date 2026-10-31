/**
 * C3（2026-10-31 皮皮虾回合真机反馈防回归）：移动端切画布页签必须自动定位待确认节点。
 *
 * 事故：propose_generation 阻塞等待期，用户从对话页切到画布页找确认入口——
 * 画布停在原视口，皮皮虾节点（可能在视口外）无任何引导，用户找不到确认入口。
 * 修法：onMobileTabChange('canvas') 时若 store.pendingProposal 锚定了节点且已上屏，
 * 自动 focusNodeById 一次（fitView + 定位闪烁）；未上屏（canvas_action 在途）静默跳过
 * ——focusNodeById 的「未找到」warning 只该给显式点击。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../pages/CanvasPage.vue'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const code = stripComments(src)

function fnBlock(signature: string): string {
  const re = new RegExp(`${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\\}`)
  return code.match(re)?.[0] ?? ''
}

describe('CanvasPage 移动端切画布页签自动定位待确认节点（C3）', () => {
  it('onMobileTabChange("canvas") 必须读 pendingProposal 锚点并自动 focusNodeById', () => {
    const block = fnBlock('function onMobileTabChange(tab: MobileAppTab)')
    expect(block, '必须能定位 onMobileTabChange').toContain("tab === 'canvas'")
    expect(block, '必须读 proposal part 锚定的节点（等待态第一真相）').toContain(
      'pendingProposal?.nodeId',
    )
    expect(block, '必须调用 focusNodeById 自动定位').toContain('focusNodeById(waitNodeId)')
    expect(block, '必须先确认节点已上屏（canvas_action 在途时静默跳过）').toContain(
      'nodes.value.some((n) => n.id === waitNodeId)',
    )
  })
})
