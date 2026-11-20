/**
 * 回归守卫（2026-11-20）：连线删除剪刀必须锚在 flow 坐标，随 viewport 重投影。
 *
 * 事故：onEdgeClick 把 getEventCoords 的 clientX/Y（点击瞬间屏幕像素）直接存进
 * selectedEdgePos。剪刀按钮 absolute 定位、不随连线走；一旦 pan/zoom，连线移到新屏幕
 * 位置、剪刀仍钉在旧像素 ⇒ 视觉上「剪刀飘到连线外」（生产 CDP 实测：点击时二者同为
 * 493,103；滚轮缩小后连线中点 y=-76，剪刀仍 y=103）。
 *
 * 修复契约：① 点击锁 flow 锚点（screenToFlowCoordinate）；② viewport 变化时用
 * flowToScreenCoordinate 重投影；③ 初始渲染仍用 clientX/Y（容器锚视口 0,0）。
 * 这是纯坐标接线，用源码断言锁死；行为级验证走生产 CDP。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, 'CanvasPage.vue'), 'utf8')
const overlay = readFileSync(join(here, '..', 'components', 'canvas', 'EdgeScissorsOverlay.vue'), 'utf8')

function fnBody(name: string): string {
  const start = page.indexOf(`function ${name}(`)
  expect(start, `必须能定位 function ${name}`).toBeGreaterThan(-1)
  // 跳过参数列表（可能含对象解构 { edge, event }）：从参数闭括号后找函数体起始 {
  const parenEnd = page.indexOf(')', start)
  const brace = page.indexOf('{', parenEnd)
  let depth = 0
  for (let i = brace; i < page.length; i++) {
    if (page[i] === '{') depth++
    else if (page[i] === '}') {
      depth--
      if (depth === 0) return page.slice(brace, i + 1)
    }
  }
  throw new Error(`function ${name} 未闭合`)
}

describe('CanvasPage 连线剪刀锚定（flow 坐标 + viewport 重投影）', () => {
  it('存在独立的 flow 锚点 state，且与屏幕绘制 state 分离', () => {
    expect(page).toMatch(/const selectedEdgeFlowPos = ref\(\{ x: 0, y: 0 \}\)/)
    expect(page).toMatch(/const selectedEdgePos = ref\(\{ x: 0, y: 0 \}\)/)
  })

  it('onEdgeClick 锁 flow 锚点（经 screenToFlowPoint），不再直接把 clientX/Y 当锚', () => {
    const body = fnBody('onEdgeClick')
    expect(body).toContain('selectedEdgeFlowPos.value = screenToFlowPoint(coords.x, coords.y)')
    // 屏幕坐标只用于首帧绘制；锚点不得再直接赋 clientX/Y
    expect(body).not.toMatch(/selectedEdgeFlowPos\.value\s*=\s*\{\s*x:\s*coords\.x/)
  })

  it('reprojectSelectedEdge 用 flowToScreenCoordinate 把锚点投影回屏幕', () => {
    const body = fnBody('reprojectSelectedEdge')
    expect(body).toContain('flowToScreenCoordinate(selectedEdgeFlowPos.value)')
    expect(body).toContain('selectedEdgePos.value =')
    // 只在有选中连线时投影，避免空转
    expect(body).toContain('if (!selectedEdgeId.value) return')
  })

  it('onViewportChange 调用重投影（pan/zoom 后剪刀跟连线走）', () => {
    const body = fnBody('onViewportChange')
    expect(body).toContain('reprojectSelectedEdge()')
    expect(body).toContain('viewportTracker.note(payload)')
  })

  it('模板把 selectedEdgePos（重投影后的值）传给剪刀组件', () => {
    expect(page).toMatch(/<EdgeScissorsOverlay[\s\S]{0,200}:x="selectedEdgePos\.x"[\s\S]{0,80}:y="selectedEdgePos\.y"/)
  })

  it('剪刀组件本身仍是 absolute + translate-center 定位（投影坐标语义不变）', () => {
    expect(overlay).toContain('absolute')
    expect(overlay).toContain('-translate-x-1/2 -translate-y-1/2')
    expect(overlay).toContain(':style="{ left: `${x}px`, top: `${y}px` }"')
  })
})
