import { onUnmounted, ref } from 'vue'
import { isStreamStale } from '@/components/agent/streamRecovery'

export interface UseAgentStreamOptions {
  /** Called once when SSE goes stale during an active stream. */
  onStale?: () => void
  /** How often to check staleness while streaming (ms). */
  pollMs?: number
}

/**
 * W12: Monitor an active agent SSE stream for heartbeat staleness.
 * Generation record polling stays independent (see useGenerationPolling).
 */
export function useAgentStream(options: UseAgentStreamOptions = {}) {
  const unreachable = ref(false)
  const lastActivityAt = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  let monitoring = false
  let staleNotified = false

  function touch() {
    lastActivityAt.value = Date.now()
    staleNotified = false
    if (unreachable.value) unreachable.value = false
  }

  function start() {
    stop()
    monitoring = true
    staleNotified = false
    unreachable.value = false
    lastActivityAt.value = Date.now()
    const pollMs = options.pollMs ?? 5000
    timer = setInterval(() => {
      if (!monitoring) return
      if (isStreamStale(lastActivityAt.value) && !staleNotified) {
        staleNotified = true
        unreachable.value = true
        options.onStale?.()
      }
    }, pollMs)
  }

  function stop() {
    monitoring = false
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function reset() {
    unreachable.value = false
    staleNotified = false
    lastActivityAt.value = Date.now()
  }

  onUnmounted(stop)

  return { unreachable, lastActivityAt, touch, start, stop, reset }
}

// PHASE_LABELS + formatPhaseLabel 已退役（P2#10 死代码清理）：
// pi 路径无 phase_hint 事件，前端无消费方。计划/进度叙事改由 phaseAggregator 承担。
