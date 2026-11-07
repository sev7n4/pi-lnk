// Phase 3 拆解 spike #1：从 AgentSideRail.vue 抽离「dock/panel 定位 + 桌面浮窗拖拽/调宽 + 移动端裸条高度发布」。
// 设计为纯逻辑组合式（不持有模板）：父组件保留 open/floating 等状态所有权，本组合式只消费这些 ref，
// 暴露定位计算（panelTeleported / asidePanelWidth）与交互处理器（toggleFloating / startDrag / startResize）。
// 移动端裸条高度通过 CSS 变量 `--lnk-agent-dock-h` 发布给底部锚定元素（DockStudioToolbar / MobileCanvasCreateFab 等），
// 该副作用亦收敛到此组合式，使「桌面 vs 移动」分支点从 AgentSideRail 散点收敛到单一可测模块。
import { computed, onMounted, onUnmounted, watch, type Ref } from 'vue'

export const PANEL_MIN_W = 420
export const PANEL_MAX_W = 760

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export interface AgentDockState {
  open: Ref<boolean>
  floating: Ref<boolean>
  panelWidth: Ref<number>
  floatWidth: Ref<number>
  floatPos: Ref<{ x: number; y: number }>
  dragging: Ref<boolean>
  resizing: Ref<boolean>
  bareBarRef: Ref<HTMLElement | null>
  panelShellRef: Ref<HTMLElement | null>
  isMobileLayout: Ref<boolean>
}

const AGENT_DOCK_CSS_VAR = '--lnk-agent-dock-h'

export function useAgentDock(state: AgentDockState) {
  const {
    open, floating, panelWidth, floatWidth, floatPos,
    dragging, resizing, bareBarRef, panelShellRef, isMobileLayout,
  } = state

  /** 面板是否需 Teleport 到 body：浮窗或移动端贴底裸条。 */
  const panelTeleported = computed(() => floating.value || isMobileLayout.value)

  /** 桌面 dock 侧栏宽度：非展开 / 浮窗 / 移动端 均塌缩为 0。 */
  const asidePanelWidth = computed(() => {
    if (!open.value || floating.value || isMobileLayout.value) return '0px'
    return `${panelWidth.value}px`
  })

  function publishMobileDockHeight(height: number): void {
    document.documentElement.style.setProperty(
      AGENT_DOCK_CSS_VAR,
      `${Math.max(0, Math.round(height))}px`,
    )
  }

  let mobileDockRO: ResizeObserver | null = null

  function ensureMobileDockRO(): void {
    if (!isMobileLayout.value || mobileDockRO) return
    mobileDockRO = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0
      publishMobileDockHeight(height)
    })
    // 移动端首载时 watch(immediate) 先于模板挂载，ref 可能还是 null ⇒ onMounted 再兜底补挂
    if (bareBarRef.value) mobileDockRO.observe(bareBarRef.value)
    else if (panelShellRef.value) mobileDockRO.observe(panelShellRef.value)
  }

  watch(
    () => bareBarRef.value,
    (el) => {
      if (!isMobileLayout.value || !mobileDockRO || !el) return
      mobileDockRO.disconnect()
      mobileDockRO.observe(el)
      publishMobileDockHeight(el.getBoundingClientRect().height)
    },
    { immediate: true },
  )

  watch(
    isMobileLayout,
    (mobile) => {
      if (mobile) {
        ensureMobileDockRO()
      } else if (mobileDockRO) {
        mobileDockRO.disconnect()
        mobileDockRO = null
        document.documentElement.style.setProperty(AGENT_DOCK_CSS_VAR, '0px')
      }
    },
    { immediate: true },
  )

  onMounted(ensureMobileDockRO)
  onUnmounted(() => {
    mobileDockRO?.disconnect()
    mobileDockRO = null
    publishMobileDockHeight(0)
  })

  /** 浮窗 ↔ 停靠侧栏切换（移动端无此概念，no-op）。 */
  function toggleFloating(): void {
    if (isMobileLayout.value) return
    floating.value = !floating.value
    if (floating.value) {
      // 首次浮出时把面板放到画布右侧默认位置
      floatWidth.value = clamp(panelWidth.value, PANEL_MIN_W, window.innerWidth - 48)
      floatPos.value = {
        x: Math.max(16, window.innerWidth - floatWidth.value - 40),
        y: 56,
      }
    }
  }

  /* ---- 浮窗拖拽（按住头部空白处移动） ---- */
  function startDrag(event: MouseEvent): void {
    if (!floating.value || isMobileLayout.value) return
    if ((event.target as HTMLElement).closest('button, input, textarea')) return
    event.preventDefault()
    dragging.value = true
    const offsetX = event.clientX - floatPos.value.x
    const offsetY = event.clientY - floatPos.value.y
    const onMove = (ev: MouseEvent) => {
      floatPos.value = {
        x: clamp(ev.clientX - offsetX, -floatWidth.value + 120, window.innerWidth - 120),
        y: clamp(ev.clientY - offsetY, 0, window.innerHeight - 64),
      }
    }
    const onUp = () => {
      dragging.value = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /* ---- 左边缘拖拉调宽（侧栏 / 浮窗通用） ---- */
  function startResize(event: MouseEvent): void {
    if (isMobileLayout.value) return
    event.preventDefault()
    resizing.value = true
    const floatRight = floatPos.value.x + floatWidth.value
    const onMove = (ev: MouseEvent) => {
      if (floating.value) {
        const width = clamp(floatRight - ev.clientX, PANEL_MIN_W, PANEL_MAX_W)
        floatWidth.value = width
        floatPos.value = { ...floatPos.value, x: floatRight - width }
      } else {
        // 桌面 docks 在左侧（CanvasPage 用 flex-row-reverse 把侧栏翻到左）：
        // 侧栏左缘贴屏幕 x=0，宽度即鼠标到左缘的距离。
        panelWidth.value = clamp(ev.clientX, PANEL_MIN_W, PANEL_MAX_W)
      }
    }
    const onUp = () => {
      resizing.value = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return { panelTeleported, asidePanelWidth, toggleFloating, startDrag, startResize }
}
