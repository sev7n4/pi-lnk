/**
 * Phase 4 / #3 P4：`defineExpose` 对外 11 项冻结契约的类别化全覆盖 ratchet。
 *
 * 为什么是源级判据：AgentSideRail.vue 挂载需整套 store / fetch / auth 桩（见
 * observerWiring.test.ts 既有结论）；本刀是纯门禁刀、零产品代码改动，契约内容
 * 就是「对外暴露了哪些名字」+「每个名字是否真的有实现来源」。
 *
 * 在此之前只有 3 处零散断言（deadHistoryChain 2 项、waitSettle 2 项），
 * 删掉 / 改名 / 悬空其余 7 项 CI 不会红。本测试补齐类别化判据：
 *  - 精确集合相等（不多不少，防止悄悄加契约或删契约）；
 *  - 每项值必须能解析出实现来源（防止留下悬空键名）；
 *  - 否定能力由变异测试证明（M1 删键必 RED，M7 注释里加键名不得假绿）。
 *
 * ⚠️ 解析前一律先剥离注释：历史归因注释会提到契约名，不剥离会假绿。
 * ⚠️ 按括号配平截取块、按深度 0 逗号切条目，不用行号（行号随改动位移）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfcRaw = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

/** Phase 3 结项规格 §4.1 冻结的 11 项对外契约，顺序无意义、集合有意义。 */
const FROZEN_EXPOSE_KEYS = [
  'newAgentSession',
  'openThreadHistory',
  'closeThreadHistory',
  'openPanel',
  'closePanel',
  'setComposerInput',
  'addAttachment',
  'reconcileFromNodes',
  'confirmProposeWait',
  'cancelProposeForNode',
  'addFromCanvasNodes',
] as const

/** 由 `useXxx(` 注入到 SFC 的对象名，供 `obj.prop` 形态的实现来源配对。 */
const INJECTED_OBJECTS = ['threadApi', 'composer', 'propose', 'sidebar'] as const

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/** 从 `open_idx` 处的 `{` 起配平括号，跳过字符串/模板串/注释，返回闭合下标。 */
function matchingBrace(src: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1] ?? ''
    if (c === '/' && n === '/') {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '/' && n === '*') {
      const j = src.indexOf('*/', i + 2)
      i = j < 0 ? src.length : j + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i += 1; break }
        i += 1
      }
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** 按深度 0 的逗号切分对象条目；返回值保留完整 `key: value` 文本。 */
function topLevelEntries(body: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let i = 0
  while (i < body.length) {
    const c = body[i]
    const n = body[i + 1] ?? ''
    if (c === '/' && n === '/') {
      const j = body.indexOf('\n', i)
      i = j < 0 ? body.length : j
      continue
    }
    if (c === '/' && n === '*') {
      const j = body.indexOf('*/', i + 2)
      i = j < 0 ? body.length : j + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      cur += c
      i += 1
      while (i < body.length) {
        cur += body[i]
        if (body[i] === '\\') { cur += body[i + 1] ?? ''; i += 2; continue }
        if (body[i] === q) { i += 1; break }
        i += 1
      }
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    if (c === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += c
    i += 1
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 取条目第一个顶层冒号左侧作为键名；没有冒号时整条即为简写键名。 */
function entryKey(entry: string): string {
  let depth = 0
  for (let i = 0; i < entry.length; i += 1) {
    const c = entry[i]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ':' && depth === 0) return entry.slice(0, i).trim()
  }
  return entry.trim()
}

/** 取条目第一个顶层冒号右侧的值文本。 */
function entryValue(entry: string): string {
  const k = entryKey(entry)
  if (k === entry.trim()) return ''
  return entry.slice(entry.indexOf(':') + 1).trim()
}

function hasDefinition(src: string, name: string): boolean {
  return new RegExp(`(?:const|let|var|function|async\\s+function)\\s+${name}\\b`).test(src)
    || new RegExp(`\\b${name}\\b\\s*[,}]`).test(src.slice(0, src.indexOf('defineExpose(')))
}

const sfc = stripComments(sfcRaw)
const exposeIdx = sfc.indexOf('defineExpose({')
const exposeOpen = exposeIdx < 0 ? -1 : sfc.indexOf('{', exposeIdx)
const exposeClose = exposeOpen < 0 ? -1 : matchingBrace(sfc, exposeOpen)
const exposeBody = exposeClose < 0 ? '' : sfc.slice(exposeOpen + 1, exposeClose)
const entries = topLevelEntries(exposeBody)
const keys = entries.map(entryKey)

describe('AgentSideRail defineExpose 冻结契约（Phase 4 / P4）', () => {
  it('组 1：能定位 defineExpose 块且剥离注释后不空', () => {
    expect(exposeIdx, 'SFC 必须保留 defineExpose 块').toBeGreaterThanOrEqual(0)
    expect(exposeClose, 'defineExpose 块括号必须配平').toBeGreaterThan(exposeOpen)
    expect(entries.length, '块内必须有条目').toBeGreaterThan(0)
  })

  it('组 2：11 项冻结契约精确集合相等（不多不少、不可改名）', () => {
    expect([...keys].sort(), '冻结契约集合必须逐项一致').toEqual([...FROZEN_EXPOSE_KEYS].sort())
    expect(new Set(keys).size, '不得出现重复键名').toBe(keys.length)
  })

  it('组 3：每项都有可解析的实现来源（类别化配对）', () => {
    const prefix = sfc.slice(0, exposeIdx)
    for (const entry of entries) {
      const key = entryKey(entry)
      const value = entryValue(entry)
      if (!value) {
        // 裸标识符简写：必须是 SFC 内定义的函数 / 常量
        expect(hasDefinition(prefix, key), `${key} 必须在 SFC 内有定义`).toBe(true)
        continue
      }
      const member = value.match(/^([A-Za-z_$][\w$]*)\.([\w$]+)$/)
      if (member) {
        // obj.prop：obj 必须是真实注入的 composable 返回对象，且成员名存在
        expect(INJECTED_OBJECTS, `${key} 的宿主 ${member[1]} 必须是已注入对象`).toContain(member[1] as never)
        expect(new RegExp(`const\\s+${member[1]}\\b`).test(prefix), `${member[1]} 必须有 const 定义`).toBe(true)
        continue
      }
      // 内联函数：必须有非空函数体
      expect(value, `${key} 必须是内联函数`).toContain('=>')
      expect(value.indexOf('{'), `${key} 函数体不得为空`).toBeGreaterThan(-1)
      expect(value.length, `${key} 函数体不得为空壳`).toBeGreaterThan(40)
    }
  })

  it('组 4：存在性肯定断言（防止「删空文件也能绿」）', () => {
    for (const anchor of [
      'defineExpose({',
      'const threadApi = useAgentThread({',
      'const composer = reactive(useAgentComposer({',
      'const propose = useAgentPropose({',
      'const sidebar = useSidebarAttachments()',
      'function openPanel()',
      'function closePanel()',
      'async function openThreadHistory()',
      'function closeThreadHistory()',
      'function reconcileFromNodes(',
    ]) {
      expect(sfc, `必须保留锚点 ${anchor}`).toContain(anchor)
    }
  })
})
