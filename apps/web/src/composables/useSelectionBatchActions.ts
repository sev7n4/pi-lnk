import { computed } from 'vue'

/**
 * 多选批量操作的派生状态单一出处（2026-10-20 PR3）。
 *
 * 此前这套派生（能否生成 / 有无可重生成 / 纯缺提示词选区 / 整批阻断 / 运行中）
 * 内嵌在 PC 的 `MultiSelectToolbar.vue` 里；移动端 S3 底部动作条要同一套语义，
 * 复制一份必然漂移 ⇒ 抽成 composable，两端共用。**PC 渲染零变更**（同一批
 * computed，只是搬了家）。
 *
 * 口径说明：
 * - `showGenerateButton`：有可执行节点，或（无重生成对象、无阻断、非纯缺词）时保留入口
 *   （PC 历史行为：避免选区无按钮可点）。
 * - `showMissingButton`：纯缺提示词选区——无可执行、无可重生成、无其他阻断，
 *   用「缺提示词」替代静默的「生成 · 0」。
 * - `primary`：运行中一律是「停止」（PC 原是同一个钮态切换，移动端沿用）。
 */
export interface SelectionBatchState {
  runCount: number
  /** 已完成节点的可重新生成数量（planner regenerate 模式） */
  regenCount?: number
  state: 'idle' | 'running' | 'stopping' | 'done'
  /** 整批阻断态：任一 pending_confirm、超过 24 上限、或纯缺提示词选区 */
  blocked?: 'pending_confirm' | 'limit_24' | 'missing_prompt'
  blockedCount?: number
  /** 缺提示词（无可尝试输入）节点数 */
  missingCount?: number
}

export type SelectionBatchBlocked = NonNullable<SelectionBatchState['blocked']>

export const SELECTION_BATCH_BLOCKED_TITLE: Record<SelectionBatchBlocked, string> = {
  pending_confirm: '选区包含待确认节点，点击定位；请在节点上确认生成',
  limit_24: '选区可执行节点超过 24 个上限，请减少选区后重试',
  missing_prompt: '选区节点均未写提示词且无可用上游输出，点击定位第一个问题节点',
}

export const SELECTION_BATCH_MISSING_TITLE = SELECTION_BATCH_BLOCKED_TITLE.missing_prompt

export function useSelectionBatchActions(get: () => SelectionBatchState | undefined) {
  const blocked = computed(() => get()?.blocked ?? null)
  const blockedCount = computed(() => get()?.blockedCount ?? 0)
  const runCount = computed(() => get()?.runCount ?? 0)
  const regenCount = computed(() => get()?.regenCount ?? 0)
  const missingCount = computed(() => get()?.missingCount ?? 0)
  const running = computed(() => {
    const state = get()?.state
    return state === 'running' || state === 'stopping'
  })

  const showMissingButton = computed(
    () =>
      missingCount.value > 0 &&
      runCount.value === 0 &&
      regenCount.value === 0 &&
      !blocked.value,
  )
  const showGenerateButton = computed(
    () =>
      runCount.value > 0 ||
      (regenCount.value === 0 && !blocked.value && !showMissingButton.value),
  )
  const showRegenButton = computed(() => regenCount.value > 0 && !blocked.value)

  /** 主按钮态：运行中 = 停止；否则 = 批量生成（无入口时为 null） */
  const primary = computed<'stop' | 'generate' | null>(() => {
    if (running.value) return 'stop'
    return showGenerateButton.value ? 'generate' : null
  })

  /** warning 徽章：整批阻断优先，其次纯缺提示词 */
  const warning = computed<{ reason: SelectionBatchBlocked; count: number } | null>(() => {
    if (blocked.value) return { reason: blocked.value, count: blockedCount.value }
    if (showMissingButton.value) return { reason: 'missing_prompt', count: missingCount.value }
    return null
  })

  return {
    blocked,
    blockedCount,
    runCount,
    regenCount,
    missingCount,
    running,
    showMissingButton,
    showGenerateButton,
    showRegenButton,
    primary,
    warning,
    blockedTitle: computed(() => (blocked.value ? SELECTION_BATCH_BLOCKED_TITLE[blocked.value] : '')),
    missingTitle: SELECTION_BATCH_MISSING_TITLE,
  }
}