/**
 * 气泡可见性（P0 决策 2）：**零内容不渲染气泡**。
 *
 * 阻塞等待期（waiting_user）不产生任何 token，旧实现 `shouldShowMessageBubbleText` 开头
 * `if (msg.streaming) return true` 会让一个只有内边距 + 闪烁光标的气泡留在屏幕上 =
 * 用户看到的「白色方块 / 卡住」。可见性判定必须是纯函数以便单测，`.vue` 只接线。
 */
import {
  filterAssistantVisibleText,
  filterUserVisibleText,
  isMachineOnlyVisibleText,
} from '@/components/agent/agentInterruptGate'
import type { AgentStreamMessage } from '@/stores/agent'

/** 此刻气泡内是否有可渲染正文（流式已到文本也算）。 */
export function hasBubbleText(msg: AgentStreamMessage): boolean {
  const filtered =
    msg.role === 'user'
      ? filterUserVisibleText(msg.content ?? '')
      : filterAssistantVisibleText(msg.content ?? '')
  return filtered.trim().length > 0
}

/** 气泡容器是否渲染：助手看是否有可见正文，用户看是否非纯机器载荷。 */
export function hasBubbleContent(msg: AgentStreamMessage): boolean {
  if (msg.role === 'user') return !isMachineOnlyVisibleText(msg.content ?? '')
  return hasBubbleText(msg)
}

/**
 * B3（2026-10-31 生产实证 cmvvaw8ar000moe01fdolrugb）：**阻塞等待回合零 token 也要放行气泡**。
 *
 * propose_generation / ask_user 阻塞等待期模型不说话（零文本 token），旧门禁
 * `hasBubbleContent` 把整颗气泡（含内嵌 `AgentTurnTimeline`）一起藏掉——而时间线里的
 * `proposal` / `question` part 正是那一轮的**全部用户产出**（内联确认卡 / 题卡），
 * 放行判据漏掉它 = 确认卡在对话流里静默不可见（PR #65 svg_card 同类失效，第三发）。
 *
 * 判据与 store 等待态查询侧（`pendingProposal` / `pendingQuestion`）同构：
 * `pending_confirm` 的 proposal part 或 `pending_answer` 的 question part 存在即放行。
 */
export function hasActionableWait(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'assistant') return false
  const parts = msg.timeline?.parts
  if (!parts || parts.length === 0) return false
  return parts.some(
    (p) =>
      (p.kind === 'proposal' && p.status === 'pending_confirm') ||
      (p.kind === 'question' && p.status === 'pending_answer'),
  )
}
