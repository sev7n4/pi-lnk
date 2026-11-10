/**
 * CanvasPage 历史失败分窗的页面级接线契约（T12 / T3 / T9 的静态部分）。
 *
 * 为什么需要静态契约：`dismissNodeFailure`、`buildStudioRecordPatch`、失败 toast 的
 * watch 都定义在 CanvasPage.vue 内部（6815 行页面壳，无法在 vitest 里低成本整页挂载）。
 * 纯函数判据由 `historicalFailure.test.ts` / `useGenerationFailureToast.test.ts` 行为级覆盖，
 * 这里只钉住「页面有没有把判据接上、有没有走既有持久化通路」——
 * 任一接线被删都必须转红，避免纯函数绿了但页面没用上的假闭环。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// jsdom 环境下 import.meta.url 是 http scheme，fileURLToPath 会抛
// "The URL must be of scheme file" ⇒ 按 vitest cwd 定位（兼容从仓库根跑）。
const SRC_PATH = [
  join(process.cwd(), 'src/pages/CanvasPage.vue'),
  join(process.cwd(), 'apps/web/src/pages/CanvasPage.vue'),
].find(existsSync)
if (!SRC_PATH) throw new Error('CanvasPage.vue 未找到：静态契约判据无法读取实现源码')
const SRC = readFileSync(SRC_PATH, 'utf8')

/** 取页面内某个顶层函数体（顶格 `}` 结束），用于限定锚点搜索范围。 */
function topLevelFnBody(signature: string): string {
  const start = SRC.indexOf(signature)
  if (start < 0) return ''
  const end = SRC.indexOf('\n}\n', start + signature.length)
  return end > start ? SRC.slice(start, end) : ''
}

describe('CanvasPage 历史失败分窗接线（静态契约）', () => {
  it('T9 buildStudioRecordPatch 接入历史失败降级判据', () => {
    const body = topLevelFnBody('function buildStudioRecordPatch(')
    expect(body).toContain('resolveHistoricalFailurePatch(')
    expect(body).toContain('if (historicalPatch) return historicalPatch')
  })

  it('失败 toast watch 快照透传 failureScope（第二道抑制能读到节点标记）', () => {
    expect(SRC).toContain('failureScope: n.data?.failureScope')
  })

  it('T3 watch 的 prev === undefined 保护仍在 shouldToastForFailure 之前', () => {
    const guard = SRC.indexOf('if (prev === undefined) continue')
    const call = SRC.indexOf('shouldToastForFailure(prev, cur)')
    expect(guard).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(call)
  })

  it('T12 页面提供忽略回调，且忽略只走 patchNodeData + saveCanvas', () => {
    expect(SRC).toContain('provide(CANVAS_NODE_DISMISS_FAILURE_KEY, dismissNodeFailure)')
    const body = topLevelFnBody('function dismissNodeFailure(')
    expect(body).toContain('resolveDismissFailurePatch(')
    expect(body).toContain('patchNodeData(nodeId, dismissPatch)')
    expect(body).toContain('saveCanvas()')
  })
})
