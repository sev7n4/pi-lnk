// P1-6.1 / P1-6.2（Task 11）：--neo-* 消费棘轮
//
// 2026-10-19 扩展：原棘轮只管 components/agent/**，全仓其余 100+ 文件（画布/精修/
// 支付/账户家族）仍可无约束新增旧令牌 ⇒ 本次补两个闸门：
//   ① 全仓 --neo-* 出现次数（剥三种注释后）只许减、不许增；
//   ② components/membership/** 必须为 0（支付家族已全量迁 --lnk-*，永久清零）。
// 全仓删除 neowow-tokens.css 是后续大事（palette-parity.test.ts 钉着画布节点
// 色板，graph/glass/checker/group 等 ~50 个令牌尚无 --lnk-* 对应物，需先迁令牌
// 再删文件）——在那之前，用棘轮保证旧体系不再生长。
//
// 注：守卫自身文件不计入——本文件含字面 `--neo-` 正则与注释，会污染计数。
// 注：brief 里的 `__dirname` 在 vitest ESM 下不存在，这里用 fileURLToPath(import.meta.url)。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', '..')
const SELF = 'neoUsageRatchet.test.ts'

/** 剥三种注释（单行、块、Vue 模板注释）后再计数——注释里写旧令牌名做迁移记录
 *  不应计入消费（不改的话注释也会被算成隐患，基线虚高 41）。
 *  参考仓库 stripComments 教训：否定断言必须配有效性断言，防止扫描空转假绿。 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

function countNeoTokens(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countNeoTokens(p)
    else if (e.name !== SELF && (e.name.endsWith('.vue') || e.name.endsWith('.ts') || e.name.endsWith('.css')))
      n += (stripComments(readFileSync(p, 'utf8')).match(/--neo-/g) ?? []).length
  }
  return n
}

// Task 11 实施前实测 379（AgentSideRail.vue 141 处已全部迁 --lnk-*，本批 -141）。
// 清扫后实测 238；Task 15 门禁期复测 231（Task 12 删死样式顺带清掉 7 处）。只允许下调。
// 注：fs 递归扫描在并行负载下曾被 5s 默认超时误杀（Task 12 遗留），显式放宽到 30s。
const NEO_BASELINE = 231

// 全仓基线 = 2026-10-19 支付家族迁移后实测（剥注释口径 1557）。
// 2026-10-21 分组回归原生节点形态清扫到 1513（-44）：删掉 CanvasGroupOverlay.vue
// （--neo-group-* 消费 3 处）+ neo-node.css 分组兜底改 --lnk-*（-2）+ 新写的
// CanvasNodeGroup.vue 零 --neo-*。按棘轮协议「有意清扫即同步下调基线」，
// 不下调的话这 44 的余量会被后续 PR 静默花掉。
// 注：fs 递归扫描在并行负载下曾被 5s 默认超时误杀（Task 12 遗留），显式放宽到 30s。
const NEO_TOTAL_BASELINE = 1513

describe('--neo-* usage ratchet (P1-6.2 / B12)', () => {
  it('count in components/agent only decreases', { timeout: 30_000 }, () => {
    expect(countNeoTokens(here)).toBeLessThanOrEqual(NEO_BASELINE)
  })
})

describe('composer token sweep (P1-6.1)', () => {
  it('AgentSideRail.vue contains zero --neo-*（composer 迁移完成后全文件清零）', () => {
    const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
    expect(sfc.match(/--neo-/g) ?? []).toEqual([])
  })
})

describe('--neo-* whole-src ratchet（2026-10-19 扩展：旧体系禁止再生长）', () => {
  it('⛔ 守卫自身有效：扫描面与存量都不为空（否则下面恒过且零证据）', { timeout: 60_000 }, () => {
    let files = 0
    ;(function walk(d: string) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name))
        else if (e.name.endsWith('.vue') || e.name.endsWith('.ts') || e.name.endsWith('.css')) files += 1
      }
    })(SRC)
    expect(files, '一个源文件都没扫到 —— 路径错了，棘轮在空转').toBeGreaterThan(300)
    expect(countNeoTokens(SRC), '存量读成 0 —— stripComments 把代码也吃了').toBeGreaterThan(1000)
  })

  it('whole-src --neo-* count only decreases（新增任意一处旧令牌即红）', { timeout: 60_000 }, () => {
    const actual = countNeoTokens(SRC)
    expect(
      actual,
      `--neo-* 从基线 ${NEO_TOTAL_BASELINE} 涨到 ${actual}。\n` +
        `新增代码不许再消费旧令牌体系 —— 请改用 --lnk-* 语义令牌（design-tokens.css）。\n` +
        `若本批是有意清扫，请同步下调 NEO_TOTAL_BASELINE 并在 PR 里写明。`,
    ).toBeLessThanOrEqual(NEO_TOTAL_BASELINE)
  })
})

describe('membership family token sweep（2026-10-19 支付家族全量迁移后永久清零）', () => {
  it('components/membership/** 不含 --neo-*（剥注释口径）', () => {
    const dir = join(SRC, 'components', 'membership')
    expect(countNeoTokens(dir), '支付家族又出现旧令牌消费').toBe(0)
  })
})
