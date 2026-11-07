import { nextTick, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { normalizeMentionedKeys, type SidebarAttachment } from '@lnkpi/shared'
import { acceptedHint, cancelOutcomeHint, parseQueueDelivery } from '@/components/agent/queueDelivery'
import type { QueueCancelOutcome } from '@/components/agent/queueDelivery'
import { postCancelQueued, postSteerFollowup } from '@/agent/command/agentCommandClient'
import { parseRefMentions } from '@/composables/useRefMentions'
import type MentionInput from '@/components/canvas/MentionInput.vue'

/**
 * Phase 3 strangler-fig 第八刀：把 AgentSideRail 中「Queue-Draft（流式中插话队列）」簇
 * （挂起草稿三态 / 投递 steer·followup / 真撤回 / 取回内容 / 放弃 / applied 推进）收敛到独立 composable。
 *
 * 不变量（与抽取前逐字等价）：
 * - **真实状态所有权仍在组件**：`queuedSlots` / `queuedEntryIds` 由组件声明并注入，
 *   composable 只消费它们并改写其 `.value`；`input` / `sidebar` / `agentThreadId` /
 *   `composerRef` / `planningModel` 同样是组件持有、显式注入。
 * - 返回集只有**函数**（不再返回 ref/computed），故组件侧**无需 `reactive()` 包裹**
 *   （与第七刀 Composer 簇不同：那刀返回了 computed，需要 reactive 解包）。
 * - 全部函数无 emit、无副作用外溢：投递/撤回走 `postSteerFollowup`/`postCancelQueued`，
 *   失败仅 `ElMessage` 提示，登记 `queuedEntryIds` 供 `pi_message_end` 补建气泡判定。
 */

/** 投递通道：steer = 立刻接住；followup = 收尾接住。两种送达时机由用户在气泡上二选一。 */
export type QueueIntent = 'steer' | 'followup'

/** 槽位状态机。 */
export type QueueState = 'pending' | 'accepted' | 'applied' | 'failed'

/** 插话槽位（一条挂起/在队列里的补充消息）。 */
export interface QueuedSlot {
  /** 槽位本地 id（仅用于 v-for 的 key 与逐条操作定位，与服务端 entryId 无关）。 */
  id: string
  text: string
  intent: QueueIntent | null // pending 态尚未决定走哪条通道
  state: QueueState
  /** 成功/失败原因，直接显示在气泡上，不做 toast（流式中弹窗会打断阅读） */
  hint: string
  /**
   * vendor 队列里的条目 id = **撤回键**（2026-10-20）。
   * undefined = 尚未入队（pending/failed）或服务端没回传（老版本）⇒ 不能真撤回。
   */
  entryId?: string
  /** 插话时随消息带上的**参考素材**（2026-10-20 P1-1），挂起那一刻冻结。 */
  attachments?: SidebarAttachment[]
  /** 参考素材顺序（attachment id 列表） */
  refOrder?: string[]
  /** 消息内 @ 提及的 refKey */
  mentionedKeys?: string[]
  /** 画布选中态（SEL-REF 指代信号），同样在挂起时冻结。 */
  selectionNodeIds?: string[]
  /** composer 当前模型（P1-2 带图通道），同样在挂起时冻结。 */
  model?: string
}

/** 挂起草稿的**结果三态**（2026-10-21 hotfix）：
 *  - `queued`：已挂起（草稿已转入气泡）
 *  - `empty`：**根本没有草稿**（唯一允许中止 turn 的情形）
 *  - `full`：槽位已满（草稿保留 + 如实告知，**不得**中止 turn） */
export type QueueDraftOutcome = 'queued' | 'empty' | 'full'

/** 组件注入的 sidebar 最小契约（useSidebarAttachments 返回集的子集，composable 仅消费这两项）。 */
interface QueueSidebarApi {
  toPayload: () => { attachments: SidebarAttachment[]; refOrder: string[] }
  clear: () => void
}

export interface AgentQueueDeps {
  /** 排队槽位数组（组件持有所有权，composable 改写其 .value）。 */
  queuedSlots: Ref<QueuedSlot[]>
  /** 入队 entryId 登记表（组件持有所有权，composable 写入）。 */
  queuedEntryIds: Set<string>
  /** 输入框 v-model 文本（组件持有所有权）。 */
  input: Ref<string>
  /** 待发送引用素材 API（组件持有单例，composable 仅消费 toPayload/clear）。 */
  sidebar: QueueSidebarApi
  /** 当前线程 id（组件持有所有权）。 */
  agentThreadId: Ref<string | null>
  /** MentionInput 实例 ref：取回内容后聚焦。 */
  composerRef: Ref<InstanceType<typeof MentionInput> | null>
  /** composer 当前模型（组件持有所有权）。 */
  planningModel: Ref<string | undefined>
  /** 滚动到底（组件持有函数）。 */
  scrollToBottom: (force?: boolean) => void
  /** props.sessionId 的 getter（避免闭包捕获 props 响应式陷阱）。 */
  getSessionId: () => string
  /** props.selectedNodeIds 的 getter。 */
  getSelectedNodeIds: () => string[] | undefined
  /** agent.pendingQuestion 的 getter（有未作答阻塞卡时文案降级）。 */
  getPendingQuestion: () => unknown | null
}

export interface AgentQueueApi {
  queueDraftAsPending: () => Promise<QueueDraftOutcome>
  deliverQueued: (intent: QueueIntent, slot?: QueuedSlot) => Promise<boolean>
  withdrawQueued: (slot?: QueuedSlot) => Promise<boolean>
  dismissQueued: (slot?: QueuedSlot) => void
  requeueQueued: (slot?: QueuedSlot) => Promise<void>
  markQueueApplied: () => void
}

const MAX_QUEUED_SLOTS = 5

export function useAgentQueue(deps: AgentQueueDeps): AgentQueueApi {
  const {
    queuedSlots,
    queuedEntryIds,
    input,
    sidebar,
    agentThreadId,
    composerRef,
    planningModel,
    scrollToBottom,
    getSessionId,
    getSelectedNodeIds,
    getPendingQuestion,
  } = deps

  let slotSeq = 0
  function nextSlotId(): string {
    slotSeq += 1
    return `q-${slotSeq}`
  }

  /** 「agent 已经接住」的确定性事件触发：只推进最早那条 accepted（FIFO，与服务端消费同向）。 */
  function markQueueApplied() {
    const slot = queuedSlots.value.find((s) => s.state === 'accepted')
    if (!slot) return
    slot.state = 'applied'
    slot.hint = '已接住 · agent 正在处理你的补充'
  }

  /**
   * 把槽位里的消息投递到 vendor 队列（steering 或 followUp 通道）。
   * 「算不算真的入队」判定在 queueDelivery.ts（HTTP 200 + queued:false 算失败）。
   * 失败时消息不从用户眼皮底下蒸发 —— 槽位留在 failed 态，动作区给出「取回内容」。
   */
  async function deliverQueued(intent: QueueIntent, slot?: QueuedSlot): Promise<boolean> {
    const target = slot ?? queuedSlots.value.find((s) => s.state === 'pending')
    if (!target || target.text.trim() === '' || target.state !== 'pending') return false
    target.state = 'pending'
    target.hint = ''
    try {
      const res = await postSteerFollowup(intent, {
        sessionId: getSessionId(),
        threadId: agentThreadId.value,
        text: target.text,
        // ⭐ 2026-10-20 P1-1：带上挂起时冻结的参考素材与画布选中态。
        ...(target.attachments?.length ? { attachments: target.attachments } : {}),
        ...(target.refOrder?.length ? { refOrder: target.refOrder } : {}),
        ...(target.mentionedKeys?.length ? { mentionedKeys: target.mentionedKeys } : {}),
        ...(target.selectionNodeIds?.length ? { selectedNodeIds: target.selectionNodeIds } : {}),
        // ⭐ P1-2：composer 模型随消息冻结（Nest 据此做 vision 门控组装直通图片）。
        ...(target.model?.trim() ? { model: target.model } : {}),
      })
      const body: unknown = await res.json().catch(() => null)
      const verdict = parseQueueDelivery({ ok: res.ok, status: res.status, body })
      if (!verdict.delivered) {
        throw new Error(verdict.reason)
      }
      // ⭐ 收回 entryId（2026-10-20）：服务端把它当成撤回键回传。
      const outer = body as { data?: { entryId?: string } } | null
      target.entryId = typeof outer?.data?.entryId === 'string' ? outer.data.entryId : undefined
      // ⚠️ 登记后**不再移除**：用户点「放弃」只是收掉本地气泡，服务端那条仍会被消费。
      if (target.entryId) queuedEntryIds.add(target.entryId)
      target.state = 'accepted'
      // 有未作答的卡时不能说「已并入当前回答」。
      target.hint = acceptedHint(intent, getPendingQuestion() !== null)
      return true
    } catch (err) {
      target.state = 'failed'
      target.hint = err instanceof Error ? err.message : '投递失败'
      return false
    }
  }

  /**
   * 从 vendor 队列撤回已入队的这条（2026-10-20，对齐上游 AgentLane.cancelQueued）。
   * 三态必须分开处理：cancelled 真撤回；already_consumed 收气泡但如实告知；
   * not_found 收气泡；撤回失败（网络/服务不可用）时**保留气泡**。
   */
  async function withdrawQueued(slot?: QueuedSlot): Promise<boolean> {
    const target = slot ?? queuedSlots.value.find((s) => s.entryId !== undefined)
    if (!target) return false
    if (!target.entryId) {
      // 没拿到 entryId（老服务端 / 入队响应缺字段）：只能收掉前端槽位，如实说明撤不干净
      if (target.state !== 'pending' && target.state !== 'failed') {
        ElMessage.info('这条已送达，收回不了 —— 撤回需要入队时拿到的凭据（当前服务端版本暂不支持）')
      }
      dismissQueued(target)
      return false
    }
    try {
      const res = await postCancelQueued({
        sessionId: getSessionId(),
        threadId: agentThreadId.value,
        entryId: target.entryId,
      })
      const body: unknown = await res.json().catch(() => null)
      if (!parseQueueDelivery({ ok: res.ok, status: res.status, body }).delivered) {
        throw new Error('撤回请求未被接受')
      }
      const outcome =
        (body as { data?: { outcome?: QueueCancelOutcome } } | null)?.data?.outcome ?? 'not_found'
      if (outcome === 'already_consumed') {
        ElMessage.info(cancelOutcomeHint('already_consumed'))
      }
      dismissQueued(target)
      return outcome === 'cancelled'
    } catch (err) {
      // 失败时**不收气泡**：服务端那条还在，假装撤回会让用户以为撤掉了
      ElMessage.error(err instanceof Error ? err.message : '撤回失败，请重试')
      return false
    }
  }

  /**
   * 流式中把当前草稿挂成待发气泡（不直接投递，动作权留给用户选 steer/followUp）。
   * 参考素材与选中态在挂起这一刻冻结（与正常发送同口径）。
   * @returns 挂起结果三态（见 {@link QueueDraftOutcome}）。
   */
  async function queueDraftAsPending(): Promise<QueueDraftOutcome> {
    const text = input.value
    if (!text.trim()) return 'empty'
    // ⭐ 槽位已满 ⇒ **不吞草稿**：清空输入框却挂不上去，等于又一次「消息凭空消失」。
    if (queuedSlots.value.length >= MAX_QUEUED_SLOTS) {
      ElMessage.warning(`最多同时排 ${MAX_QUEUED_SLOTS} 条补充，先处理掉一条再发`)
      return 'full'
    }
    input.value = ''
    // 冻结参考素材（芯片）与画布选中态 —— 与 sendMessage 同一口径
    const { attachments: pendingAttachments, refOrder: pendingRefOrder } = sidebar.toPayload()
    const attachments = pendingAttachments
    const mentionedKeys = normalizeMentionedKeys(parseRefMentions(text)) ?? []
    const selectionNodeIds = getSelectedNodeIds()?.length ? getSelectedNodeIds()!.slice() : []
    // P1-2：composer 当前模型随消息冻结（Nest 据此做 vision 门控组装直通图片）
    const model = planningModel.value?.trim() || undefined
    queuedSlots.value = [
      ...queuedSlots.value,
      {
        id: nextSlotId(),
        text,
        intent: null,
        state: 'pending',
        hint: '',
        ...(attachments.length ? { attachments, refOrder: pendingRefOrder } : {}),
        ...(mentionedKeys.length ? { mentionedKeys } : {}),
        ...(selectionNodeIds.length ? { selectionNodeIds } : {}),
        ...(model ? { model } : {}),
      },
    ]
    // 素材已随消息冻结 ⇒ 清掉侧栏的待发芯片，避免下一条消息重复带上同一批
    if (attachments.length) sidebar.clear()
    await nextTick()
    scrollToBottom(true)
    return 'queued'
  }

  /** 收掉一条气泡：给了目标就只收这一条；没给（兼容旧调用 / 键盘路径）收最早那条。 */
  function dismissQueued(slot?: QueuedSlot) {
    if (!slot) {
      queuedSlots.value = queuedSlots.value.slice(1)
      return
    }
    queuedSlots.value = queuedSlots.value.filter((s) => s.id !== slot.id)
  }

  /**
   * ✎ 取回内容：把消息退回输入框（不另开卡片），投递未成功时这是唯一的挽回入口。
   * ⚠️ 已入队的槽位取回时**必须先真撤回**，否则服务端那条还在队列里，用户改一改再发会同时存在两条。
   * pending / failed 态本来就没入队，直接退文字即可。
   */
  async function requeueQueued(slot?: QueuedSlot) {
    const target = slot ?? queuedSlots.value[0]
    if (!target) return
    const wasDelivered = target.entryId !== undefined
    const text = target.text
    if (wasDelivered) {
      await withdrawQueued(target)
    }
    // withdrawQueued 失败时它保留气泡（该槽位仍在 queuedSlots 里）⇒ 这里不再覆写
    if (!queuedSlots.value.some((s) => s.id === target.id)) return
    // 已有草稿时不覆盖：与 abort 回灌同款语义，把取回的文字追加在后面
    input.value = input.value.trim() ? `${input.value.trim()}\n\n${text}` : text
    dismissQueued(target)
    nextTick(() => composerRef.value?.focus())
  }

  return {
    queueDraftAsPending,
    deliverQueued,
    withdrawQueued,
    dismissQueued,
    requeueQueued,
    markQueueApplied,
  }
}
