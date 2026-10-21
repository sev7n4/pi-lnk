/**
 * Agent 分组路径的**接线层**守卫（2026-10-21）。
 *
 * 行为级测试（`useCanvasGrouping.agentGroupId.test.ts`）证明了「id 贯通」，
 * 但那只覆盖到纯函数。真正的失效区在**接线**：
 *   SSE `canvas_command` → 侧栏 switch 分支 → emit → 页面 handler → 落库
 * 任何一段没接上，结果都是「工具返回 ok:true、用户什么都没看到」——
 * **静默失效，且不会报错**（这正是 #540「设了没反应」那类缺陷的同构版本）。
 *
 * 判据形式沿用仓库既有的「函数体提取 + 静态断言」（CanvasPage.groupResize.test.ts）。
 * ⚠️ 只断言「出现了某个标识符」是弱判据 —— 这里对每条都要求
 * **必要条件成对出现**（如「必须既调 createGroupFromSelection 又传 opts?.groupId」），
 * 否则删掉一半接线仍会绿。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function read(rel: string): string {
  return readFileSync(join(HERE, rel), 'utf8')
}

const rail = read('../components/agent/AgentSideRail.vue')
const page = read('CanvasPage.vue')

/**
 * 剥掉**行注释**（`//` 到行尾），保留字符串字面量内容。
 *
 * ⭐ 为什么必须剥（仓库踩过的坑）：静态断言会被注释命中 ——
 * 本文件的判据要数 `persistUserEdit(` 的出现次数、比较「存在性检查」与
 * 「落库」的先后，而函数体里的**注释文字**恰好也提到 `persistUserEdit()`
 * （"但 persistUserEdit() 仍会触发一次无谓保存"）⇒ 不剥注释会把计数算成 2、
 * 把位置判据算成「检查在落库之后」⇒ **假红**。
 *
 * ⚠️ 剥注释时必须逐字符跟踪引号状态：字符串里的 `//`（如 URL "https://…"）
 * 不是注释起点，直接按 `//` 切会把后面整行代码误删 ⇒ 判据本身失真。
 */
function stripLineComments(src: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += src[i + 1] ?? ''
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += ch
  }
  return out
}

/**
 * 截出**块语句**（`{ ... }`）—— 用于 switch 的 `} else if (...) { ... }` 分支。
 *
 * 与 functionBody 的区别：分支不是函数，没有参数列表；直接从签名后的
 * 第一个 `{` 起做花括号配平即可。
 */
function blockBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `找不到 ${signature}`).toBeGreaterThan(0)
  const braceStart = src.indexOf('{', start + signature.length)
  expect(braceStart, `${signature} 后找不到 {`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${signature} 的块括号未配平`)
}

/**
 * 截出某个函数的函数体。
 *
 * ⛔ 两个坑都要避：
 * 1. 不用「到下一个顶层 `function ` 为止」的正则切分 —— 会被函数体**内部**出现的
 *    `function `（箭头函数、内嵌声明）提前截断 ⇒ 落库次数统计与位置判据双双失真。
 * 2. 找函数体起点时**不能**直接取签名后的第一个 `{` —— 签名里可能带**类型字面量**
 *    （如 `opts?: { nodeIds?: string[] }`），那对花括号是**类型**不是函数体。
 *    ⇒ 必须先跳过参数列表（括号配平到 `)`），再取其后第一个 `{`。
 */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `找不到 ${signature}`).toBeGreaterThan(0)
  // 参数列表：从 signature 末尾的 '(' 起，括号配平到 ')'
  const parenStart = src.indexOf('(', start + signature.length - 1)
  expect(parenStart, `${signature} 后找不到 (`).toBeGreaterThan(-1)
  let parenDepth = 0
  let bodyStart = -1
  for (let i = parenStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') parenDepth++
    else if (ch === ')') {
      parenDepth--
      if (parenDepth === 0) {
        // ')' 之后到 '{' 之间只允许空白与返回类型
        const between = src.slice(i + 1, i + 40)
        const braceOffset = between.indexOf('{')
        expect(braceOffset, `${signature} 参数列表后找不到 {`).toBeGreaterThan(-1)
        bodyStart = i + 1 + braceOffset
        break
      }
    }
  }
  expect(bodyStart, `${signature} 找不到函数体起点`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${signature} 的函数体括号未配平`)
}

/** 取函数体并**剥掉行注释**（判据用，避免注释命中）。 */
function codeBody(src: string, signature: string): string {
  return stripLineComments(functionBody(src, signature))
}

/** 取**块语句**（switch 分支）并剥掉行注释。 */
function codeBody2(src: string, signature: string): string {
  return stripLineComments(blockBody(src, signature))
}

describe('Agent 分组：侧栏命令分发', () => {
  it('三个分组命令都有分发分支', () => {
    for (const t of ['group_nodes', 'ungroup_group', 'set_group_color']) {
      expect(rail, `侧栏缺 ${t} 分支`).toContain(`cmd.type === '${t}'`)
    }
  })

  it('⭐ group_nodes 必须把 groupId 透传给页面（断了这条 id 就分叉）', () => {
    const body = codeBody2(rail, "} else if (cmd.type === 'group_nodes'")
    expect(body).toContain('emit(')
    expect(body).toContain('groupNodes')
    expect(body).toContain('groupId')
    // 必须从 cmd 读出来再透传（而不是硬编码/丢弃）
    expect(body).toMatch(/cmd\.groupId/)
  })

  it('ungroup_group 必须 emit groupId', () => {
    const body = codeBody2(rail, "} else if (cmd.type === 'ungroup_group'")
    expect(body).toContain("emit('ungroupGroup'")
    expect(body).toContain('cmd.groupId')
  })

  it('set_group_color 必须 emit groupId + colorKey', () => {
    const body = codeBody2(rail, "} else if (cmd.type === 'set_group_color'")
    expect(body).toContain("emit('setGroupColor'")
    expect(body).toContain('cmd.groupId')
    expect(body).toContain('colorKey')
  })

  it('⛔ 侧栏是色键的最后一道防线：非法色键必须丢弃（不 emit）', () => {
    const body = codeBody2(rail, "} else if (cmd.type === 'set_group_color'")
    expect(body).toContain('GROUP_COLOR_KEYS')
    expect(body).toMatch(/if\s*\([\s\S]*GROUP_COLOR_KEYS[\s\S]*\)\s*\{[\s\S]*console\.warn/)
    // 丢弃分支里**不能**有 emit（否则非法键照样下发）
    const warnIdx = body.indexOf('console.warn')
    const emitIdx = body.indexOf("emit('setGroupColor'")
    expect(warnIdx).toBeGreaterThan(-1)
    expect(emitIdx).toBeGreaterThan(-1)
    // emit 必须在「校验通过」分支里：warn 出现在 emit 之前（先判后发）
    expect(warnIdx).toBeLessThan(emitIdx)
  })
})

describe('Agent 分组：页面消费端', () => {
  it('三个事件都接上了 handler', () => {
    expect(page).toContain('@group-nodes=')
    expect(page).toContain('@ungroup-group=')
    expect(page).toContain('@set-group-color=')
  })

  it('⭐ handleGroupSelection 必须把 groupId 传给 createGroupFromSelection', () => {
    const body = codeBody(page, 'function handleGroupSelection(')
    expect(body).toContain('createGroupFromSelection')
    // ⛔ 只调 createGroupFromSelection 不够 —— 必须把 opts?.groupId 一路传下去，
    // 否则前端会另生成一个 id，Agent 后续改色/解组就找不到组。
    expect(body).toMatch(/createGroupFromSelection\([^)]*opts\?\.groupId/)
  })

  it('⭐ handleGroupSelection 必须落库（persistUserEdit）且只落一次', () => {
    const body = codeBody(page, 'function handleGroupSelection(')
    const calls = body.match(/persistUserEdit\(/g) ?? []
    expect(calls, '打组必须落库一次').toHaveLength(1)
  })

  it('handleGroupSelection 必须做他人画布只读保护（与 handleArrangeNodes 同口径）', () => {
    const body = codeBody(page, 'function handleGroupSelection(')
    expect(body).toContain('agentReadOnly.value')
  })

  it('handleUngroupSelection 必须落库且只落一次', () => {
    const body = codeBody(page, 'function handleUngroupSelection(')
    const calls = body.match(/persistUserEdit\(/g) ?? []
    expect(calls).toHaveLength(1)
    expect(body).toContain('ungroupById')
  })

  it('handleGroupColorSelection 必须落库且只落一次', () => {
    const body = codeBody(page, 'function handleGroupColorSelection(')
    const calls = body.match(/persistUserEdit\(/g) ?? []
    expect(calls).toHaveLength(1)
    expect(body).toContain('patchGroupNodeData')
  })

  it('⛔ 改色目标不存在时不得落库（否则「设了没反应」被整份保存固化下来）', () => {
    const body = codeBody(page, 'function handleGroupColorSelection(')
    // 存在性检查必须**在** persistUserEdit 之前 return
    const guardIdx = body.search(/isGroupNode/)
    const persistIdx = body.indexOf('persistUserEdit(')
    expect(guardIdx, '改色前必须校验目标组存在').toBeGreaterThan(-1)
    expect(persistIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(persistIdx)
    // 且必须有 early return
    expect(body).toMatch(/isGroupNode[\s\S]*?\)\s*return/)
  })
})
