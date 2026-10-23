<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
export interface MobileNodeActionNode {
  id: string
  type: string
  data?: any
}

/**
 * 移动端长按动作 sheet（2026-10-22 R1-T5）：与 PC 右键上下文菜单解耦的纯 UI 管理入口。
 * 只负责列出动作并把用户意图以 `action(key)` 上抛，真正的动作分发（重命名/删除/复制/多选/
 * 编辑）由页面层 `handleMobileNodeAction` 复用桌面 `handleContextAction` 同一套逻辑执行，
 * 避免两套实现漂移。
 */
const props = defineProps<{ node: MobileNodeActionNode }>()
const emit = defineEmits<{
  action: [key: string]
  close: []
  /** R4-T3：重命名提交（标题），页面层复用既有 renameNodeById 落库 */
  rename: [title: string]
}>()

const actions: { key: string; label: string; danger?: boolean }[] = [
  { key: 'rename', label: '重命名' },
  { key: 'reference', label: '引用' },
  { key: 'duplicate', label: '副本' },
  { key: 'multi-select', label: '多选' },
  { key: 'edit', label: '编辑' },
  { key: 'delete', label: '删除', danger: true },
]

/**
 * R4-T3：重命名内联态。
 *
 * ⭐ 为什么在 sheet 内做，而不是复用 PC 的行内重命名：PC 的重命名由 `NeoBaseNode`
 *   消费 `CANVAS_NODE_RENAME_REQUEST_KEY` 驱动（行内 input），而**移动端不渲染
 *   `NeoBaseNode`**（`NodeRenderer.vue:35` 移动端走 `MobileNodeTile`）⇒
 *   原接线在移动端**完全静默失效**（点了零反馈）。长按已是二级入口，
 *   在此直接给输入框符合移动端手势，且不动 PC。
 */
const renaming = ref(false)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

/** 节点当前标题（用于初值；与 PC `resolveNeoNodeTitle` 同源的兜底） */
const currentTitle = computed(() => {
  const data = (props.node.data ?? {}) as Record<string, unknown>
  const t = typeof data.title === 'string' ? data.title.trim() : ''
  if (t) return t
  const label = typeof data.label === 'string' ? data.label.trim() : ''
  return label
})

async function startRename() {
  renameValue.value = currentTitle.value
  renaming.value = true
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function cancelRename() {
  renaming.value = false
  renameValue.value = ''
}

function submitRename() {
  const title = renameValue.value.trim()
  renaming.value = false
  renameValue.value = ''
  if (!title) return
  emit('rename', title)
}

function onSelect(key: string) {
  if (key === 'rename') {
    void startRename()
    return
  }
  emit('action', key)
}
</script>

<template>
  <div class="mobile-action-sheet" role="menu" aria-label="节点操作">
    <!-- R4-T3：重命名内联输入（替代失效的 PC 行内重命名通道） -->
    <div v-if="renaming" class="mobile-action-rename">
      <input
        ref="renameInput"
        v-model="renameValue"
        class="mobile-action-rename-input"
        type="text"
        placeholder="节点名称"
        aria-label="节点名称"
        data-testid="mobile-action-rename-input"
        @keyup.enter="submitRename"
        @keyup.esc="cancelRename"
      />
      <div class="mobile-action-rename-row">
        <button
          type="button"
          class="action-item action-cancel"
          data-action="rename-cancel"
          @click="cancelRename"
        >
          取消
        </button>
        <button
          type="button"
          class="action-item action-confirm"
          data-action="rename-confirm"
          @click="submitRename"
        >
          确定
        </button>
      </div>
    </div>
    <template v-else>
      <button
        v-for="a in actions"
        :key="a.key"
        :data-action="a.key"
        type="button"
        class="action-item"
        :class="{ 'action-item--danger': a.danger }"
        @click="onSelect(a.key)"
      >
        {{ a.label }}
      </button>
    </template>
    <button
      v-if="!renaming"
      class="action-item action-cancel"
      type="button"
      data-action="cancel"
      @click="emit('close')"
    >
      取消
    </button>
  </div>
</template>

<style scoped>
.mobile-action-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-1);
  padding: var(--lnk-space-2) var(--lnk-space-2) calc(var(--lnk-space-4) + env(safe-area-inset-bottom));
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
}

.action-item {
  min-height: var(--lnk-touch-target);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.action-item--danger {
  color: var(--lnk-status-error);
}

.action-cancel {
  margin-top: var(--lnk-space-1);
  color: var(--lnk-text-secondary);
}

/* R4-T3：重命名内联输入 */
.mobile-action-rename {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
}

.mobile-action-rename-input {
  width: 100%;
  min-height: var(--lnk-touch-target);
  box-sizing: border-box;
  padding: 0 var(--lnk-space-3);
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
}

.mobile-action-rename-input:focus {
  outline: none;
  border-color: var(--lnk-accent);
}

.mobile-action-rename-row {
  display: flex;
  gap: var(--lnk-space-2);
}

.action-confirm {
  color: var(--lnk-accent-text);
}
</style>
