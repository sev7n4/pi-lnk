import { computed, ref, type Ref } from 'vue'

/**
 * 原生 `<details>` 折叠契约（2026-10-14）。
 *
 * ## 为什么需要它
 *
 * `<details>` 的展开态**在 DOM 上**，用户点击直接改 DOM，**不经过 Vue**。
 * 一旦把它写成 `<details :open="cond">`，就把「展示默认值」当「受控值」用了：
 * 只要 `cond` 在下次 patch 重新求值为 true，Vue 会把 DOM 的 open 强制写回 ——
 * 用户点了收起，下一个 patch 就弹回。生产反馈「思考点开之后无法收拢」即此。
 *
 * 该缺陷已在两处以不同形态各犯一次：
 * - `AgentExecutionTrace`（2026-10-07 修）：reducer 每次写 `trace.collapsed` 经 watch 把展开态拉回。
 * - `AgentTurnTimeline`（2026-10-14 修）：`:open="part.status === 'running'"`，running 期间恒 true。
 *
 * 两次都只改了单个组件 ⇒ 新增第三个可折叠组件还会再犯。故在此抽**共享契约**。
 *
 * ## 语义分离
 *
 * | 概念 | 含义 | 谁写 |
 * |---|---|---|
 * | 展示默认值 `getDefault()` | 无人干预时的默认形态（如 running 展开 / done 收起） | 产品逻辑 |
 * | 用户意图 `manual` | 用户显式点过之后的选择，**优先级最高** | 用户点击 |
 *
 * `manual === null` 表示「用户还没表达过意图」，此时跟随默认值；
 * 一旦用户点过，默认值不再改写其选择（直到 `reset()`）。
 *
 * ## 用法
 *
 * ```ts
 * const disclosure = useDisclosure(() => props.status === 'running')
 * // 模板：首次渲染跟随默认值，之后由用户意图主导
 * <details :open="disclosure.isOpen.value" @toggle="disclosure.onNativeToggle">
 * ```
 *
 * ⚠️ 调用方须保证同一逻辑块在生命周期内**复用同一实例**（组件内 `ref` 即可），
 * 不要在 `v-for` 里每次渲染新建 —— 那等价于没有状态。
 */
export function useDisclosure(getDefault: () => boolean): {
  /** 实际展开态：用户意图优先，否则展示默认值。 */
  isOpen: Ref<boolean>
  /** 用户点击时调用；内部读原生 DOM 的 open 作为翻转基准。 */
  onNativeToggle: (nativeOpen: boolean) => void
  /** 显式重置用户意图（回到跟随默认值）。仅在逻辑块身份变化时使用。 */
  reset: () => void
  /** 仅供测试：当前是否已有用户意图。 */
  hasManualOverride: Ref<boolean>
} {
  /** null = 用户尚未表达意图；true/false = 用户的显式选择。 */
  const manual = ref<boolean | null>(null)

  const isOpen = computed(() => manual.value ?? getDefault())

  return {
    isOpen,
    hasManualOverride: computed(() => manual.value !== null) as Ref<boolean>,
    onNativeToggle: (nativeOpen: boolean) => {
      // 只有当原生状态与「实际展示态」确实相反时才算用户意图；
      // Vue 因默认值变化主动写回 DOM 时同样会触发 toggle，
      // 那种情况下 nativeOpen === isOpen，应保持 null 让默认值继续生效。
      if (nativeOpen === isOpen.value) return
      manual.value = nativeOpen
    },
    reset: () => {
      manual.value = null
    },
  }
}
