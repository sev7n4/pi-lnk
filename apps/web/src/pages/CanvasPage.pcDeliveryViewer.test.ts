// PC 对话产物 tile → 共享查看器接线契约（2026-11-23）
//
// 病根：AgentTurnTimeline.onDeliveryTileOpen 的 inject 在 CanvasPage 无条件 provide 下
// 必然命中，状态写进 mobileViewerNode；但唯一消费者 MobileCanvasShell 被
// v-if="isMobileLayout" 挡住 ⇒ PC 点击静默 no-op，focusNode 降级分支永远进不去。
// 本契约锁死「桌面也必须有消费者，且复用共享 NodeViewerView，不新造查看器」。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

/** 剥注释：本仓注释里会写同名标签/处理器，全文扫描会假绿。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('PC 产物查看器（D-c 桌面闭环）', () => {
  const page = stripComments(read('./CanvasPage.vue'))

  it('复用 presentation/NodeViewerView，不新建 PC 专用查看器', () => {
    expect(page).toContain("import NodeViewerView from '@/components/agent/presentation/NodeViewerView.vue'")
  })

  it('桌面分支消费 viewer 状态：!isMobileLayout + mobileViewerNode + close 回写', () => {
    const tag = page.match(/<NodeViewerView[\s\S]*?\/>/)?.[0] ?? ''
    expect(tag, 'CanvasPage 必须挂载 PC viewer，否则 tile 点击静默 no-op').not.toBe('')
    for (const needle of [
      '!isMobileLayout',
      'mobileViewerNode',
      ':type="mobileViewerNode.type"',
      ':data="mobileViewerNode.data"',
      '@close="closeMobileViewer"',
    ]) {
      expect(tag, `PC viewer 接线须含 ${needle}`).toContain(needle)
    }
  })

  it('viewer 注入键在 CanvasPage 仍无条件 provide（前提事实，防再次误判「桌面 inject 缺省」）', () => {
    expect(page).toContain('provide(MOBILE_NODE_OPEN_VIEWER_KEY')
  })
})
