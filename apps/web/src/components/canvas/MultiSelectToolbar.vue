<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { GROUP_COLOR_KEYS } from './groupColors'
import CanvasRefTargetIcon from '@/components/shared/CanvasRefTargetIcon.vue'

const props = defineProps<{
  selectedIds: string[]
  screenPosition: { x: number; y: number } | null
  canGenerateVideo?: boolean
  canUngroup?: boolean
  /** 当前分组色（host 传入用于高亮活跃色点；缺省 = neutral 默认色） */
  groupColorKey?: string | null
  selectionBatch?: {
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
}>()

const emit = defineEmits<{
  group: []
  ungroup: []
  delete: []
  layout: [mode: 'along_edges' | 'grid']
  generateVideo: []
  download: [mode: 'full_package' | 'lightweight' | 'media_list_only']
  addAgentRef: []
  duplicate: []
  duplicateUpstream: []
  generateSelection: []
  generateRegen: []
  stopSelection: []
  blockedHint: [reason: 'pending_confirm' | 'limit_24' | 'missing_prompt']
  /** P3 2026-10-12：分组色卡选择；null = 复位回默认中性 */
  groupColor: [key: string | null]
}>()

const exportMenuOpen = ref(false)
const layoutMenuOpen = ref(false)

/**
 * 分组背景色菜单（2026-10-13 迭代）：常驻单排色点收敛为「内外环触发钮 +
 * hover 展开下拉」。触发钮内环实时显示当前分组背景色（host 经 groupColorKey
 * 传入，改色即跟随）；指针进入触发区展开下拉，横向平铺 8 个色块，指针进入
 * 色条整条放大到易点尺寸。
 *
 * 防闪闭双层：① 隐形桥梁——.group-color-menu::after 覆盖触发器与下拉之间
 * 的 6px 间隙，指针跨越时命中区连续，永不触发 mouseleave；② 150ms 宽限
 * 兜底（异常快速划过时）。离开即收。
 */
const colorMenuOpen = ref(false)
let colorCloseTimer: ReturnType<typeof setTimeout> | undefined

function openColorMenu() {
  clearTimeout(colorCloseTimer)
  colorMenuOpen.value = true
}

function closeColorMenuLanded() {
  clearTimeout(colorCloseTimer)
  colorCloseTimer = setTimeout(() => {
    colorMenuOpen.value = false
  }, 150)
}

function toggleColorMenu() {
  colorMenuOpen.value = !colorMenuOpen.value
}

const colorKeys = GROUP_COLOR_KEYS

/** 活跃色点：host 传入当前分组色；缺省/null 均落 neutral（默认色） */
const activeGroupColorKey = computed(() => props.groupColorKey ?? 'neutral')

/** 色点只做选择；null 契约保留但 UI 不单设复位格——neutral 即默认色 */
function onPickColor(key: string) {
  emit('groupColor', key)
}

function closeExportMenu() {
  exportMenuOpen.value = false
}

function closeLayoutMenu() {
  layoutMenuOpen.value = false
}

function onGenerateClick() {
  if (props.selectionBatch && props.selectionBatch.state === 'idle' && props.selectionBatch.runCount > 0) {
    emit('generateSelection')
  } else {
    emit('stopSelection')
  }
}

function onRegenClick() {
  if (props.selectionBatch && props.selectionBatch.state === 'idle') {
    emit('generateRegen')
  } else {
    emit('stopSelection')
  }
}

const batchBlocked = computed(() => props.selectionBatch?.blocked ?? null)
const batchBlockedCount = computed(() => props.selectionBatch?.blockedCount ?? 0)
const batchRunCount = computed(() => props.selectionBatch?.runCount ?? 0)
const batchRegenCount = computed(() => props.selectionBatch?.regenCount ?? 0)
const batchMissingCount = computed(() => props.selectionBatch?.missingCount ?? 0)
const batchRunning = computed(() => props.selectionBatch?.state === 'running' || props.selectionBatch?.state === 'stopping')
// 纯缺提示词选区：无可执行、无可重生成、无其他阻断 → 用「缺提示词」替代静默的「生成 · 0」
const showMissingButton = computed(() =>
  batchMissingCount.value > 0
  && batchRunCount.value === 0
  && batchRegenCount.value === 0
  && !batchBlocked.value,
)
const showGenerateButton = computed(() =>
  batchRunCount.value > 0
  || (batchRegenCount.value === 0 && !batchBlocked.value && !showMissingButton.value),
)
const showRegenButton = computed(() => batchRegenCount.value > 0 && !batchBlocked.value)

function onBlockedClick() {
  if (batchBlocked.value) emit('blockedHint', batchBlocked.value)
}

function onMissingClick() {
  emit('blockedHint', 'missing_prompt')
}

const blockedTitle = computed(() => {
  if (batchBlocked.value === 'pending_confirm') {
    return '选区包含待确认节点，点击定位；请在节点上确认生成'
  }
  if (batchBlocked.value === 'limit_24') {
    return '选区可执行节点超过 24 个上限，请减少选区后重试'
  }
  return ''
})

const missingTitle = '选区节点均未写提示词且无可用上游输出，点击定位第一个问题节点'

function onExport(mode: 'full_package' | 'lightweight' | 'media_list_only') {
  exportMenuOpen.value = false
  emit('download', mode)
}

function onLayout(mode: 'along_edges' | 'grid') {
  layoutMenuOpen.value = false
  emit('layout', mode)
}

function onDocClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (!target?.closest('[data-export-menu]')) {
    closeExportMenu()
  }
  if (!target?.closest('[data-layout-menu]')) {
    closeLayoutMenu()
  }
  if (!target?.closest('[data-color-menu]')) {
    colorMenuOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
})
onUnmounted(() => {
  clearTimeout(colorCloseTimer)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div
    v-if="screenPosition && (selectedIds.length >= 2 || (canUngroup && selectedIds.length >= 1))"
    class="multi-select-toolbar pointer-events-none absolute z-[46]"
    :style="{
      left: `${screenPosition.x}px`,
      top: `${screenPosition.y}px`,
      transform: 'translate(-50%, 0)',
    }"
  >
    <div
      class="neo-chrome pointer-events-auto flex items-center gap-1.5 rounded-xl px-2 py-1.5"
      @click.stop
    >
      <span class="px-1.5 text-xs text-[var(--neo-text-muted)]">已选 {{ selectedIds.length }}</span>
      <button
        v-if="canGenerateVideo"
        type="button"
        class="toolbar-action accent"
        aria-label="生成视频"
        title="用选中文本 + 图片生成视频"
        @click="emit('generateVideo')"
      >
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
          <path d="M6.5 5.5v5l4.5-2.5z" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button
        v-if="batchBlocked"
        type="button"
        class="toolbar-action warn"
        data-testid="selection-batch-blocked"
        :aria-label="batchBlocked === 'pending_confirm' ? `待确认 ${batchBlockedCount} 个节点` : `超上限 ${batchBlockedCount} 个节点`"
        :title="blockedTitle"
        @click="onBlockedClick"
      >
        <svg v-if="batchBlocked === 'pending_confirm'" viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 4.5v4" />
          <circle cx="8" cy="11.2" r="0.9" fill="currentColor" stroke="none" />
        </svg>
        <svg v-else viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M3.5 12.5 12.5 3.5" />
        </svg>
        <span class="badge">{{ batchBlockedCount }}</span>
      </button>
      <button
        v-if="showMissingButton"
        type="button"
        class="toolbar-action warn"
        data-testid="selection-batch-missing-prompt"
        :aria-label="`${batchMissingCount} 个节点未写提示词`"
        :title="missingTitle"
        @click="onMissingClick"
      >
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="3" y="1.5" width="10" height="13" rx="1.5" />
          <path d="M5.5 5h5M5.5 8h5M5.5 11h3" />
        </svg>
        <span class="badge">{{ batchMissingCount }}</span>
      </button>
      <button
        v-if="showGenerateButton"
        type="button"
        class="toolbar-action accent"
        data-testid="selection-batch-generate"
        :aria-label="batchRunning ? '停止全部' : `批量生成 ${batchRunCount} 个节点`"
        :title="batchRunning ? '停止全部' : `批量生成 ${batchRunCount} 个节点`"
        :disabled="!selectionBatch || (selectionBatch.state === 'idle' && selectionBatch.runCount === 0)"
        @click="onGenerateClick"
      >
        <svg v-if="!batchRunning" viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" fill="currentColor" stroke="none" />
        </svg>
        <svg v-else viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />
        </svg>
        <span v-if="!batchRunning" class="badge">{{ batchRunCount }}</span>
      </button>
      <button
        v-if="showRegenButton"
        type="button"
        class="toolbar-action accent"
        data-testid="selection-batch-regenerate"
        :aria-label="batchRunning ? '停止全部' : `重新生成 ${batchRegenCount} 个已完成节点`"
        :title="batchRunning ? '停止全部' : `覆盖式重新生成 ${batchRegenCount} 个已完成节点，将覆盖现有产物并可能消耗积分`"
        :disabled="!selectionBatch"
        @click="onRegenClick"
      >
        <svg v-if="!batchRunning" viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97" />
          <path d="M13.6 1.6v3h-3" />
        </svg>
        <svg v-else viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />
        </svg>
        <span v-if="!batchRunning" class="badge">{{ batchRegenCount }}</span>
      </button>
      <!-- 分组背景色（2026-10-13 迭代）：内外环触发钮 + hover 下拉。
           钮内环实时显示当前分组背景色（groupColorKey 驱动，改色即跟随）；
           指针进入触发区展开下拉，横向平铺 8 个色块；指针进入色条整条
           放大到易点尺寸（transform 缩放，不占布局盒、不推挤相邻按钮），
           当前分组色以品牌色环高亮。neutral 即默认色，复位语义与色点合一。
           色值全部走 --neo-group-* 令牌，组件内无字面 hex。 -->
      <div
        v-if="canUngroup"
        class="group-color-menu relative"
        data-color-menu
        @mouseenter="openColorMenu"
        @mouseleave="closeColorMenuLanded"
      >
        <button
          type="button"
          class="group-color-trigger"
          data-testid="group-color-trigger"
          :aria-label="`分组背景色：${activeGroupColorKey}`"
          :aria-expanded="colorMenuOpen"
          title="分组背景色（悬停展开色卡）"
          @click.stop="toggleColorMenu"
        >
          <span
            class="group-color-trigger-core"
            data-testid="group-color-trigger-core"
            :style="{ background: `var(--neo-group-${activeGroupColorKey})` }"
          />
        </button>
        <div
          v-if="colorMenuOpen"
          class="group-color-dropdown neo-chrome"
          data-testid="group-color-dropdown"
        >
          <div class="group-color-strip" role="group" aria-label="分组背景颜色">
            <button
              v-for="key in colorKeys"
              :key="key"
              type="button"
              class="group-color-dot"
              :class="{ 'is-active': key === activeGroupColorKey }"
              :data-testid="`group-color-${key}`"
              :aria-label="key === 'neutral' ? '默认色' : `分组色 ${key}`"
              :aria-pressed="key === activeGroupColorKey"
              :title="key === 'neutral' ? '默认色' : `分组色 ${key}`"
              :style="{ background: `var(--neo-group-${key})` }"
              @click="onPickColor(key)"
            />
          </div>
        </div>
      </div>
      <button
        v-if="canUngroup"
        type="button"
        class="toolbar-action"
        aria-label="解组"
        title="解组"
        @click="emit('ungroup')"
      >
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="1.5" y="4" width="6" height="8" rx="1.5" stroke-dasharray="2 1.5" />
          <rect x="10" y="4" width="4.5" height="8" rx="1.5" />
        </svg>
      </button>
      <button
        v-if="!canUngroup && selectedIds.length >= 2"
        type="button"
        class="toolbar-action"
        aria-label="打组"
        title="打组"
        @click="emit('group')"
      >
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="1.5" y="1.5" width="6.5" height="6.5" rx="1.5" />
          <rect x="8" y="8" width="6.5" height="6.5" rx="1.5" />
        </svg>
      </button>
      <button
        v-if="selectedIds.length >= 2"
        type="button"
        class="toolbar-action"
        aria-label="新建副本"
        title="新建副本"
        @click="emit('duplicate')"
      >
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
          <path d="M10.5 2.5h-7a1 1 0 0 0-1 1v7" />
        </svg>
      </button>
      <button
        v-if="selectedIds.length >= 2"
        type="button"
        class="toolbar-action"
        aria-label="新建副本（含上游）"
        title="新建副本（含上游）"
        @click="emit('duplicateUpstream')"
      >
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
          <path d="M10.5 2.5h-7a1 1 0 0 0-1 1v7" />
          <circle cx="3" cy="3" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button
        v-if="selectedIds.length >= 2"
        type="button"
        class="toolbar-action accent"
        aria-label="加入 Agent 引用"
        title="加入 Agent 引用"
        @click="emit('addAgentRef')"
      >
        <CanvasRefTargetIcon :size="18" />
      </button>
      <div
        v-if="selectedIds.length >= 2"
        class="relative"
        data-layout-menu
      >
        <button
          type="button"
          class="toolbar-action"
          aria-label="整理布局"
          title="整理布局"
          @click.stop="layoutMenuOpen = !layoutMenuOpen; exportMenuOpen = false"
        >
          <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
            <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
            <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
            <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
            <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
          </svg>
        </button>
        <div
          v-if="layoutMenuOpen"
          class="export-menu neo-chrome absolute left-0 top-full z-50 mt-1 min-w-[8.5rem] rounded-lg py-1"
        >
          <button
            type="button"
            class="export-menu-item"
            @click="onLayout('along_edges')"
          >
            顺着连线
          </button>
          <button
            type="button"
            class="export-menu-item"
            @click="onLayout('grid')"
          >
            自动网格
          </button>
        </div>
      </div>
      <div
        v-if="selectedIds.length >= 2"
        class="relative"
        data-export-menu
      >
        <button
          type="button"
          class="toolbar-action"
          aria-label="导出工作流"
          title="导出工作流"
          @click.stop="exportMenuOpen = !exportMenuOpen; layoutMenuOpen = false"
        >
          <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
            <path d="M8 2v8M4.8 7 8 10.2 11.2 7" />
            <path d="M2 11.5v1.5a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
          </svg>
        </button>
        <div
          v-if="exportMenuOpen"
          class="export-menu neo-chrome absolute left-0 top-full z-50 mt-1 min-w-[11rem] rounded-lg py-1"
        >
          <button
            type="button"
            class="export-menu-item"
            @click="onExport('full_package')"
          >
            导出工作流
          </button>
          <button
            type="button"
            class="export-menu-item"
            @click="onExport('lightweight')"
          >
            导出工作流（仅 JSON）
          </button>
          <button
            type="button"
            class="export-menu-item"
            @click="onExport('media_list_only')"
          >
            仅导出媒体清单
          </button>
        </div>
      </div>
      <button
        type="button"
        class="toolbar-action danger"
        aria-label="删除"
        title="删除"
        @click="emit('delete')"
      >
        <svg viewBox="0 0 16 16" class="ico" aria-hidden="true">
          <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 10h6.6L12 4" />
          <path d="M6.7 6.5v5M9.3 6.5v5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 工具条控件放大（2026-10-13）：参照图片节点单击弹出卡片的控件尺度
   （ DockStudio 28px 按钮 / 24px 图标钮）—— 分组工具条原 16px 图标 +
   py-1 在 0.25 倍缩放的画布上偏小。hit 区 30px、图标 18px、条高 ~44px。
   浮层是屏幕空间 HTML 覆盖物，不随画布缩放（缩放即不可读，见 PR 说明）。 */
.toolbar-action {
  @apply relative rounded-lg p-2 transition;
  color: var(--neo-text-secondary);
}
.toolbar-action:hover {
  background: var(--neo-hover-bg);
  color: var(--neo-text-primary);
}
.toolbar-action.danger {
  color: #f87171;
}
.toolbar-action.danger:hover {
  color: #fca5a5;
}
.toolbar-action.accent {
  color: var(--neo-accent-text);
}
.toolbar-action.warn {
  color: #fbbf24;
}
.toolbar-action.warn:hover {
  color: #fcd34d;
}
.toolbar-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ico {
  display: block;
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 15px;
  padding: 0 3px;
  border-radius: 9999px;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  color: var(--neo-text-primary);
  background: var(--neo-hover-bg, rgba(128, 128, 128, 0.35));
}
.export-menu {
  background: var(--neo-chrome-bg, rgba(20, 20, 24, 0.96));
  border: 1px solid var(--neo-border, rgb(var(--lnk-overlay-rgb) / 0.08));
  box-shadow: var(--lnk-shadow-md);
}
.export-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.5rem 0.85rem;
  font-size: 13px;
  color: var(--neo-text-secondary);
  background: transparent;
}
.export-menu-item:hover {
  background: var(--neo-hover-bg);
  color: var(--neo-text-primary);
}

/* 分组背景色触发钮（2026-10-13）：内外环结构——外环为中性描边圆钮，
   内环（core）实时显示当前分组背景色（内联 var(--neo-group-*)），
   改色即跟随；hover 时外环提亮暗示可展开。 */
.group-color-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  padding: 0;
  border: 1.5px solid color-mix(in srgb, var(--neo-text) 22%, transparent);
  border-radius: 9999px;
  background: transparent;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease;
}
.group-color-trigger:hover {
  border-color: color-mix(in srgb, var(--neo-text) 45%, transparent);
  background: var(--neo-hover-bg);
}
.group-color-trigger-core {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 9999px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--neo-text) 18%, transparent);
  transition: background 0.14s ease;
}

/* 下拉：触发器正下方，横向平铺 8 个色块（替代旧三排网格弹层） */
.group-color-dropdown {
  position: absolute;
  left: 50%;
  top: calc(100% + 6px);
  z-index: 50;
  transform: translateX(-50%);
  border-radius: 10px;
  padding: 6px;
  box-shadow: var(--lnk-shadow-md);
}

/* 隐形桥梁：覆盖触发器与下拉之间的 6px 间隙——指针跨越时命中区连续，
   不触发 wrapper 的 mouseleave（hover 展开的经典闪闭坑）；配合 150ms
   宽限双保险。视觉上不可见（无背景无边框）。 */
.group-color-menu::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  height: 10px;
}

/* 色条：静止小点、指针进入整条放大到易点尺寸（transform 缩放不占布局盒、
   不推挤相邻色块）；当前分组色以品牌色环高亮。 */
.group-color-strip {
  display: flex;
  align-items: center;
  gap: 4px;
}
.group-color-dot {
  width: 18px;
  height: 18px;
  flex: none;
  border: 1px solid color-mix(in srgb, var(--neo-text) 18%, transparent);
  border-radius: 6px;
  padding: 0;
  cursor: pointer;
  transform: scale(0.7);
  transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
}
.group-color-strip:hover .group-color-dot {
  transform: scale(1.2);
}
/* 特异性 (0,4,0) 压过色条 hover 规则：被指的那个再大一点 */
.group-color-strip:hover .group-color-dot:hover {
  transform: scale(1.25);
}
.group-color-dot.is-active {
  border-color: var(--neo-accent);
  box-shadow: 0 0 0 1px var(--neo-accent);
}
</style>
