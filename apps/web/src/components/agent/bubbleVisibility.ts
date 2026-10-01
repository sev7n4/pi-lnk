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
