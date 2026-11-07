/**
 * 等待结算单飞 + 乐观翻态 + 挂起期时间线存活 + 看门狗豁免（2026-10-31 大章鱼回合防回归）。
 *
 * 生产实证（cmvvaw8ar000moe01fdolrugb，nginx 17:01:25-27）：同一 propose 等待被客户端
 * 连发 4×answers + 1×decline + 1×clear-propose——多确认入口无单飞、resolved 经旁听流
 * 迟到/缺席 ⇒ 窗口期内所有入口持续可点。同回合实证：turn_suspended 后 liveTimeline
 * 的 active 判据不含挂起态 ⇒ 钉底时间线在挂起瞬间卸载；30s 静默看门狗把「正常等待」
 * 误杀成 AbortError（走用户取消静默分支 = 「连接无故断开」体感）。
 *
 * ⚠️ 断言前一律 stripComments：注释里写有事故成因，全文扫描会假绿。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const code = stripComments(src)
// Phase 3 strangler-fig 第六刀（#770）：propose/ask 阻塞等待交互已抽离到 useAgentPropose.ts，
// 守卫逻辑随之迁入 composable。源级 ratchet 改读 composable；.vue 内联的 creditsLineVisible /
// agentStream 看门狗豁免仍读组件源。
const proposeSrc = readFileSync(join(here, './useAgentPropose.ts'), 'utf8')
const proposeCode = stripComments(proposeSrc)

function fnBlock(signature: string): string {
  const re = new RegExp(`${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\\}`)
  return code.match(re)?.[0] ?? ''
}

// 抽离后守卫逻辑位于 composable（函数嵌套在 useAgentPropose 内，闭合 brace 带缩进），
// 故用 \n\s*\} 截到函数自身的闭合 brace（而非包住整个 composable 的顶层 brace）。
function proposeFnBlock(signature: string): string {
  // 守卫函数均为 useAgentPropose 的 2 空格缩进子成员，其自身闭合 brace 恰在 2 空格列；
  // 函数体内嵌套的 if/try/对象字面量 brace 均 ≥4 空格，故以 \n  \} 精确截到函数本体。
  const re = new RegExp(`${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\n  \}`)
  return proposeCode.match(re)?.[0] ?? ''
}

describe('propose 等待结算单飞 + 乐观翻态（多确认入口收敛）', () => {
  it('confirmProposeWait：单飞守卫 + 成功后乐观翻终态（P1-A：reason 按 Nest 回执分流）', () => {
    const block = proposeFnBlock('async function confirmProposeWait(')
    expect(block, '必须能定位 confirmProposeWait').not.toBe('')
    expect(block, '单飞：已结算 callId 必须短路').toContain('settledProposeCallIds.has(callId)')
    expect(block, '成功后必须本地翻终态（不等旁听 resolved；P1-A expired 回执翻 timeout）').toContain(
      "resolveProposePartLocally(callId, result.expired ? 'timeout' : 'answered')",
    )
  })

  it('cancelProposeForNode：单飞守卫 + 成功后乐观翻 aborted + 拒发 stale clear-propose', () => {
    const block = proposeFnBlock('async function cancelProposeForNode(')
    expect(block, '必须能定位 cancelProposeForNode').not.toBe('')
    expect(block, '单飞：已结算 callId 必须短路').toContain('settledProposeCallIds.has(callId)')
    expect(block, '取消的乐观翻态语义 = aborted（P1-A expired 回执翻 timeout）').toContain(
      "resolveProposePartLocally(callId, result.expired ? 'timeout' : 'aborted')",
    )
    expect(
      block.indexOf('settledProposeCallIds.has(callId)'),
      '单飞短路必须在 clearProposeGeneration emit 之前（stale clear 会把 generating 节点打回 draft）',
    ).toBeLessThan(block.indexOf("emit('clearProposeGeneration'"))
  })

  it('乐观翻态必须经 trackWaitingUser 回喂时间线（单一真相，不另起并行状态）', () => {
    const block = proposeFnBlock('function resolveProposePartLocally(')
    expect(block, '必须能定位 resolveProposePartLocally').not.toBe('')
    expect(block).toContain('agent.trackWaitingUser')
    expect(block).toContain("status: 'resolved'")
  })

  it('组件必须仍经 defineExpose 暴露 composable 的确认/取消入口（strangler 收口不丢契约）', () => {
    expect(code, '必须仍暴露 confirmProposeWait').toContain('propose.confirmProposeWait')
    expect(code, '必须仍暴露 cancelProposeForNode').toContain('propose.cancelProposeForNode')
  })
})

describe('挂起期呈现存活（turn_suspended ≠ 卸载）', () => {
  it('挂起态必须并入「回合进行中基座」（流式归一后 creditsLineVisible 是唯一基座消费方）', () => {
    // 2026-11-03 流式归一：liveTimeline 钉底退役，等待呈现由消息流内联 timeline 承接；
    // creditsLineVisible（会话积分常驻条）是基座判定的唯一存续消费方，挂起期不得熄灭。
    const block = fnBlock('const creditsLineVisible = computed(')
    expect(block, '必须能定位 creditsLineVisible').not.toBe('')
    expect(block, '基座必须含挂起态').toContain('mainTurnSuspended.value')
  })
})

describe('看门狗豁免阻塞等待（沉默 ≠ 卡死）', () => {
  it('onStale：等待期（proposal/question/挂起）不得 abort 主流', () => {
    const block = code.match(/const agentStream = useAgentStream\(\{[\s\S]*?\n\}\)/)?.[0] ?? ''
    expect(block, '必须能定位 agentStream 初始化').not.toBe('')
    expect(block, '等待期必须豁免').toContain('agent.pendingProposal || agent.pendingQuestion')
    expect(block).toContain('mainTurnSuspended.value')
  })
})
