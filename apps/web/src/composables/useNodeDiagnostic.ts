import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'
import type { ErrorCode, GenerationDiagnostic, TaskKind } from '@lnkpi/shared'
import { canvasApi } from '@/services/canvas-api'
import { studioApi } from '@/services/studio-api'
import { buildCopyForNode, sharedDiagnosticCache } from '@/utils/generationDiagnostic'
import { copyTextToClipboard } from '@/utils/copyToClipboard'

const FALLBACK_PENDING_HINT = '请确认是否使用平台回退继续，或取消本次生成。'

/**
 * 节点生成诊断的统一取数/复制逻辑（2026-10-07 抽取自 NodeTaskCornerActions）。
 * 角落重试按钮与左上角状态图标共用：异常态的「报错详情」入口统一走这里。
 */
export function useNodeDiagnostic(args: {
  taskKind: MaybeRefOrGetter<TaskKind | undefined>
  taskId: MaybeRefOrGetter<string | undefined>
  errorMessage: MaybeRefOrGetter<string | undefined>
  errorCode: MaybeRefOrGetter<string | undefined>
  /** fallback_pending 态：黄色待确认，带确认引导 hint */
  pending?: MaybeRefOrGetter<boolean>
  nodeId?: MaybeRefOrGetter<string | undefined>
  nodeLabel?: MaybeRefOrGetter<string | undefined>
  sessionId?: MaybeRefOrGetter<string | undefined>
}) {
  const open = ref(false)
  const loading = ref(false)
  const diag = ref<GenerationDiagnostic | null>(null)
  const copyLabel = ref('复制诊断')

  const fallbackMessage = computed(() => {
    if (toValue(args.errorMessage)) return String(toValue(args.errorMessage))
    return toValue(args.pending) ? '平台回退待确认' : '生成失败'
  })

  function buildFallbackDiagnostic(): GenerationDiagnostic {
    const pending = Boolean(toValue(args.pending))
    return {
      userMessage: fallbackMessage.value,
      code: pending ? 'fallback_pending' : ((toValue(args.errorCode) as ErrorCode | undefined) || 'unknown'),
      taskKind: toValue(args.taskKind) || 'generation',
      taskId: toValue(args.taskId) || 'unknown',
      occurredAt: new Date().toISOString(),
      providerSnippet: null,
      hint: pending ? FALLBACK_PENDING_HINT : undefined,
    }
  }

  async function fetchDiagnostic(): Promise<GenerationDiagnostic> {
    const taskId = toValue(args.taskId)
    const taskKind = toValue(args.taskKind)
    if (!taskId || !taskKind) return buildFallbackDiagnostic()
    return sharedDiagnosticCache.get(taskKind, taskId, () =>
      taskKind === 'material'
        ? canvasApi.getMaterialDiagnostic(taskId)
        : studioApi.getGenerationDiagnostic(taskId),
    )
  }

  async function toggle() {
    if (open.value) {
      open.value = false
      return
    }
    open.value = true
    loading.value = true
    copyLabel.value = '复制诊断'
    try {
      diag.value = await fetchDiagnostic()
    } catch {
      diag.value = buildFallbackDiagnostic()
    } finally {
      loading.value = false
    }
  }

  function close() {
    open.value = false
  }

  const popoverMessage = computed(
    () => diag.value?.userMessage || toValue(args.errorMessage) || fallbackMessage.value,
  )
  const popoverHint = computed(() => {
    if (diag.value?.hint) return diag.value.hint
    if (toValue(args.pending)) return FALLBACK_PENDING_HINT
    return undefined
  })

  async function copyDiag() {
    const payload = diag.value || buildFallbackDiagnostic()
    const text = buildCopyForNode(payload, {
      nodeId: toValue(args.nodeId) || undefined,
      nodeLabel: toValue(args.nodeLabel),
      sessionId: toValue(args.sessionId),
    })
    try {
      await copyTextToClipboard(text)
      copyLabel.value = '已复制'
      setTimeout(() => {
        copyLabel.value = '复制诊断'
      }, 1500)
    } catch {
      copyLabel.value = '复制失败'
    }
  }

  return { open, loading, diag, copyLabel, popoverMessage, popoverHint, toggle, close, copyDiag }
}
