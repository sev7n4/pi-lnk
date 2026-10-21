/**
 * 打组反馈纪律（2026-10-20 真机复测第二轮）。
 *
 * 用户实测：选了节点点「打组」→ 画布毫无反应，以为功能坏了。真因是打组的三条分支
 * 有两条是静默的（不足 2 个直接 return；命中已有分组只改内存选中态），没有任何提示。
 * 本测试锁死：**handleGroupSelection 的每条分支都必须给 ElMessage 反馈**。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 定位 `handleGroupSelection` 的函数体。
 *
 * ⛔ **不能按 `function handleGroupSelection()` 定位**（2026-10-21 实测踩到）：
 * 那个字面量把**签名**也绑死了 —— 2026-10-21 给它加了 `opts` 参数（Agent 路径）后，
 * 签名变成 `function handleGroupSelection(opts?: {...})` ⇒ 这个字面量再也匹配不到
 * ⇒ 守卫**假红**（报「找不到 handleGroupSelection」），而函数其实完全正常。
 *
 * 正解：按**函数名**定位，再对参数列表 `()` 配平、找其后的第一个 `{` 作为函数体起点。
 * ⇒ 签名怎么变都不影响守卫。
 */
function groupHandlerBody(): string {
  const src = readFileSync(join(HERE, 'CanvasPage.vue'), 'utf8')
  const decl = src.indexOf('function handleGroupSelection')
  expect(decl, 'CanvasPage 里找不到 handleGroupSelection').toBeGreaterThan(0)

  // 跳过函数名，匹配参数列表的括号
  let i = decl + 'function handleGroupSelection'.length
  while (i < src.length && src[i] !== '(') i++
  let depth = 0
  let bodyStart = -1
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        bodyStart = src.indexOf('{', i)
        break
      }
    }
  }
  expect(bodyStart, '找不到 handleGroupSelection 的函数体起点').toBeGreaterThan(0)

  // 从函数体起点做花括号配平
  let d = 0
  let end = -1
  for (let j = bodyStart; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') d++
    else if (ch === '}') {
      d--
      if (d === 0) {
        end = j
        break
      }
    }
  }
  expect(end, 'handleGroupSelection 的函数体未闭合').toBeGreaterThan(0)
  return src.slice(bodyStart, end + 1)
}

describe('打组必须给反馈（静默会被读成失败）', () => {
  it('每条 return 之前都有一句 ElMessage（不允许静默分支）', () => {
    const body = groupHandlerBody()
    // 按 return 切段：每一段（最后一段除外）都必须含提示 ⇒ 不存在「静默返回」
    const segments = body.split(/\breturn\b/)
    const silent = segments.slice(0, -1).filter((seg) => !/ElMessage\./.test(seg))
    expect(
      silent.map((s) => s.trim().split('\n').pop()),
      '存在没有任何提示的 return 分支',
    ).toEqual([])
    // 三种结果各有一句提示
    expect(body).toMatch(/ElMessage\.info/)
    expect(body).toMatch(/ElMessage\.success/)
    expect(body, '缺少「已在分组中」这一分支的提示').toMatch(/reselect/)
    expect(body, '缺少「归并为新分组」这一分支的提示').toMatch(/merged/)
  })

  it('不足 2 个节点时提示「请先框选至少 2 个节点再打组」', () => {
    const body = groupHandlerBody()
    expect(body).toContain('请先框选至少 2 个节点再打组')
  })
})
