import { computed, ref, toRaw, type Ref } from 'vue'
import {
  applyTimelineOps,
  type ApplyTimelineOpsResult,
  type TimelineOp,
  type VideoTimeline,
} from '@lnkpi/shared'

/**
 * P1.4 浮层独立历史栈（规格 §4.4）：与画布级 undo 解耦，按 op 序列细粒度撤销/重做。
 *
 * base = 打开浮层时的服务端快照（只读锚点）；ops = 已执行但未写回的操作序列；
 * cursor = 当前活动 op 数；undo/redo 只移动 cursor，绝不改 base（服务端是唯一真相源）。
 * 预览重放调用 @lnkpi/shared 的 applyTimelineOps —— 与服务端写回同一份 reducer，杜绝双通道语义分叉。
 */
export interface VideoTimelineEditSession {
  preview: Ref<ApplyTimelineOpsResult>
  canUndo: Ref<boolean>
  canRedo: Ref<boolean>
  opCount: Ref<number>
  applyOp: (op: TimelineOp) => boolean
  undo: () => boolean
  redo: () => boolean
  commitOps: () => TimelineOp[]
  reset: (base: VideoTimeline) => void
}

export function createEditSession(
  initialBase: VideoTimeline,
  sources?: Array<{ nodeId: string; type: string; title?: string; url?: string }>,
): VideoTimelineEditSession {
  // 组件传入的 props 是 Vue 响应式 Proxy，structuredClone 无法克隆 ⇒ toRaw 解包。
  let base = structuredClone(toRaw(initialBase))
  let ops: TimelineOp[] = []
  let cursor = 0

  const preview = ref<ApplyTimelineOpsResult>({ ok: true, timeline: structuredClone(base) })
  // ops/cursor 是普通变量（非响应式），用显式 ref 驱动 canUndo/canRedo/opCount，避免 computed 缓存陷阱。
  const state = ref({ cursor: 0, total: 0 })

  function replay() {
    // 确定性 nextId：基于 op 序列索引，undo/redo 预览时片段 id 稳定（服务端提交时才用 randomUUID）。
    // 注意：前端预览的 id 与服务端最终 id 不同，但提交后以服务端回读为准（P1.2 submitTimelineOps）。
    let seq = 0
    preview.value = applyTimelineOps(base, ops.slice(0, cursor), {
      sources,
      nextId: () => `vtseg_prev_${seq++}`,
    })
    state.value = { cursor, total: ops.length }
  }
  replay()

  const canUndo = computed(() => state.value.cursor > 0)
  const canRedo = computed(() => state.value.cursor < state.value.total)

  function applyOp(op: TimelineOp): boolean {
    // 标准编辑器语义：undo 后产生新 op ⇒ 截断 cursor 之后的历史（清空 redo）。
    if (cursor < ops.length) ops = ops.slice(0, cursor)
    ops.push(op)
    cursor += 1
    replay()
    return preview.value.ok
  }

  function undo(): boolean {
    if (cursor <= 0) return false
    cursor -= 1
    replay()
    return true
  }

  function redo(): boolean {
    if (cursor >= ops.length) return false
    cursor += 1
    replay()
    return true
  }

  function commitOps(): TimelineOp[] {
    return structuredClone(ops.slice(0, cursor))
  }

  function reset(nextBase: VideoTimeline) {
    base = structuredClone(toRaw(nextBase))
    ops = []
    cursor = 0
    replay()
  }

  return { preview, canUndo, canRedo, opCount: computed(() => state.value.cursor), applyOp, undo, redo, commitOps, reset }
}
