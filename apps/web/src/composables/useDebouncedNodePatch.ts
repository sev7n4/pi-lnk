import { onUnmounted } from 'vue'

export type DebouncedNodePatchOptions = {
  /** Called when a debounced patch settles (or flush), before persist — e.g. undo history commit. */
  onHistoryCommit?: () => void
  /**
   * 诊断 A2：防抖路径的 `persist()` 失败原先是 unhandled rejection——
   * 改动静默丢失、用户零感知。注册本钩子做可感知提示（如 toast）。
   */
  onPersistError?: (err: unknown) => void
}

export function useDebouncedNodePatch(
  applyPatch: (id: string, patch: Record<string, unknown>) => void,
  persist: () => Promise<void>,
  delayMs = 400,
  options?: DebouncedNodePatchOptions,
) {
  let timer: ReturnType<typeof setTimeout> | undefined

  function settle() {
    options?.onHistoryCommit?.()
    return persist()
  }

  function patchNode(id: string, patch: Record<string, unknown>) {
    applyPatch(id, patch)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      settle().catch((err) => options?.onPersistError?.(err))
    }, delayMs)
  }

  async function flush() {
    const hadPending = timer !== undefined
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    // Only commit undo history when a debounced edit was pending.
    // Generate always flushes first; committing on empty flush previously
    // ran cloneSnapshot and could throw before generateForNode ran.
    if (hadPending) options?.onHistoryCommit?.()
    await persist()
  }

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
  })

  return { patchNode, flush }
}
