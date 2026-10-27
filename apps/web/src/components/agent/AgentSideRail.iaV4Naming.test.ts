import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * AgentSideRail 的 IA v4 命名守卫（2026-10-23 用户裁定「新建对话」→「新对话」）。
 *
 * 背景：移动端顶栏改名「新对话」时，桌面侧栏 header 的同名按钮 title 被漏改
 *（生产 bundle 取证时才发现：CanvasPage 分包里 `title:"新建对话"` 仍 1 处命中）。
 * 同一个动作在两端叫两个名字 ⇒ 用户跨设备找不到对应入口；「移动端与 WEB 端
 * 同语义」是本轮 IA v4 的核心原则。
 *
 * 判据：剥注释后源码里不得再出现「新建对话」字面量（注释里记录历史决策不算）。
 * ⛔ 不用「用户可见」这种软判据——title 属性只在 hover 时可见，漏改很难被
 * 肉眼走查发现，必须用字面量判据钉死。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const rail = readFileSync(join(HERE, 'AgentSideRail.vue'), 'utf8')

/** 剥三种注释形态（历史决策说明里出现旧名不算违规）。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

const src = stripComments(rail)

describe('AgentSideRail — IA v4 命名（对话级动作统一叫「新对话」）', () => {
  it('⛔ 源码（剥注释）不得再出现「新建对话」字面量', () => {
    expect(
      src,
      '桌面侧栏 header 按钮的 title 与移动端顶栏同名才是一致（IA v4 2026-10-23）',
    ).not.toContain('新建对话')
  })

  it('桌面侧栏 header 已退役「新对话 / 历史」按钮（ADR-0015 统一单对话，建/切对话收口到创作空间与移动端顶栏）', () => {
    expect(src).not.toContain('title="新对话"')
    expect(src).not.toContain('title="对话历史"')
  })

  it('对话级动作与项目级动作级差仍在：项目级仍叫「新建项目」', () => {
    // ⛔ 改名不得越界：「新建项目」（项目=画布+对话）与「新对话」（线程级）不可混
    expect(src).toContain('新建项目')
  })
})
