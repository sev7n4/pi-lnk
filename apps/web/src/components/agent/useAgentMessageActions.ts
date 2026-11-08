import { ref, type Ref } from 'vue'
import { useAgentStore, type AgentStreamMessage } from '@/stores/agent'
import type { LinkedCanvasOutput } from '@lnkpi/shared'
import { visibleAssistantContent, visibleUserContent } from './agentMessageRender'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { ElMessage } from 'element-plus'

type AgentStore = ReturnType<typeof useAgentStore>

/**
 * 第十一项（strangler-fig，2026-11-08）：消息气泡操作簇（复制 / 反馈 / 就地编辑用户消息）
 * 从 AgentSideRail 抽离。
 *
 * 所有权边界（沿用前序刀原则）：`agent` 仍由父组件注入（此簇读写 `agent.messages` /
 * `agent.isStreaming`）；`editingMessageId` / `editingDraft` 由父持有（模板编辑卡直接绑定，
 * 本簇只读写），故作为 ref 注入；`isLiveTurnMessage` / `showTaskCard` / `assistantOutputsById`
 * / `isMobileLayout` / `props.readOnly` 是 SFC 级判定，注入为 getter；`sendMessage` 是 SFC 核心
 * 发送函数（被 sendEditedUserMessage 复用），不可迁移，注入。
 *
 * 纯函数（`visibleAssistantContent` / `visibleUserContent` / `copyTextToClipboard` /
 * `ElMessage`）直接 import，不经由 deps。
 *
 * 零行为变更：本文件为 SFC 原簇逐字搬运 + 依赖替换。
 */
export interface AgentMessageActionsDeps {
  agent: AgentStore
  isLiveTurnMessage: (msg: AgentStreamMessage) => boolean
  getShowTaskCard: () => boolean
  getAssistantOutputsById: () => Map<string, LinkedCanvasOutput[]>
  getIsMobileLayout: () => boolean
  getReadOnly: () => boolean
  editingMessageId: Ref<string | null>
  editingDraft: Ref<string>
  sendMessage: (message: string, branchFromEntryId?: string, isRetry?: boolean) => Promise<void>
}

export interface AgentMessageActionsApi {
  messageFeedback: Ref<Record<string, 'up' | 'down'>>
  copiedMessageId: Ref<string | null>
  mobileUserActionsOpen: Ref<Set<string>>
  canShowMessageActions: (msg: AgentStreamMessage) => boolean
  toggleMessageFeedback: (msgId: string, vote: 'up' | 'down') => void
  copyAssistantMessage: (msg: AgentStreamMessage) => Promise<void>
  canShowUserMessageActions: (msg: AgentStreamMessage) => boolean
  toggleUserMessageActions: (id: string) => void
  onUserBubbleClick: (msg: AgentStreamMessage) => void
  copyUserMessage: (msg: AgentStreamMessage) => Promise<void>
  editUserMessage: (msg: AgentStreamMessage) => void
  cancelEditUserMessage: () => void
  isMessageUnderEdit: (msg: AgentStreamMessage) => boolean
  sendEditedUserMessage: (msg: AgentStreamMessage) => Promise<void>
}

export function useAgentMessageActions(deps: AgentMessageActionsDeps): AgentMessageActionsApi {
  const {
    agent,
    isLiveTurnMessage,
    getShowTaskCard,
    getAssistantOutputsById,
    getIsMobileLayout,
    getReadOnly,
    editingMessageId,
    editingDraft,
    sendMessage,
  } = deps

  const messageFeedback = ref<Record<string, 'up' | 'down'>>({})
  const copiedMessageId = ref<string | null>(null)
  let copiedMessageTimer: number | null = null

  function canShowMessageActions(msg: AgentStreamMessage): boolean {
    if (msg.role !== 'assistant' || msg.streaming) return false
    if (isLiveTurnMessage(msg) && (agent.isStreaming || getShowTaskCard())) return false
    return Boolean(
      visibleAssistantContent(msg).trim()
        || (getAssistantOutputsById().get(msg.id)?.length ?? 0) > 0
        || msg.executionTrace
        || msg.presentation,
    )
  }

  function toggleMessageFeedback(msgId: string, vote: 'up' | 'down') {
    if (messageFeedback.value[msgId] === vote) {
      const next = { ...messageFeedback.value }
      delete next[msgId]
      messageFeedback.value = next
      return
    }
    messageFeedback.value = { ...messageFeedback.value, [msgId]: vote }
  }

  async function copyAssistantMessage(msg: AgentStreamMessage) {
    const text = visibleAssistantContent(msg).trim()
    if (!text) return
    try {
      await copyTextToClipboard(text)
      copiedMessageId.value = msg.id
      if (copiedMessageTimer !== null) window.clearTimeout(copiedMessageTimer)
      copiedMessageTimer = window.setTimeout(() => {
        if (copiedMessageId.value === msg.id) copiedMessageId.value = null
        copiedMessageTimer = null
      }, 1600)
    } catch {
      ElMessage.error('复制失败')
    }
  }

  /** 已发送用户消息是否展示操作（编辑/复制）。与 assistant 的反馈操作互斥。 */
  function canShowUserMessageActions(msg: AgentStreamMessage): boolean {
    return msg.role === 'user' && !msg.streaming && !getReadOnly()
  }

  /*
   * 2026-10-23 用户反馈（移动端）：用户气泡常驻「编辑/复制/复用本轮」三个图标
   * 把卡片撑得很高，挤压对话流。移动端改为默认收起，**点气泡**浮出在卡片下方；
   * 桌面（hover 语义可用）维持原状。
   * 状态用「每消息一个 Set 快照」整体替换（Vue3 Set 响应式需替换引用才可靠触发）。
   */
  const mobileUserActionsOpen = ref<Set<string>>(new Set())

  function toggleUserMessageActions(id: string) {
    const next = new Set(mobileUserActionsOpen.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    mobileUserActionsOpen.value = next
  }

  function onUserBubbleClick(msg: AgentStreamMessage) {
    if (!getIsMobileLayout()) return
    if (msg.role !== 'user' || isMessageUnderEdit(msg)) return
    if (!canShowUserMessageActions(msg)) return
    toggleUserMessageActions(msg.id)
  }

  async function copyUserMessage(msg: AgentStreamMessage) {
    const text = visibleUserContent(msg).trim()
    if (!text) return
    try {
      await copyTextToClipboard(text)
      copiedMessageId.value = msg.id
      if (copiedMessageTimer !== null) window.clearTimeout(copiedMessageTimer)
      copiedMessageTimer = window.setTimeout(() => {
        if (copiedMessageId.value === msg.id) copiedMessageId.value = null
        copiedMessageTimer = null
      }, 1600)
    } catch {
      ElMessage.error('复制失败')
    }
  }

  function editUserMessage(msg: AgentStreamMessage) {
    editingMessageId.value = msg.id
    editingDraft.value = visibleUserContent(msg)
  }

  function cancelEditUserMessage() {
    editingMessageId.value = null
    editingDraft.value = ''
  }

  /**
   * 该条用户消息是否正处于**就地二次编辑**态。
   *
   * 为什么需要它（2026-10-12 用户口径）：编辑卡原先只是气泡里的一个 `v-else-if` 分支，
   * 而气泡中该消息的**静态展示**是并列的兄弟节点，编辑时照旧渲染 —— 于是同一段话
   * 出现两遍（一次在 textarea，一次是下方的历史正文），下面还挂着 编辑/复制/复用本轮
   * 三个对编辑态无意义的图标按钮，把二次编辑卡本身淹没掉。
   *
   * 当前退场范围：**历史正文** + **操作行**（正是用户点名的两块）。
   * 引用条（`AgentRefStrip`）与指代回执（`AgentSelectionBindingChip`）本次刻意保留 ——
   * 它们承载「这条消息当时带了哪些素材 / 指代了哪些节点」的既成事实，不是编辑内容的重复。
   *
   * 2026-10-12 二次口径（同一张卡片）：它同时是气泡壳的宽度开关 ——
   * 见 `.agent-bubble-user--editing`。展示态靠 max-width + 内容撑满，编辑态内容更窄会被
   * shrink-to-fit 收窄，两态外形对不上；故编辑态显式取满同宽（88%）。
   *
   * 取消编辑即原样恢复（本函数只做渲染门禁，不改 `editingDraft` / 消息数据）。
   */
  function isMessageUnderEdit(msg: AgentStreamMessage): boolean {
    return msg.role === 'user' && editingMessageId.value === msg.id
  }

  /**
   * 已发送用户消息二次编辑 → 从此处重新开始对话（抄 WorkBuddy）。
   * 本地丢弃该消息之后的所有消息，并把该消息内容更新为编辑稿后重新发送；已有产物保留。
   *
   * ③ 重跑：同时把该消息的 pi `entryId` 作为 `branchFromEntryId` 下发 —— 后端据此 fork
   * 出「截断到该消息之前」的新分支线程（真实截断，旧尾不再进模型上下文），前端收到
   * `thread_forked` 后切换到新 threadId，做到前后端一致。
   *
   * 兜底：若该消息还没拿到 entryId（例如刷新后恢复的历史消息，事件早已流走），
   * 则退化为普通发送（不带 branchFromEntryId）—— 不静默伪造切点，后端照常 append。
   */
  async function sendEditedUserMessage(msg: AgentStreamMessage) {
    const draft = editingDraft.value.trim()
    if (!draft) return
    const idx = agent.messages.findIndex((m) => m.id === msg.id)
    if (idx >= 0) {
      const target = agent.messages[idx]
      if (target && 'content' in target) target.content = draft
      agent.messages.splice(idx + 1)
    }
    editingMessageId.value = null
    editingDraft.value = ''
    // 目标消息已被本地丢弃，但它的 entryId 要作为 fork 切点保留下来
    const targetEntryId = msg.entryId
    await sendMessage(draft, targetEntryId)
  }

  return {
    messageFeedback,
    copiedMessageId,
    mobileUserActionsOpen,
    canShowMessageActions,
    toggleMessageFeedback,
    copyAssistantMessage,
    canShowUserMessageActions,
    toggleUserMessageActions,
    onUserBubbleClick,
    copyUserMessage,
    editUserMessage,
    cancelEditUserMessage,
    isMessageUnderEdit,
    sendEditedUserMessage,
  }
}
