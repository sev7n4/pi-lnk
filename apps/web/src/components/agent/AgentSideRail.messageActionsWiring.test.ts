/**
 * 第十一项（strangler-fig，2026-11-08）：消息气泡操作簇抽离到 `useAgentMessageActions`。
 *
 * 为什么是静态契约：AgentSideRail.vue 挂载需整套 store / fetch / auth 桩（见
 * observerWiring.test.ts 既有结论）；本刀是「逐字搬运 + 依赖注入」，零行为变更，
 * 因此契约的全部内容就是「符号现在住在哪」+「关键分支形状没被改坏」。
 *
 * 两侧各钉一半：
 *  - SFC 侧：必须有 `useAgentMessageActions({...})` 注入并解构出全部模板绑定；
 *    且簇实现不得残留在 SFC（防止双份实现漂移）。
 *  - composable 侧：四个 getter 化依赖确实被消费；编辑重发 / 移动端气泡 /
 *    复制反馈的关键分支形状保持原样。
 *
 * ⚠️ 断言前一律 stripComments（同 observerWiring：注释里的函数名会被当代码命中，假绿）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfcRaw = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')
const compRaw = readFileSync(join(here, './useAgentMessageActions.ts'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const sfc = stripComments(sfcRaw)
const comp = stripComments(compRaw)

/** 取一个函数体（从签名到下一个顶格/两空格缩进的 `}` 之前的粗略切片）。 */
function blockOf(src: string, signature: string, span = 900): string {
  const i = src.indexOf(signature)
  return i < 0 ? '' : src.slice(i, i + span)
}

describe('AgentSideRail 消息气泡操作簇抽离（第十一项）', () => {
  it('SFC 通过 useAgentMessageActions 注入并解构全部模板绑定', () => {
    const wiring = blockOf(sfc, 'const messageActions = useAgentMessageActions({', 700)
    expect(wiring, '必须有 composable 注入点').toContain('useAgentMessageActions({')
    for (const dep of [
      'agent,',
      'isLiveTurnMessage,',
      'getShowTaskCard: () => showTaskCard.value,',
      'getAssistantOutputsById: () => assistantOutputsById.value,',
      'getIsMobileLayout: () => isMobileLayout.value,',
      'getReadOnly: () => props.readOnly,',
      'editingMessageId,',
      'editingDraft,',
      'sendMessage,',
    ]) {
      expect(wiring, `注入点必须包含 ${dep}`).toContain(dep)
    }
    // 按 `= messageActions` 锚定，避免命中 SFC 里更早出现的其它 `const { ... }` 解构
    const destruct = sfc.match(/const \{[\s\S]*?\} = messageActions/)?.[0] ?? ''
    expect(destruct, '必须能定位 messageActions 解构块').toContain('messageActions')
    for (const binding of [
      'messageFeedback',
      'copiedMessageId',
      'mobileUserActionsOpen',
      'canShowMessageActions',
      'toggleMessageFeedback',
      'copyAssistantMessage',
      'canShowUserMessageActions',
      'onUserBubbleClick',
      'copyUserMessage',
      'editUserMessage',
      'cancelEditUserMessage',
      'isMessageUnderEdit',
      'sendEditedUserMessage',
    ]) {
      expect(destruct, `解构必须暴露模板绑定 ${binding}`).toContain(binding)
    }
    expect(destruct).toContain('= messageActions')
  })

  it('簇实现不再残留在 SFC（防止双份实现漂移）', () => {
    for (const decl of [
      "const messageFeedback = ref<Record<string, 'up' | 'down'>>({})",
      'function canShowMessageActions(',
      'function toggleMessageFeedback(',
      'async function copyAssistantMessage(',
      'const mobileUserActionsOpen = ref<Set<string>>',
      'async function sendEditedUserMessage(',
    ]) {
      expect(sfc, `SFC 不得残留 ${decl}`).not.toContain(decl)
    }
    // copyTextToClipboard 只被本簇使用，抽走后 SFC 的 import 必须一并清掉
    expect(sfc).not.toContain("from '@/utils/copyToClipboard'")
  })

  it('composable 消费四个 SFC getter 化依赖（不得回退成直接读 SFC 局部状态）', () => {
    expect(comp).not.toContain('props.readOnly')
    expect(comp).not.toContain('showTaskCard.value')
    expect(comp).not.toContain('assistantOutputsById.value')
    expect(comp).not.toContain('isMobileLayout.value')
    expect(comp).toContain('getReadOnly()')
    expect(comp).toContain('getShowTaskCard()')
    expect(comp).toContain('getAssistantOutputsById()')
    expect(comp).toContain('getIsMobileLayout()')
  })

  it('assistant 操作门禁：直播轮 + 流式/任务卡时隐藏，且正文/产物/trace/presentation 任一存在才显示', () => {
    const b = blockOf(comp, 'function canShowMessageActions(', 700)
    expect(b).toContain("if (msg.role !== 'assistant' || msg.streaming) return false")
    expect(b).toContain('if (isLiveTurnMessage(msg) && (agent.isStreaming || getShowTaskCard())) return false')
    expect(b).toContain('visibleAssistantContent(msg).trim()')
    expect(b).toContain('(getAssistantOutputsById().get(msg.id)?.length ?? 0) > 0')
    expect(b).toContain('msg.executionTrace')
    expect(b).toContain('msg.presentation')
  })

  it('用户气泡移动端浮出：仅移动端、非编辑态、且 readOnly 允许时 toggle，Set 需整体替换', () => {
    const b = blockOf(comp, 'function onUserBubbleClick(', 600)
    expect(b).toContain('if (!getIsMobileLayout()) return')
    expect(b).toContain("if (msg.role !== 'user' || isMessageUnderEdit(msg)) return")
    expect(b).toContain('if (!canShowUserMessageActions(msg)) return')
    expect(b).toContain('toggleUserMessageActions(msg.id)')
    const toggle = blockOf(comp, 'function toggleUserMessageActions(', 400)
    expect(toggle).toContain('const next = new Set(mobileUserActionsOpen.value)')
    expect(toggle).toContain('mobileUserActionsOpen.value = next')
    expect(blockOf(comp, 'function canShowUserMessageActions(', 300)).toContain('!getReadOnly()')
  })

  it('二次编辑重发：本地截断后续消息 + 以原 entryId 作为 fork 切点', () => {
    const b = blockOf(comp, 'async function sendEditedUserMessage(', 900)
    expect(b).toContain('const draft = editingDraft.value.trim()')
    expect(b).toContain('if (!draft) return')
    expect(b).toContain('agent.messages.splice(idx + 1)')
    expect(b).toContain('const targetEntryId = msg.entryId')
    expect(b).toContain('await sendMessage(draft, targetEntryId)')
    expect(b).toContain('editingMessageId.value = null')
  })

  it('assistant / user 复制均复用 copiedMessageTimer 并在 1600ms 后复位', () => {
    expect(comp.match(/copiedMessageTimer = window\.setTimeout/g)?.length).toBe(2)
    expect(comp.match(/}, 1600\)/g)?.length).toBe(2)
    expect(comp).toContain('ElMessage.error(\'复制失败\')')
  })
})
