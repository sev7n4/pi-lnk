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

function groupHandlerBody(): string {
  const src = readFileSync(join(HERE, 'CanvasPage.vue'), 'utf8')
  const start = src.indexOf('function handleGroupSelection()')
  expect(start, 'CanvasPage 里找不到 handleGroupSelection').toBeGreaterThan(0)
  const end = src.indexOf('\nfunction ', start + 10)
  return src.slice(start, end > 0 ? end : undefined)
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
