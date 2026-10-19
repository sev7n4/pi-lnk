<script setup lang="ts">
import { computed, ref } from 'vue'
import { CX_IMAGE_EDIT_ENABLED, canOpenRefineForNode } from '@/utils/refineSession'

const props = defineProps<{
  x: number
  y: number
  nodeId?: string
  nodeType?: string
  nodeTitle?: string
  hasUrl?: boolean
  mediaKind?: string
  mimeType?: string
  multiSelectedCount?: number
  /** 移动端（≤767px）：渲染为底部动作 sheet（44px 行高）；PC 保持右键小浮层原样 */
  mobile?: boolean
}>()

const emit = defineEmits<{
  action: [action: string, payload?: string]
  close: []
}>()

const visible = ref(true)

const showUpstreamDuplicate = computed(() => Boolean(props.nodeId))

const showEditImage = computed(
  () =>
    CX_IMAGE_EDIT_ENABLED &&
    Boolean(props.hasUrl) &&
    canOpenRefineForNode({
      type: props.nodeType,
      mediaKind: props.mediaKind,
      mimeType: props.mimeType,
    }),
)

const showImageFileActions = computed(
  () => Boolean(props.hasUrl) && props.mediaKind === 'image',
)

function run(action: string, payload?: string) {
  emit('action', action, payload)
  visible.value = false
  emit('close')
}

/** 遮罩点按 / 手势下滑：仅收起，不触发任何动作 */
function dismiss() {
  visible.value = false
  emit('close')
}

/** 移动端 sheet 行模型（顺序即展示顺序；delete 恒置底） */
interface SheetItem {
  action: string
  label: string
  icon: string
  danger?: boolean
}
const sheetItems = computed<SheetItem[]>(() => {
  const items: SheetItem[] = [
    { action: 'rename', label: '重命名', icon: 'rename' },
  ]
  if (showEditImage.value) items.push({ action: 'edit-image', label: '编辑图像', icon: 'edit' })
  if (props.nodeType === 'group') {
    items.push({ action: 'ungroup', label: '解组', icon: 'ungroup' })
  }
  if (props.nodeId && props.nodeType !== 'group') {
    items.push({ action: 'add-agent-ref', label: '加入 Agent 引用', icon: 'ref' })
  }
  if (showImageFileActions.value) {
    items.push({ action: 'download-image', label: '下载图片', icon: 'download' })
    items.push({ action: 'save-asset', label: '存入资产库', icon: 'save' })
  }
  if (props.nodeId && props.nodeType !== 'group') {
    items.push({ action: 'duplicate', label: '新建副本', icon: 'duplicate' })
  }
  if (showUpstreamDuplicate.value) {
    items.push({ action: 'duplicate-upstream', label: '新建副本（含上游）', icon: 'duplicate-upstream' })
  }
  items.push({ action: 'multi-select', label: '多选', icon: 'multi-select' })
  items.push({ action: 'delete', label: '删除节点', icon: 'delete', danger: true })
  return items
})
</script>

<template>
  <!-- PC：右键小浮层（原样保留，行为逐字不变） -->
  <div
    v-if="visible && nodeId && !mobile"
    class="neo-popover fixed z-[100] min-w-[160px] rounded-xl py-1"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @click.stop
  >
    <button
      v-if="showEditImage"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('edit-image')"
    >
      编辑图像
    </button>

    <button v-if="showImageFileActions" class="neo-popover-item block w-full px-4 py-2 text-left text-xs" @click="run('download-image')">下载图片</button>
    <button v-if="showImageFileActions" class="neo-popover-item block w-full px-4 py-2 text-left text-xs" @click="run('save-asset')">存入资产库</button>

    <button
      v-if="nodeId"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('add-agent-ref')"
    >
      加入 Agent 引用
    </button>

    <button
      v-if="nodeId"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('duplicate')"
    >
      新建副本
    </button>
    <button
      v-if="showUpstreamDuplicate"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('duplicate-upstream')"
    >
      新建副本（含上游）
    </button>
    <button
      v-if="nodeId"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs !text-danger hover:!text-danger"
      @click="run('delete')"
    >
      删除节点
    </button>
  </div>

  <!-- 移动端：底部动作 sheet（2026-10-19 D-6，44px 行高 + 遮罩点按收起） -->
  <Teleport to="body">
    <Transition name="ctx-sheet">
      <div v-if="visible && nodeId && mobile" class="ctx-sheet-root">
        <div class="ctx-sheet-scrim" @click="dismiss" />
        <div class="ctx-sheet" role="menu" aria-label="节点操作">
          <div class="ctx-sheet-handle" aria-hidden="true" />
          <p class="ctx-sheet-title">{{ nodeTitle || '节点操作' }}</p>
          <button
            v-for="item in sheetItems"
            :key="item.action"
            type="button"
            class="ctx-sheet-item"
            :class="{ 'is-danger': item.danger }"
            role="menuitem"
            @click="run(item.action)"
          >
            <span class="ctx-sheet-item__icon" aria-hidden="true">
              <svg v-if="item.icon === 'rename'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 20h9" stroke-linecap="round" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else-if="item.icon === 'edit'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="9" r="1.5" />
                <path d="M21 15.5l-5-5L4 21" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else-if="item.icon === 'ungroup'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="4" width="9" height="16" rx="2" stroke-dasharray="3 2" />
                <rect x="13" y="4" width="8" height="16" rx="2" />
              </svg>
              <svg v-else-if="item.icon === 'ref'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="7.5" />
                <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
              </svg>
              <svg v-else-if="item.icon === 'download'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke-linecap="round" />
              </svg>
              <svg v-else-if="item.icon === 'save'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke-linecap="round" />
                <path d="M12 11v6m-3-3l3 3 3-3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else-if="item.icon === 'duplicate'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
                <path d="M15.5 3.5H6a2.5 2.5 0 0 0-2.5 2.5v9.5" stroke-linecap="round" />
              </svg>
              <svg v-else-if="item.icon === 'duplicate-upstream'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
                <path d="M15.5 3.5H6a2.5 2.5 0 0 0-2.5 2.5v9.5" stroke-linecap="round" />
                <circle cx="4" cy="4" r="1.6" fill="currentColor" stroke="none" />
              </svg>
              <svg v-else-if="item.icon === 'multi-select'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="4" width="7" height="7" rx="2" />
                <rect x="14" y="4" width="7" height="7" rx="2" />
                <rect x="3" y="13" width="7" height="7" rx="2" />
                <path d="M14.5 16.5l2 2 3.5-4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M4 7h16M10 4h4M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M10 11v6M14 11v6" stroke-linecap="round" />
              </svg>
            </span>
            <span class="ctx-sheet-item__label">{{ item.label }}</span>
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 移动端动作 sheet（D-6）：消费 --lnk-* L2 令牌，44px 行高，250ms 减速曲线 */
.ctx-sheet-root {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.ctx-sheet-scrim {
  position: absolute;
  inset: 0;
  background: var(--lnk-scrim);
}

.ctx-sheet {
  position: relative;
  width: 100%;
  max-height: 82vh;
  overflow-y: auto;
  padding: 0 12px calc(12px + env(safe-area-inset-bottom, 0px));
  border-radius: 20px 20px 0 0;
  background: var(--lnk-surface-raised);
  box-shadow: var(--lnk-shadow-lg);
}

.ctx-sheet-handle {
  width: 40px;
  height: 4px;
  margin: 8px auto 4px;
  border-radius: 9999px;
  background: var(--lnk-border-strong);
}

.ctx-sheet-title {
  padding: 4px 12px 8px;
  font-size: var(--lnk-text-sm);
  font-weight: 600;
  color: var(--lnk-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-sheet-item {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-base);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s ease;
}

.ctx-sheet-item:active {
  background: var(--lnk-pressed-overlay);
}

.ctx-sheet-item.is-danger {
  margin-top: 4px;
  color: var(--lnk-error);
}

.ctx-sheet-item__icon {
  display: flex;
  width: 24px;
  height: 24px;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--lnk-text-muted);
}

.ctx-sheet-item.is-danger .ctx-sheet-item__icon {
  color: var(--lnk-error);
}

.ctx-sheet-item__icon svg {
  width: 20px;
  height: 20px;
}

.ctx-sheet-enter-active,
.ctx-sheet-leave-active {
  transition: opacity 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}

.ctx-sheet-enter-active .ctx-sheet,
.ctx-sheet-leave-active .ctx-sheet {
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}

.ctx-sheet-enter-from,
.ctx-sheet-leave-to {
  opacity: 0;
}

.ctx-sheet-enter-from .ctx-sheet,
.ctx-sheet-leave-to .ctx-sheet {
  transform: translateY(24px);
}
</style>
