import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * SEL-REF：上行 payload 形状的不变量。
 *
 * 上行只有 `selectedNodeIds`；payload 里**不再出现** `focusNodeId`
 * （规格 §5.3 —— 它由服务端从 selectedNodeIds 派生，双字段各自独立写会静默漂移）。
 *
 * 这里用**源码级断言**而非挂载组件跑一次真实发送：`AgentSideRail` 未 expose 发送方法，
 * 驱动发送需 stub fetch + 十余个 props，成本远高于这条不变量本身。
 * 同款做法在本仓已有先例（`scripts/verify-claims.ts` 即源码级判据）。
 */
const railPath = join(dirname(fileURLToPath(import.meta.url)), 'AgentSideRail.vue')

/** 逐个取出所有 `body: JSON.stringify(` 的对象字面量（按花括号配对，避免固定窗口取错位置）。 */
function allJsonBodies(src: string): string[] {
  const marker = 'body: JSON.stringify('
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = src.indexOf(marker, from)
    if (start < 0) return out
    const open = src.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) throw new Error('对象字面量未闭合')
    out.push(src.slice(open, end + 1))
    from = start + marker.length
  }
}

describe('SEL-REF · AgentSideRail 上行 payload 形状', () => {
  const src = readFileSync(railPath, 'utf8')

  /**
   * ⭐ 按**内容特征**定位会话请求体，不再用 `nthJsonBody(src, 2)` 这种序号索引。
   *
   * 序号索引是**隐式契约**：任何人在前面新增一处 `body: JSON.stringify(`（例如 2026-10-20
   * 加的撤回请求）都会把后面所有序号顶走 ⇒ 本文件3 个用例如期假红，而被测代码其实没问题。
   * 特征定位（同时含 `sessionId` 与 `message`）对新增不敏感，且顺带自我验证。
   */
  const bodies = allJsonBodies(src)
  const sessionBody = bodies.find((b) => b.includes('sessionId') && b.includes('message'))

  it('自检：能按特征取到唯一的会话请求体（序号索引已废弃）', () => {
    expect(
      sessionBody,
      `未找到含 sessionId + message 的请求体；现有 ${bodies.length} 处：\n` +
        bodies.map((b, i) => `  [${i}] ${b.slice(0, 70)}`).join('\n'),
    ).toBeTruthy()
    // 唯一性：若多处命中说明特征不够锐利，需要收紧判据
    expect(bodies.filter((b) => b.includes('sessionId') && b.includes('message'))).toHaveLength(1)
  })

  it('payload 含 selectedNodeIds', () => {
    expect(sessionBody).toContain('selectedNodeIds:')
  })

  it('payload **不再**含 focusNodeId 属性键（规格 §5.3：服务端派生，前端不发）', () => {
    // 行锚定 + 只认「属性键形状」：源码里 explanatory 注释提到过这个名字，
    // 朴素的 not.toContain 会被注释命中（假失败），这里只判代码。
    expect(sessionBody).not.toMatch(/^\s*focusNodeId\s*[?:]/m)
  })

  it('空数组时不下发该键（用 undefined 而非 []，与「传了但为空」可区分）', () => {
    expect(sessionBody).toMatch(/selectedNodeIds:\s*bindingIds\.length\s*\?\s*bindingIds\s*:\s*undefined/)
  })
})

// ── 评审 C1：selection_binding 事件的接线（源码级不变量）────────────────────
describe('SEL-REF · selection_binding 事件接线', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AgentSideRail.vue'), 'utf8')

  it('handleEvent 有 selection_binding 分支并调用 store 的 confirmSelectionBinding', () => {
    expect(src).toMatch(/case 'selection_binding':/)
    expect(src).toMatch(/agent\.confirmSelectionBinding\(/)
  })

  it('事件类型已在共享事件联合里登记（否则会被类型层判为不可能事件）', () => {
    const types = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/agent/src/types.ts'),
      'utf8',
    )
    expect(types).toMatch(/^\s*\|\s*'selection_binding'\s*$/m)
  })

  it('chip 的渲染条件读 confirmed，而非本地 id 快照', () => {
    // 判据用**行锚定的属性访问形状**：朴素 toContain 会被本文件的注释命中。
    expect(src).toMatch(/v-if="msg\.role === 'user' && msg\.selectionBindingConfirmed\?\.length"/)
    expect(src).not.toMatch(/v-if="msg\.role === 'user' && msg\.selectionNodeIds\?\.length"/)
  })
})
