import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 只读分享页与 CanvasPage 同病：fit-view-on-init 对全部节点（含千万级离群）fitView
// ⇒ zoom 压到 minZoom 0.1，真实内容推出屏幕外（PC 画布"只剩空白"同源故障）。
// 静态契约层锁定：摘除 fit-view-on-init，首屏全览走确定性 computeContentViewport。
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'CanvasReadonlyPage.vue'), 'utf8')

describe('CanvasReadonlyPage 视口接线（静态契约）', () => {
  it('不得使用 fit-view-on-init（对离群节点全览会把内容推出视口）', () => {
    expect(source).not.toContain('fit-view-on-init')
  })

  it('首屏全览：nodes 加载后用 computeContentViewport + setViewport 确定性落位', () => {
    expect(source).toContain('computeContentViewport(')
    expect(source).toContain('setViewport?.(safeViewport, { duration: 0 })')
    // 落位必须发生在 nodes 应用之后（R5 时序）
    expect(source.indexOf('computeContentViewport(')).toBeGreaterThan(
      source.indexOf('nodes.value = (canvasRes.data.data.nodes'),
    )
  })
})
