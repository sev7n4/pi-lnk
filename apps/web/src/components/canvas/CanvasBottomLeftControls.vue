<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { MiniMap } from '@vue-flow/minimap'
import { useVueFlow } from '@vue-flow/core'
import { useClickOutside } from '@/composables/useClickOutside'
import type { CanvasViewportSettings } from '@/composables/useCanvasViewportSettings'
import CanvasLocatePinIcon from '@/components/shared/CanvasLocatePinIcon.vue'
import { miniMapNodeColor } from '@/components/canvas/minimapNodeColors'

const props = defineProps<{
  settings: CanvasViewportSettings
  nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>
}>()

const emit = defineEmits<{
  'update:settings': [patch: Partial<CanvasViewportSettings>]
  cycleMinimap: []
}>()

const { viewport, zoomTo, fitView, nodes: flowNodes, setCenter } = useVueFlow()
const showSettings = ref(false)
const showZoomMenu = ref(false)
const showMinimapPopover = ref(false)
const showListPanel = ref(false)
const minimapBodyRef = ref<HTMLElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

useClickOutside(rootRef, () => {
  showSettings.value = false
  showZoomMenu.value = false
  if (props.settings.minimapExpanded !== 0) {
    emit('update:settings', { minimapExpanded: 0 })
  }
})

/** 浮层 Esc 关闭（Design_system §3.4 popover 契约）：临时面板必须可键退。 */
function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.key !== 'Escape') return
  showSettings.value = false
  showZoomMenu.value = false
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

/**
 * IA 减法（9→4）：缩放只保留「档位 + 读数」一个入口。
 * PC 日常缩放走 Ctrl+滚轮 / 触控板捏合，滑块与 ± 是重复输入通道；
 * 档位给键盘与无 Ctrl 场景兜底。zoomBy / 滑块 / ± 一并退休。
 */
const ZOOM_STEPS = [50, 100, 150, 200] as const
const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100))

function applyZoom(percent: number) {
  void zoomTo(percent / 100, { duration: 200 })
  showZoomMenu.value = false
}

function toggleZoomMenu() {
  showZoomMenu.value = !showZoomMenu.value
  if (showZoomMenu.value) showSettings.value = false
}

function toggleSettings() {
  showSettings.value = !showSettings.value
  if (showSettings.value) showZoomMenu.value = false
}

const typeLabels: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  prompt: '提示词',
}

const search = ref('')

const filteredNodes = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.nodes
  return props.nodes.filter((n) => {
    const data = n.data
    const label = String(data.title ?? data.prompt ?? data.content ?? n.id).toLowerCase()
    const type = String(n.type ?? '').toLowerCase()
    return label.includes(q) || type.includes(q)
  })
})

const groupedNodes = computed(() => {
  const map = new Map<string, typeof filteredNodes.value>()
  for (const node of filteredNodes.value) {
    const key = String(node.type ?? 'other')
    const bucket = map.get(key) ?? []
    bucket.push(node)
    map.set(key, bucket)
  }
  return [...map.entries()]
})

function patch(patch: Partial<CanvasViewportSettings>) {
  emit('update:settings', patch)
}

function resetView() {
  void fitView({ padding: 0.2, duration: 200 })
}

function fitAndCloseZoomMenu() {
  showZoomMenu.value = false
  resetView()
}

function focusNode(id: string) {
  void fitView({ nodes: [id], padding: 0.4, duration: 250, maxZoom: 1.1 })
  showListPanel.value = false
}

function onMinimapClick(event: MouseEvent) {
  const el = minimapBodyRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return

  const mapNodes = flowNodes.value.filter((n) => !n.hidden)
  if (!mapNodes.length) return

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of mapNodes) {
    const w = node.dimensions?.width || 280
    const h = node.dimensions?.height || 160
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + w)
    maxY = Math.max(maxY, node.position.y + h)
  }

  const pad = 40
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  const worldW = Math.max(1, maxX - minX)
  const worldH = Math.max(1, maxY - minY)

  const localX = event.clientX - rect.left
  const localY = event.clientY - rect.top
  const flowX = minX + (localX / rect.width) * worldW
  const flowY = minY + (localY / rect.height) * worldH

  let bestId: string | null = null
  let bestDist = Infinity
  for (const node of mapNodes) {
    const w = node.dimensions?.width || 280
    const h = node.dimensions?.height || 160
    const cx = node.position.x + w / 2
    const cy = node.position.y + h / 2
    const inside =
      flowX >= node.position.x &&
      flowX <= node.position.x + w &&
      flowY >= node.position.y &&
      flowY <= node.position.y + h
    const dist = Math.hypot(flowX - cx, flowY - cy)
    if (inside || dist < Math.min(w, h) * 0.6) {
      if (dist < bestDist) {
        bestDist = dist
        bestId = node.id
      }
    }
  }

  if (bestId) {
    focusNode(bestId)
    return
  }

  void setCenter(flowX, flowY, { zoom: viewport.value.zoom, duration: 250 })
}

function nodeLabel(node: { id: string; type?: string; data: Record<string, unknown> }) {
  const data = node.data
  return String(data.title ?? data.prompt ?? data.content ?? node.id).slice(0, 36)
}

function onMapToggle() {
  emit('cycleMinimap')
}

const mapActive = computed(() => props.settings.minimapExpanded > 0)

watch(
  () => props.settings.minimapExpanded,
  (state) => {
    showListPanel.value = state === 2
    showMinimapPopover.value = state === 1
  },
  { immediate: true },
)
</script>

<template>
  <div ref="rootRef" class="canvas-bottom-toolbar relative w-max">
    <!-- 小地图浮层：surface-overlay + 锚链阴影，圆角/间距走组件令牌 -->
    <div
      v-if="showMinimapPopover && settings.minimapExpanded === 1"
      class="dock-popover dock-popover--minimap pointer-events-auto absolute bottom-full left-0 mb-2 overflow-hidden"
      role="group"
      aria-label="画布小地图"
      @click.stop
    >
      <div class="dock-popover__head">
        <span class="dock-popover__title">小地图</span>
        <span class="dock-popover__hint">点击定位</span>
      </div>
      <div
        ref="minimapBodyRef"
        class="minimap-body"
        @click.stop="onMinimapClick"
      >
        <MiniMap
          :pannable="true"
          :zoomable="true"
          :node-color="miniMapNodeColor"
          mask-color="rgba(109, 93, 252, 0.14)"
          mask-stroke-color="rgba(138, 125, 255, 0.7)"
          :mask-stroke-width="1.5"
          class="popover-minimap"
        />
      </div>
    </div>

    <!-- 节点列表浮层：与设置浮层共用 dock-popover 表面规范 -->
    <div
      v-if="showListPanel && settings.minimapExpanded === 2"
      class="dock-popover dock-popover--list pointer-events-auto absolute bottom-full left-0 mb-2"
      role="group"
      aria-label="节点列表"
      @click.stop
    >
      <div class="dock-popover__head">
        <span class="dock-popover__title">节点列表</span>
        <span class="dock-popover__hint">点击定位</span>
      </div>
      <input
        v-model="search"
        class="dock-input mb-2 w-full"
        type="search"
        aria-label="搜索节点"
        placeholder="搜索节点..."
      >
      <div class="dock-scroll">
        <div v-for="[type, items] in groupedNodes" :key="type" class="dock-group">
          <p class="dock-caption">
            {{ typeLabels[type] ?? type }} · {{ items.length }}
          </p>
          <button
            v-for="node in items"
            :key="node.id"
            type="button"
            class="dock-item"
            @click="focusNode(node.id)"
          >
            <CanvasLocatePinIcon :size="14" class="shrink-0 opacity-70" />
            <span class="min-w-0 truncate">{{ nodeLabel(node) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 缩放档位浮层：唯一的缩放入口（读数 + 档位二合一） -->
    <div
      v-if="showZoomMenu"
      class="dock-popover dock-popover--zoom pointer-events-auto absolute bottom-full left-1/2 mb-2 -translate-x-1/2"
      role="group"
      aria-label="缩放档位"
      @click.stop
    >
      <button
        v-for="step in ZOOM_STEPS"
        :key="step"
        type="button"
        class="dock-step"
        :class="{ 'is-on': zoomPercent === step }"
        :aria-current="zoomPercent === step ? 'true' : undefined"
        @click="applyZoom(step)"
      >
        {{ step }}%
      </button>
      <div class="dock-popover__rule" />
      <button type="button" class="dock-step" @click="fitAndCloseZoomMenu">
        适应画布
      </button>
    </div>

    <!-- 设置浮层：原「连线设置」与「画布设置」两个 popover 合并为一处两栏 -->
    <div
      v-if="showSettings"
      class="dock-popover dock-popover--settings pointer-events-auto absolute bottom-full right-0 mb-2"
      role="group"
      aria-label="画布设置"
      @click.stop
    >
      <div class="dock-scroll dock-scroll--settings">
        <section>
          <h3 class="dock-section-title">视图</h3>
          <div class="dock-row">
            <span class="dock-caption">网格底纹</span>
            <button
              type="button"
              class="dock-seg"
              :class="{ 'is-on': settings.gridVisible }"
              @click="patch({ gridVisible: !settings.gridVisible })"
            >
              {{ settings.gridVisible ? '显示' : '隐藏' }}
            </button>
          </div>
          <div class="dock-row">
            <span class="dock-caption">网格样式</span>
            <div class="dock-seg-group">
              <button
                type="button"
                class="dock-seg"
                :class="{ 'is-on': settings.gridVariant === 'dots' }"
                @click="patch({ gridVariant: 'dots' })"
              >
                点阵
              </button>
              <button
                type="button"
                class="dock-seg"
                :class="{ 'is-on': settings.gridVariant === 'lines' }"
                @click="patch({ gridVariant: 'lines' })"
              >
                线格
              </button>
            </div>
          </div>
          <label class="dock-field">
            <span class="dock-caption">网格间距 {{ settings.gridGap }}px</span>
            <input
              type="range"
              class="dock-range"
              min="8"
              max="48"
              step="2"
              aria-label="网格间距"
              :value="settings.gridGap"
              @input="patch({ gridGap: Number(($event.target as HTMLInputElement).value) })"
            >
          </label>
          <div class="dock-row">
            <span class="dock-caption">节点吸附网格</span>
            <button
              type="button"
              class="dock-seg"
              :class="{ 'is-on': settings.snapToGrid }"
              title="拖动节点时对齐网格，便于整齐排版"
              @click="patch({ snapToGrid: !settings.snapToGrid })"
            >
              {{ settings.snapToGrid ? '开' : '关' }}
            </button>
          </div>
          <div class="dock-row">
            <span class="dock-caption">锁定视图</span>
            <button
              type="button"
              class="dock-seg"
              :class="{ 'is-on': settings.viewLocked }"
              @click="patch({ viewLocked: !settings.viewLocked })"
            >
              {{ settings.viewLocked ? '已锁' : '未锁' }}
            </button>
          </div>
        </section>

        <div class="dock-popover__rule dock-popover__rule--section" />

        <section>
          <h3 class="dock-section-title">连线</h3>
          <div class="dock-row">
            <span class="dock-caption">流动动画</span>
            <button
              type="button"
              class="dock-seg"
              :class="{ 'is-on': settings.edgeAnimated }"
              @click="patch({ edgeAnimated: !settings.edgeAnimated })"
            >
              {{ settings.edgeAnimated ? '开' : '关' }}
            </button>
          </div>
          <label class="dock-field">
            <span class="dock-caption">粗细 {{ settings.edgeWidth.toFixed(1) }}px</span>
            <input
              type="range"
              class="dock-range"
              min="1"
              max="4"
              step="0.5"
              aria-label="连线粗细"
              :value="settings.edgeWidth"
              @input="patch({ edgeWidth: Number(($event.target as HTMLInputElement).value) })"
            >
          </label>
          <label class="dock-field">
            <span class="dock-caption">颜色</span>
            <input
              type="color"
              class="dock-color"
              aria-label="连线颜色"
              :value="settings.edgeColor || '#6b7280'"
              @input="patch({ edgeColor: ($event.target as HTMLInputElement).value })"
            >
          </label>
          <div class="dock-row">
            <span class="dock-caption">线型</span>
            <div class="dock-seg-group">
              <button
                type="button"
                class="dock-seg"
                :class="{ 'is-on': settings.edgeDash === 'solid' }"
                @click="patch({ edgeDash: 'solid' })"
              >
                实线
              </button>
              <button
                type="button"
                class="dock-seg"
                :class="{ 'is-on': settings.edgeDash === 'dashed' }"
                @click="patch({ edgeDash: 'dashed' })"
              >
                虚线
              </button>
            </div>
          </div>
          <div class="dock-row">
            <span class="dock-caption">发光</span>
            <button
              type="button"
              class="dock-seg"
              :class="{ 'is-on': settings.edgeGlow }"
              @click="patch({ edgeGlow: !settings.edgeGlow })"
            >
              {{ settings.edgeGlow ? '开' : '关' }}
            </button>
          </div>
        </section>
      </div>
      <!-- 「Dock 缩放」元设置已下架：用户不该调工具栏自己的大小。
           settings.bottomToolbarScale 字段保留，兼容既有 localStorage 与消费方。 -->
    </div>

    <!-- 单行底栏：小地图 | 缩放档位 | 适应 | 设置（9→4） -->
    <div class="toolbar-row pointer-events-auto flex flex-nowrap items-center gap-1 rounded-full px-1.5 py-1">
      <button
        type="button"
        class="bar-btn"
        :class="{ 'is-active': mapActive }"
        aria-label="小地图或节点列表"
        :aria-expanded="settings.minimapExpanded !== 0"
        @click="onMapToggle"
      >
        <svg class="dock-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 20l-5.447-2.724A2 2 0 013 15.382V6.618a2 2 0 011.553-1.894L9 2m0 18l6-3m-6 3V2m6 15l5.447 2.724A2 2 0 0021 18.382V9.618a2 2 0 00-1.553-1.894L15 5m0 14V5m0 0L9 2" />
        </svg>
      </button>

      <div class="relative">
        <button
          type="button"
          class="zoom-trigger"
          aria-label="缩放比例，点击选择档位"
          :aria-expanded="showZoomMenu"
          @click="toggleZoomMenu"
        >
          <span>{{ zoomPercent }}%</span>
          <svg class="zoom-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      <button type="button" class="bar-btn" aria-label="适应画布" @click="resetView">
        <svg class="dock-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
        </svg>
      </button>

      <div class="relative">
        <button
          type="button"
          class="bar-btn"
          :class="{ 'is-active': showSettings }"
          aria-label="画布设置"
          :aria-expanded="showSettings"
          @click="toggleSettings"
        >
          <svg class="dock-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 8c.36 0 .7.07 1 .2H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 底栏本体：墨流表面四层里的 overlay（浮在画布上）+ 锚链阴影 */
.toolbar-row {
  height: var(--lnk-control-sm);
  border: 1px solid var(--lnk-border-default);
  background: var(--lnk-surface-overlay);
  box-shadow: var(--lnk-shadow-sm);
  backdrop-filter: blur(var(--lnk-glass-blur)) saturate(1.4);
  -webkit-backdrop-filter: blur(var(--lnk-glass-blur)) saturate(1.4);
}

/* 浮层统一表面：卡片圆角 lg / 内边距 pad-card / 阴影 lg，避免四处各写一套 */
.dock-popover {
  z-index: var(--lnk-z-popover);
  border: 1px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-overlay);
  box-shadow: var(--lnk-shadow-lg);
  padding: var(--lnk-pad-card);
  backdrop-filter: blur(var(--lnk-glass-blur));
  -webkit-backdrop-filter: blur(var(--lnk-glass-blur));
  color: var(--lnk-text-primary);
}
.dock-popover--list {
  width: 200px;
}
.dock-popover--settings {
  width: 224px;
}
.dock-popover--zoom {
  white-space: nowrap;
}
.dock-popover__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--lnk-gap-inline);
  margin-bottom: var(--lnk-space-2);
}
.dock-popover__title {
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-medium);
  line-height: var(--lnk-lh-sm);
  color: var(--lnk-text-primary);
}
.dock-popover__hint {
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-muted);
}
.dock-popover__rule {
  height: 1px;
  margin: var(--lnk-space-1) 0;
  background: var(--lnk-border-subtle);
}
.dock-popover__rule--section {
  margin: var(--lnk-space-3) 0;
}
.dock-section-title {
  margin-bottom: var(--lnk-space-2);
  font-size: var(--lnk-text-xs);
  font-weight: var(--lnk-weight-medium);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-secondary);
}
.dock-caption {
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-muted);
}
.dock-scroll {
  max-height: 220px;
  overflow-y: auto;
}
.dock-scroll--settings {
  max-height: min(70vh, 420px);
}
.dock-group + .dock-group {
  margin-top: var(--lnk-space-2);
}
.dock-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: var(--lnk-gap-inline);
  border-radius: var(--lnk-radius-sm);
  padding: var(--lnk-space-1) var(--lnk-space-2);
  text-align: left;
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-secondary);
  transition: background var(--lnk-duration-fast) var(--lnk-ease-standard),
    color var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.dock-item:hover {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-primary);
}
.dock-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-gap-inline);
  min-height: var(--lnk-control-sm);
}
.dock-field {
  display: block;
  padding: var(--lnk-space-2) 0;
}
.dock-field .dock-caption {
  display: block;
  margin-bottom: var(--lnk-space-1);
}
.dock-seg-group {
  display: flex;
  gap: var(--lnk-space-1);
}
.dock-seg {
  min-width: 40px;
  border-radius: var(--lnk-radius-sm);
  background: var(--lnk-hover-overlay);
  padding: var(--lnk-space-1) var(--lnk-space-2);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-muted);
  transition: background var(--lnk-duration-fast) var(--lnk-ease-standard),
    color var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.dock-seg:hover {
  background: var(--lnk-pressed-overlay);
  color: var(--lnk-text-primary);
}
/* 选中态走 accent 语义色，不用 --lnk-hi-*（那对是随主题翻转的高对比令牌，禁用于选中态） */
.dock-seg.is-on {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
}
.dock-step {
  display: block;
  width: 100%;
  border-radius: var(--lnk-radius-sm);
  padding: var(--lnk-space-1) var(--lnk-space-3);
  text-align: left;
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-secondary);
  font-variant-numeric: tabular-nums;
  transition: background var(--lnk-duration-fast) var(--lnk-ease-standard),
    color var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.dock-step:hover {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-primary);
}
.dock-step.is-on {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
}
.dock-range {
  width: 100%;
  height: 4px;
  margin: 0;
  accent-color: var(--lnk-accent);
}
.dock-color {
  width: 100%;
  height: var(--lnk-control-sm);
  cursor: pointer;
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-sm);
  background: var(--lnk-surface-sunken);
}
.dock-input {
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-sm);
  background: var(--lnk-surface-sunken);
  padding: var(--lnk-space-1) var(--lnk-space-2);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-primary);
  outline: none;
}
.dock-input::placeholder {
  color: var(--lnk-text-muted);
}
.dock-input:focus {
  border-color: var(--lnk-border-focus);
}

/* 图标按钮：桌面 32px 控件 + 16px 图标 / 1.5px 线宽（Design_system §2.11） */
.bar-btn {
  display: flex;
  width: var(--lnk-control-sm);
  height: var(--lnk-control-sm);
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: var(--lnk-radius-full);
  color: var(--lnk-text-muted);
  transition: background var(--lnk-duration-fast) var(--lnk-ease-standard),
    color var(--lnk-duration-fast) var(--lnk-ease-standard),
    transform var(--lnk-duration-instant) var(--lnk-ease-standard);
}
.bar-btn:hover {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-primary);
}
.bar-btn:active {
  transform: scale(0.94);
}
.bar-btn.is-active {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
}
.dock-icon {
  width: var(--lnk-icon-sm);
  height: var(--lnk-icon-sm);
}

/* 缩放读数按钮：唯一的缩放入口，数字用等宽避免跳位 */
.zoom-trigger {
  display: flex;
  height: var(--lnk-control-sm);
  align-items: center;
  gap: 2px;
  border-radius: var(--lnk-radius-sm);
  padding: 0 var(--lnk-space-2);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--lnk-text-secondary);
  transition: background var(--lnk-duration-fast) var(--lnk-ease-standard),
    color var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.zoom-trigger:hover {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-primary);
}
.zoom-caret {
  width: 12px;
  height: 12px;
  opacity: 0.7;
}

/* 焦点环：2px focus 外环 + 2px offset（§3 通用状态契约，禁止 outline:none 无替代） */
.bar-btn:focus-visible,
.zoom-trigger:focus-visible,
.dock-item:focus-visible,
.dock-seg:focus-visible,
.dock-step:focus-visible,
.dock-range:focus-visible,
.dock-color:focus-visible,
.dock-input:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}

.minimap-body {
  width: 156px;
  height: 100px;
}
:deep(.popover-minimap) {
  width: 156px !important;
  height: 100px !important;
  margin: 0 !important;
  background: var(--lnk-surface-sunken) !important;
  border: none !important;
  border-radius: 0 !important;
}
:deep(.popover-minimap .vue-flow__minimap-node) {
  fill-opacity: 1 !important;
}
</style>
