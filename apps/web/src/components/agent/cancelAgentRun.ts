export interface RecoveredQueueItem {
  /** 原队列标签：插话 / 尾随指令。 */
  kind: 'steer' | 'followUp'
  /** 消息文本。 */
  text: string
}

export interface CancelAgentRunResult {
  apiOk: boolean
  skipped?: boolean
  completedTasks?: number
  totalTasks?: number
  gatePreserved?: boolean
  /**
   * ⭐ abort 时被服务端销毁、并从 vendor 队列里**吐回**的插队消息（2026-10-20）。
   *
   * vendor 的 `requestOperationAbort` 会把 inbox 里的 steer/followUp 删掉（pending entry
   * 也没了，**不可恢复**），但把内容返给调用方。我们此前丢弃了它 ⇒ 用户插队的消息在
   * 孤儿/看护结算路径上**静默消失**。现在由服务端透出，前端把它放回输入框
   * （对齐上游 coding-agent 的 `clearQueue()` 行为）。
   */
  recovered?: RecoveredQueueItem[]
}

export async function cancelAgentRun(opts: {
  threadId: string
  sessionId: string
  abort: () => void
  postCancel?: (body: {
    threadId: string
    sessionId: string
    reason: 'user'
  }) => Promise<unknown>
}): Promise<CancelAgentRunResult> {
  const result: CancelAgentRunResult = { apiOk: false }

  try {
    if (opts.postCancel) {
      const res = (await opts.postCancel({
        threadId: opts.threadId,
        sessionId: opts.sessionId,
        reason: 'user',
      })) as {
        data?: {
          ok?: boolean
          skipped?: boolean
          completedTasks?: number
          totalTasks?: number
          gatePreserved?: boolean
          recovered?: RecoveredQueueItem[]
        }
      }
      result.apiOk = res?.data?.ok === true
      result.skipped = res?.data?.skipped
      result.gatePreserved = res?.data?.gatePreserved
      if (typeof res?.data?.completedTasks === 'number') {
        result.completedTasks = res.data.completedTasks
      }
      if (typeof res?.data?.totalTasks === 'number') {
        result.totalTasks = res.data.totalTasks
      }
      // ⭐ 只放行结构合法的项：kind 必须是两值之一、text 必须是字符串。
      // 形状不对的（老服务端 / 未来版本）一律丢弃 —— 把脏数据塞进用户输入框比不还原更糟。
      result.recovered = Array.isArray(res?.data?.recovered)
        ? res.data.recovered.filter(
            (item): item is RecoveredQueueItem =>
              typeof item?.text === 'string' &&
              (item.kind === 'steer' || item.kind === 'followUp'),
          )
        : []
    }
  } catch {
    result.apiOk = false
  } finally {
    opts.abort()
  }

  return result
}

/**
 * 把被 abort 销毁的插队消息还原成「可回灌的文本」。
 *
 * 多条时用空行分隔（保留分段感），空文本的消息**跳过**（回灌空白没有意义）。
 * 返回空串 ⇒ 没有可回灌的内容（正常取消路径就是如此：队列根本没被删）。
 */
export function recoveredQueueText(items?: RecoveredQueueItem[]): string {
  if (!items?.length) return ''
  return items
    .map((item) => item.text?.trim() ?? '')
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/** Callout text for a stopped run; mirrors the runtime cancelled presentation. */
export function cancelledCalloutTextFromProgress(
  completedTasks?: number,
  totalTasks?: number,
): string | null {
  if (typeof completedTasks !== 'number' || typeof totalTasks !== 'number') return null
  if (totalTasks <= 0) return null
  const done = Math.max(0, completedTasks)
  const total = Math.max(done, totalTasks)
  return `已停止出图（完成 ${done}/${total}）。直接说修改意见，或点「发起新任务」。`
}
