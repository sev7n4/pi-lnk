import { ref, watch } from 'vue'

export type MinimapExpandedState = 0 | 1 | 2
export type GridVariant = 'dots' | 'lines'
export type EdgeDashStyle = 'solid' | 'dashed'

export interface CanvasViewportSettings {
  gridVisible: boolean
  gridVariant: GridVariant
  gridGap: number
  gridDotSize: number
  gridColor: string
  minimapExpanded: MinimapExpandedState
  snapToGrid: boolean
  edgeAnimated: boolean
  edgeWidth: number
  edgeColor: string
  edgeGlow: boolean
  edgeDash: EdgeDashStyle
  viewLocked: boolean
  bottomToolbarScale: number
}

const STORAGE_KEY = 'lnkpi-canvas-viewport-settings'

/** SP-F Q1（评审 Important#1）：移动端兜底需要区分「用户改过宽度」与「默认值」，故导出 */
export const DEFAULT_EDGE_WIDTH = 1.5

const defaults: CanvasViewportSettings = {
  gridVisible: true,
  gridVariant: 'dots',
  gridGap: 20,
  gridDotSize: 1.2,
  gridColor: 'rgba(255,255,255,0.08)',
  minimapExpanded: 0,
  snapToGrid: true,
  edgeAnimated: true,
  edgeWidth: DEFAULT_EDGE_WIDTH,
  edgeColor: '',
  edgeGlow: false,
  edgeDash: 'solid',
  viewLocked: false,
  bottomToolbarScale: 1,
}

function loadSettings(): CanvasViewportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaults }
    return { ...defaults, ...JSON.parse(raw) as Partial<CanvasViewportSettings> }
  } catch {
    return { ...defaults }
  }
}

export function useCanvasViewportSettings() {
  const settings = ref<CanvasViewportSettings>(loadSettings())

  watch(
    settings,
    (value) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    },
    { deep: true },
  )

  function setMinimapState(state: MinimapExpandedState) {
    settings.value.minimapExpanded = state
  }

  function toggleMinimap() {
    settings.value.minimapExpanded = settings.value.minimapExpanded === 0 ? 1 : 0
  }

  function cycleMinimap() {
    const next = ((settings.value.minimapExpanded + 1) % 3) as MinimapExpandedState
    settings.value.minimapExpanded = next
  }

  function toggleSnapToGrid() {
    settings.value.snapToGrid = !settings.value.snapToGrid
  }

  return {
    settings,
    setMinimapState,
    toggleMinimap,
    cycleMinimap,
    toggleSnapToGrid,
  }
}
