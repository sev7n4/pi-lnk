/**
 * 「pi 侧来了一条 user 消息」时，前端对话流该怎么对齐（2026-10-21）。
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 * 插话（steer / followUp）走**队列 API**：前端把文字 POST 给 pi-runtime 的 lane inbox，
 * 真正的投递发生在**下一个 turn 边界**（vendor 在边界把 inbox 条目写进 transcript）。
 *
 * 由此产生两件事：
 *  ① 插话消息在对话流里**没有用户气泡** —— 正常发送会本地插一条（`addUserMessage`），
 *     而插话不插；等模型真的消费了它，pi 侧会发 `message_end`（携带那条 user 消息），
 *     此前前端只拿它挂 entryId，**从不建气泡** ⇒ 用户看到「模型回答了，但我说的话不见了」。
 *  ② 此前那条「挂 entryId」的逻辑会把 entryId 挂到「**最后一条** user 消息」上，
 *     且**不检查该消息是否已有 entryId** ⇒ 插话的消息也会走这条路，
 *     把**上一条正常消息的 fork 切点冲掉**（「③ 重跑 / 重新生成」会从插话那条分叉）。
 *
 * ── 怎么区分「插话」与「正常发送」 ──────────────────────────────────────
 * 用**队列 entryId** 作关联钥匙，而不是文本：
 *   - vendor 边界提交队列条目时写的是 `{ id: item.entryId }`（vendor/…/harness/runtime/
 *     drive/boundary.ts）⇒ pi 侧 `message_end` 带的 entryId **就是前端入队时拿到的那个**。
 *   - 前端提交插话成功时把 entryId 登记进 `queuedEntryIds`（见组件侧）。
 *   ⇒ 事件里的 entryId 命中 `queuedEntryIds` ⇒ 它是插话/尾随 ⇒ 补建气泡；
 *     否则是本轮 run 的**初始 prompt** ⇒ 挂到本地已有的那条 user 消息上。
 *
 * 为什么不用「文本相同」来判断：pi 侧 user 文本是**拼装**过的
 * （skill 前缀 + 直通图片的 `[In=…]` 标记都可能改写它），与用户原话不保证逐字相同。
 *
 * ── 为什么单独成模块 ────────────────────────────────────────────────────
 * 判定逻辑（做什么、落到哪条消息）必须**可单测**：它是「调用点」上的分支，
 * 写在组件里就只能靠静态断言守着 —— 而静态断言会被注释命中（见本仓 2026-10-21 实测）。
 * 这里把「判定」做成纯函数、「应用」做成依赖注入式函数，两者都能行为级验证。
 */
import type { SidebarAttachment } from '@lnkpi/shared'

/** 与组件的插话槽位同形的最小视图（不依赖组件内部类型，便于单测）。 */
export interface QueueBubbleSlotLike {
  /** vendor 队列条目 id = 撤回键，也是 pi 侧 transcript entry id。 */
  entryId?: string
  /** 用户原文（插话在本地留存的文本）。 */
  text: string
  /** 挂起时冻结的参考素材。 */
  attachments?: SidebarAttachment[]
  /** 挂起时冻结的画布选中态。 */
  selectionNodeIds?: string[]
}

/** 与 store 的消息同形的最小视图。 */
export interface QueueBubbleMessageLike {
  role: string
  entryId?: string
}

/**
 * 判定结果。
 * - `skip`：不动作（不是 user 消息 / 幂等重放 / 没有可落点）。
 * - `insert`：这是插话/尾随 ⇒ 补建一条用户气泡。
 * - `attach`：这是本轮初始 prompt ⇒ 把 entryId 挂到本地已有的 user 消息上。
 */
export type QueueBubbleDecision =
  | { kind: 'skip' }
  | { kind: 'insert'; text: string }
  | { kind: 'attach'; index: number }

/**
 * 从 pi 侧 user 消息的 `content` 里抽纯文本。
 *
 * vendor 的 `AgentMessage` 是联合类型，只有 `role: "user"` 那支有 content；
 * 它的 content 可能是字符串，也可能是 `TextContent | ImageContent` 数组。
 * 图片段没有可直接显示的形态（上游 clearQueue 也只回灌文本）⇒ 只取 text 段。
 */
export function extractPiUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { type?: string; text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}

/**
 * 判定「pi 侧来了一条 user 消息」时前端该做什么。**纯函数**，无副作用。
 *
 * @param entryId pi 侧 `message_end` 带的消息 entry id
 * @param messages 本地消息列表（按时间序）
 * @param queuedEntryIds 前端**自己**提交插话时登记的 entryId 集合
 * @param queuedText 插话在本地留存的原文（槽位还在时才有；否则用 pi 侧文本兜底）
 * @param piText pi 侧 user 消息正文（兜底用）
 */
export function decideQueueBubbleSync(input: {
  entryId: string
  messages: readonly QueueBubbleMessageLike[]
  queuedEntryIds: ReadonlySet<string>
  queuedText?: string
  piText?: string
}): QueueBubbleDecision {
  const { entryId, messages, queuedEntryIds } = input
  if (!entryId) return { kind: 'skip' }

  // 幂等：同一 entryId 只处理一次（断线重连会重放事件；重复处理会插出两条气泡）。
  if (messages.some((m) => m.entryId === entryId)) return { kind: 'skip' }

  // 插话/尾随：命中前端自己登记的队列 entryId ⇒ 本地没有气泡（deliverQueued 不插入）
  // ⇒ 此刻补建一条，落点由调用方决定（必须落在 assistant 气泡**之前**）。
  if (queuedEntryIds.has(entryId)) {
    const text = (input.queuedText ?? '').trim() || (input.piText ?? '').trim()
    if (!text) return { kind: 'skip' }
    return { kind: 'insert', text }
  }

  // 本轮初始 prompt：本地已有气泡，把 entryId 挂上去（fork 切点）。
  // ⚠️ 只认「**还没有** entryId」的 user 消息：绝不覆盖已有切点 ——
  //    覆盖会把上一条正常消息的 fork 切点冲掉（「重新生成」从错的地方分叉）。
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m && m.role === 'user' && !m.entryId) return { kind: 'attach', index: i }
  }
  return { kind: 'skip' }
}

/** 应用判定所需的依赖（注入 ⇒ 可单测，不需要挂载组件）。 */
export interface QueueBubbleDeps {
  /** 本地消息列表（可写；用于 attach 时挂 entryId）。 */
  messages: QueueBubbleMessageLike[]
  /** 前端自己提交插话时登记的 entryId。 */
  queuedEntryIds: ReadonlySet<string>
  /** 当前插话槽位（取原文与冻结素材）。 */
  slots: readonly QueueBubbleSlotLike[]
  /** 插入一条用户气泡（由 store 提供实现）。 */
  insertUserMessage: (
    text: string,
    extras: {
      entryId: string
      attachments?: SidebarAttachment[]
      selectionNodeIds?: string[]
    },
  ) => void
}

/**
 * 处理 pi 侧发来的 `message_end`（user 消息）。
 *
 * 只处理 `role === 'user'`：assistant 消息的 entryId 没有「从这条重新生成」的语义。
 */
export function applyPiUserMessageEvent(data: unknown, deps: QueueBubbleDeps): void {
  const d = data as { entryId?: string; message?: { role?: string; content?: unknown } } | null
  if (!d || d.message?.role !== 'user') return
  const entryId = typeof d.entryId === 'string' ? d.entryId : ''
  const slot = deps.slots.find((s) => s.entryId === entryId)
  const decision = decideQueueBubbleSync({
    entryId,
    messages: deps.messages,
    queuedEntryIds: deps.queuedEntryIds,
    queuedText: slot?.text,
    piText: extractPiUserText(d.message?.content),
  })

  if (decision.kind === 'insert') {
    deps.insertUserMessage(decision.text, {
      entryId,
      ...(slot?.attachments?.length ? { attachments: slot.attachments } : {}),
      ...(slot?.selectionNodeIds?.length ? { selectionNodeIds: slot.selectionNodeIds } : {}),
    })
    return
  }
  if (decision.kind === 'attach') {
    const target = deps.messages[decision.index]
    if (target) target.entryId = entryId
  }
}
