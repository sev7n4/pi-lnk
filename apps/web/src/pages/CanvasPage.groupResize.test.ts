/**
 * 分组框 8 方向缩放的页面接线纪律（2026-10-21）。
 *
 * 用户实测诉求原文：「分组框不支持 8 个方向的拖拽可以拉伸或缩小分组框的大小
 * （和本项目裁剪、扩图的行为一致）」。本文件锁住接线的三条硬约束 ——
 * 这些是「手柄画出来了但没反应」这类静默失效的根因：
 *
 *  1. **必须接几何**：页面走 `resizeGroupByHandle`（纯函数），不得自己算边；
 *  2. **必须落库**：拖拽结束（delta === null）才 persist 一次，拖拽中不写库；
 *  3. **⛔ 缩放路径不得调 fitGroups()**：那条通路的语义是「把框贴回子节点包围盒」
 *     （拖子节点 / 加载后用），缩放恰恰要脱离包围盒 —— 调了等于立刻撤销用户的缩放。
 *
 * 判据形式沿用 CanvasPage.groupFeedback.test.ts 的「函数体提取 + 静态断言」。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function pageSource(): string {
  return readFileSync(join(HERE, 'CanvasPage.vue'), 'utf8')
}

/** 截出某个函数的函数体（到下一个顶层 `function ` / `const ` 为止）。 */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `CanvasPage 里找不到 ${signature}`).toBeGreaterThan(0)
  const rest = src.slice(start + signature.length)
  const end = rest.search(/\n(?:function |const |watch\(|provide\()/m)
  return src.slice(start, end > 0 ? start + signature.length + end : undefined)
}

describe('分组框缩放：页面接线', () => {
  it('⛔ handleGroupResize 必须接 resizeGroupByHandle（几何单一出处）', () => {
    const body = functionBody(pageSource(), 'function handleGroupResize(')
    expect(body).toContain('resizeGroupByHandle')
    expect(body).toContain('groupId')
    expect(body).toContain('dir')
  })

  it('⛔ 拖拽中不落库；只在 delta === null（松手）时 persist 一次', () => {
    const body = functionBody(pageSource(), 'function handleGroupResize(')
    const persistCalls = body.match(/persistUserEdit\(/g) ?? []
    expect(persistCalls, '缩放路径必须落库一次（拖拽结束）').toHaveLength(1)
    // 结构上：persistUserEdit 必须在 `if (delta) { ... return }` **之后**（即松手分支），
    // 拖拽分支里绝不能出现 persistUserEdit。
    expect(body).toMatch(
      /if\s*\(delta\)\s*\{[\s\S]*?\breturn\b[\s\S]*?\}\s*\n?\s*persistUserEdit\(\)/,
    )
    // 反向：if 块内不得有 persist
    const deltaBlock = body.match(/if\s*\(delta\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
    expect(deltaBlock, '拖拽分支里不得落库').not.toContain('persistUserEdit')
  })

  it('⛔ 缩放路径绝不调 fitGroups（会把框贴回包围盒 = 立刻撤销缩放）', () => {
    const body = functionBody(pageSource(), 'function handleGroupResize(')
    expect(body).not.toContain('fitGroups(')
    expect(body).not.toContain('syncGroupsToFitChildren(')
  })

  it('移动端不给缩放手柄（groupResizeFn 置 null ⇒ 组件 inject 到 null）', () => {
    const src = pageSource()
    // 注入的是 Ref：视口运行时会变，provide 一个值会锁死在 setup 那一刻
    expect(src).toContain('provide(CANVAS_GROUP_RESIZE_KEY, groupResizeFn)')
    expect(src).toMatch(/groupResizeFn\.value\s*=\s*mobile\s*\?\s*null\s*:\s*handleGroupResize/)
  })
})
