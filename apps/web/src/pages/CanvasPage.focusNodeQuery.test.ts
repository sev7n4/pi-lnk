// A3 · 跨项目定位通道契约（2026-10-22）
//
// 背景（**误判纠正**）：本次实现前曾断言「CanvasPage 完全不读 route.query，
// query.focusNode 推过去无人消费」—— 该结论来自一次失效的 shell grep（沙箱里
// grep 对本文件返回空），**与代码事实相反**。实际 `consumeFocusNodeQuery()`
// 早已实现并被 `loadCanvas` 尾部调用。
//
// 那这个测试钉的是什么？是**接线顺序**——真正会坏的地方：
//   consumeFocusNodeQuery() 必须在**画布节点加载完成之后**调用。
//   若被挪到加载之前，nodes.value 还是空 ⇒ find 不到 ⇒ 弹「当前画布中没有找到
//   该节点」⇒ 定位静默失效（且 query 被消费掉，刷新也不再重试）。
//   这个顺序错了没有任何编译期/运行期报错，只能靠契约测试钉住。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

/** 剥注释后再定位 —— 注释里出现函数名会让 indexOf 命中叙述文本而非代码。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('A3 跨项目定位通道契约（?focusNode=）', () => {
  const page = stripComments(read('./CanvasPage.vue'))

  it('consumeFocusNodeQuery 存在且消费 route.query.focusNode', () => {
    expect(page).toContain('consumeFocusNodeQuery')
    expect(page).toMatch(/route\.query\.focusNode/)
  })

  it('⭐ 调用点必须在画布节点加载完成之后（否则定位静默失效）', () => {
    // 找到「赋值 nodes.value = ...」的加载点与 consumeFocusNodeQuery 的调用点，
    // 断言调用点在加载点之后。
    const loadIdx = page.indexOf('nodes.value =')
    const consumeIdx = page.indexOf('await consumeFocusNodeQuery()')
    expect(loadIdx, '必须能找到画布节点加载点').toBeGreaterThan(-1)
    expect(consumeIdx, '必须能找到 focusNode 消费调用点').toBeGreaterThan(-1)
    expect(
      consumeIdx,
      'consumeFocusNodeQuery 必须在 nodes.value 赋值之后调用 —— 提前调用会因节点未加载而定位失败',
    ).toBeGreaterThan(loadIdx)
  })

  it('定位成功走 selectOnlyNode + focusNodeById（移动端切页签 + 闪烁高亮）', () => {
    const fn = page.match(/async function consumeFocusNodeQuery\(\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn).toContain('selectOnlyNode')
    expect(fn).toContain('focusNodeById')
  })

  it('消费后清掉 query（避免刷新重复触发）', () => {
    const fn = page.match(/async function consumeFocusNodeQuery\(\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn).toContain('delete nextQuery.focusNode')
    expect(fn).toContain('router.replace')
  })

  it('跨项目跳转路径带 focusNode（handlePublishLocateNode）', () => {
    const fn = page.match(/async function handlePublishLocateNode\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn).toContain('focusNode')
    expect(fn).toContain('router.push')
  })
})
