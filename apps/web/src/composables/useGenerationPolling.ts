import { onUnmounted, ref } from 'vue'
import { studioApi, type GenerationRecord } from '@/services/studio-api'
import { DEFAULT_SETTLE_TIMEOUT_MS } from '@/utils/generationPollGate'

export interface GenerationPollTask {
  recordId: string
  nodeId: string
}

export interface GenerationPollingOptions {
  /**
   * 诊断 C3：单节点轮询原实现**无墙钟**——后端若永不结算（进程重启丢任务 /
   * 失败路径自身失败），前端永久转圈。墙钟默认与批量路径
   * `waitForRunGroupMemberSettled` 的 DEFAULT_SETTLE_TIMEOUT_MS（22min）一致；
   * 超时任务被移出轮询并回调本钩子（由调用方把节点置为 error 态）。
   */
  onTimeout?: (task: GenerationPollTask) => void
  /** 墙钟毫秒数，仅供测试注入短值。 */
  maxPollMs?: number
}

interface PollTaskInternal extends GenerationPollTask {
  startedAt: number
}

/** 记录是否仍在进行中（只有这两种状态需要继续轮询）。 */
function isInflightRecordStatus(status: string | undefined): boolean {
  return status === 'generating' || status === 'pending'
}

function taskKey(task: { nodeId: string; recordId: string }): string {
  return `${task.nodeId}:${task.recordId}`
}

export function useGenerationPolling(
  onUpdate: (records: Array<{ task: GenerationPollTask; record: GenerationRecord }>) => void,
  options?: GenerationPollingOptions,
) {
  const timer = ref<ReturnType<typeof setInterval>>()
  const tasks = ref<PollTaskInternal[]>([])

  async function pollOnce() {
    if (!tasks.value.length) return
    // 墙钟：把超时任务移出轮询（先于查询，避免白打一轮请求）
    const maxPollMs = options?.maxPollMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    const now = Date.now()
    const expired = tasks.value.filter((t) => now - t.startedAt > maxPollMs)
    if (expired.length) {
      const expiredKeys = new Set(expired.map((t) => taskKey(t)))
      tasks.value = tasks.value.filter((t) => !expiredKeys.has(taskKey(t)))
      for (const t of expired) options?.onTimeout?.({ recordId: t.recordId, nodeId: t.nodeId })
    }
    if (!tasks.value.length) {
      stop()
      return
    }
    const results: Array<{ task: GenerationPollTask; record: GenerationRecord }> = []
    for (const task of tasks.value) {
      try {
        const { data } = await studioApi.getGeneration(task.recordId)
        results.push({ task, record: data.data })
      } catch {
        // ignore single poll failure
      }
    }
    // Ignore results for tasks removed during await (e.g. cancel → removeByNodeId)
    const active = results.filter(({ task }) =>
      tasks.value.some((t) => t.nodeId === task.nodeId && t.recordId === task.recordId),
    )
    if (active.length) onUpdate(active)

    // 已结算（completed / failed / error / fallback_pending）的任务立即出队。
    //
    // ⚠️ 2026-10-08 回归修复：此前只 `stop()` 计时器而**保留 tasks 内容**，
    // 于是「早已拿到结果的任务」继续留在队列里；画布停留超过墙钟后，任何一次
    // `start()`（agent 交互落地 / loadSession / 换页）触发的 `pollOnce()` 都会
    // 把它们判为 expired 并调用 `onTimeout`，把已经成功的节点刷成 error。
    // 生产实证：某画布 5 个节点上仍有可访问的产物图，服务端记录也是 completed，
    // 却被写成 `error` +「等待生成结果超时，请重试或刷新查看任务历史」。
    const settledKeys = new Set(
      active.filter(({ record }) => !isInflightRecordStatus(record.status)).map(({ task }) => taskKey(task)),
    )
    if (settledKeys.size) {
      tasks.value = tasks.value.filter((t) => !settledKeys.has(taskKey(t)))
    }

    // 仍有未结算任务（含本轮请求失败、需重试的）⇒ 继续；否则停。
    if (!tasks.value.length) stop()
  }

  function start(newTasks: GenerationPollTask[]) {
    const merged = [...tasks.value]
    for (const task of newTasks) {
      if (!merged.some((t) => t.recordId === task.recordId)) {
        merged.push({ ...task, startedAt: Date.now() })
      }
    }
    tasks.value = merged
    stop()
    if (!merged.length) return
    void pollOnce()
    timer.value = setInterval(() => {
      void pollOnce()
    }, 2000)
  }

  function removeByNodeId(nodeId: string) {
    const next = tasks.value.filter((t) => t.nodeId !== nodeId)
    if (next.length === tasks.value.length) return
    tasks.value = next
    if (!next.length) stop()
  }

  function stop() {
    if (timer.value) clearInterval(timer.value)
    timer.value = undefined
  }

  function clearTasks() {
    tasks.value = []
    stop()
  }

  onUnmounted(stop)

  return { start, stop, clearTasks, removeByNodeId }
}

export function parseRecordPromptContent(record: { metadata?: string | null; prompt: string }) {
  if (!record.metadata) return { content: record.prompt, mode: null as string | null }
  try {
    const meta = JSON.parse(record.metadata) as { content?: string; mode?: string; text?: string }
    return {
      content: meta.content ?? meta.text ?? record.prompt,
      mode: meta.mode ?? null,
    }
  } catch {
    return { content: record.prompt, mode: null }
  }
}

export function parseRecordText(record: { metadata?: string | null; prompt: string }) {
  if (!record.metadata) return record.prompt
  try {
    const meta = JSON.parse(record.metadata) as { text?: string }
    return meta.text ?? record.prompt
  } catch {
    return record.prompt
  }
}

export function parseRecordUrl(record: { url?: string | null; metadata?: string | null }) {
  if (record.url) return record.url
  if (!record.metadata) return ''
  try {
    const meta = JSON.parse(record.metadata) as { url?: string; urls?: string[] }
    return meta.url ?? meta.urls?.[0] ?? ''
  } catch {
    return ''
  }
}

export function parseRecordUrls(record: { url?: string | null; metadata?: string | null }): string[] {
  if (!record.metadata) {
    return record.url ? [record.url] : []
  }
  try {
    const meta = JSON.parse(record.metadata) as { url?: string; urls?: string[] }
    if (Array.isArray(meta.urls) && meta.urls.length) return meta.urls.filter(Boolean)
    const single = meta.url ?? record.url
    return single ? [single] : []
  } catch {
    return record.url ? [record.url] : []
  }
}

export function parseRecordLastFrameUrl(record: { metadata?: string | null }): string {
  if (!record.metadata) return ''
  try {
    const meta = JSON.parse(record.metadata) as { lastFrameUrl?: string }
    return String(meta.lastFrameUrl ?? '').trim()
  } catch {
    return ''
  }
}
