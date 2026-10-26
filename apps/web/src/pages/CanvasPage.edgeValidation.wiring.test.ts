import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CP_RAW = readFileSync(join(HERE, '..', 'pages', 'CanvasPage.vue'), 'utf8')

/** 剥掉注释再断言（本仓纪律：注释里提到符号=规范说明，命中注释=假红/假绿）。 */
function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

const CP = stripComments(CP_RAW)

/**
 * SP-D（ADR-0014）：手拉边校验收口静态契约。
 *
 * spec 2026-10-26-sp-d-edge-validation-design.md §8「apps/web」行：
 * - isValidConnection 拦自环 + 本地已存在同对（廉价本地拦截，D5 不做实时判环）；
 * - onConnect 落库路径经统一校验（静态断言：不再直接 persistUserEdit 整份）。
 */
describe('SP-D 手拉边校验收口（静态契约）', () => {
  it('isValidConnection 已定义且经 :is-valid-connection 绑到 VueFlow', () => {
    expect(CP, 'isValidConnection 函数必须存在').toMatch(/function isValidConnection\(/)
    expect(CP, 'VueFlow 必须绑定 :is-valid-connection').toMatch(
      /:is-valid-connection="isValidConnection"/,
    )
  })

  it('isValidConnection 拦自环 + 本地已存在同向对（不做实时判环）', () => {
    const fn = /function isValidConnection\([\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(fn, '必须能定位 isValidConnection').not.toBe('')
    expect(fn).toContain('connection.source === connection.target')
    expect(fn).toContain('.some(')
    // D5：环检测以服务端为准，前端不引入 cycle/DFS 判定
    expect(fn, '前端不做实时环检测').not.toMatch(/cycle|dfs|DFS|visited/i)
  })

  it('onConnect 走 canvasApi.connectNodes 服务通道', () => {
    const fn = /function onConnect\([\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(fn, '必须能定位 onConnect').not.toBe('')
    expect(fn).toContain('canvasApi.connectNodes')
  })

  it('onConnect 不再 persistUserEdit 整份直存（G4 统一通道）', () => {
    const fn = /function onConnect\([\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(fn, '必须能定位 onConnect').not.toBe('')
    expect(fn, 'onConnect 不得整份直存（服务端已持久化）').not.toContain('persistUserEdit')
    // 乐观边 + 失败回滚：本地 UI 与服务端保持一致
    expect(fn).toContain('edges.value.filter')
  })
})
