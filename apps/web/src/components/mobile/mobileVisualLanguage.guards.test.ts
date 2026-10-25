import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用（仓库既有约定：fileURLToPath(import.meta.url)）
const HERE = dirname(fileURLToPath(import.meta.url))
const MOBILE_DIR = HERE

function read(name: string) {
  return readFileSync(join(MOBILE_DIR, name), 'utf-8')
}

/** 剥离注释（JS 注释 + HTML 注释）—— 注释里提到字符/组件名是**规范说明**，不是引用 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 跨端视觉与组件哲学守卫（规格 §4.11 · 拍板项 N1）。
 *
 * ⭐ 这些守卫防的是「**风格退化**」——本轮改动让移动端第一次统一到
 *   iOS HIG / Material 3 的组件语义与视觉纪律；没有守卫，下一个人很容易
 *   又写回裸 fixed 浮层 / 字符图标 / 硬编码圆角。
 */
describe('跨端视觉与组件哲学守卫（§4.11）', () => {
  it('G-16 移动端模板不得用文本字符当功能图标（‹ × ⋯）', () => {
    const files = readdirSync(MOBILE_DIR).filter((f) => f.endsWith('.vue'))
    const offenders: string[] = []
    for (const f of files) {
      const src = stripComments(read(f))
      // 只查按钮内容里的裸字符图标
      if (/>\s*[‹×⋯]\s*</.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('G-15 长按浮层必须走 MobileSheet 基座（⛔ 禁第二套 sheet 皮肤）', () => {
    const src = stripComments(read('MobileNodeActionSheet.vue'))
    expect(src).toContain('MobileSheet')
    expect(src).not.toMatch(/position:\s*fixed/)
  })

  it('G-15b 标注浮层同样走 MobileSheet 基座', () => {
    const src = stripComments(read('MobileNodeAnnotateSheet.vue'))
    expect(src).toContain('MobileSheet')
    expect(src).not.toMatch(/position:\s*fixed/)
  })

  it('MobileSheet 有 reduce-motion 分支（§4.11.8 · HIG Reduce Motion）', () => {
    expect(read('MobileSheet.vue')).toMatch(/prefers-reduced-motion/)
  })

  it('MobileSheet 圆角与动效使用令牌（禁硬编码 20px / 0.25s）', () => {
    const src = read('MobileSheet.vue')
    expect(src).toContain('--lnk-radius-')
    expect(src).toContain('--lnk-duration-')
    expect(src).not.toMatch(/border-radius:\s*20px/)
    expect(src).not.toMatch(/transition:[^;]*0\.25s/)
  })

  it('G-18 命中区令牌被使用（44px 触控下限）', () => {
    const src = read('MobileSheet.vue')
    expect(src).toContain('--lnk-touch-target')
  })

  it('⛔ 零 --neo-* 旧令牌（AGENTS.md 明令禁用；G-15）', () => {
    const files = readdirSync(MOBILE_DIR).filter((f) => f.endsWith('.vue'))
    const offenders = files.filter((f) => read(f).includes('--neo-'))
    expect(offenders).toEqual([])
  })

  it('⛔ 品牌锚用位图资产（⛔ 不用字符 / 不新造图标，G-7）', () => {
    const src = read('MobileNodeAnnotateSheet.vue')
    expect(src).toContain('anchor-locate.png')
  })
})
