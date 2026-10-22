<script setup lang="ts">
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
defineProps<{ node: MobileNodeActionNode }>()
const emit = defineEmits<{
  action: [key: string]
  close: []
}>()

const actions: { key: string; label: string; danger?: boolean }[] = [
  { key: 'rename', label: '重命名' },
  { key: 'reference', label: '引用' },
  { key: 'duplicate', label: '副本' },
  { key: 'multi-select', label: '多选' },
  { key: 'edit', label: '编辑' },
  { key: 'delete', label: '删除', danger: true },
]

function onSelect(key: string) {
  emit('action', key)
}
</script>

<template>
  <div class="mobile-action-sheet" role="menu" aria-label="节点操作">
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
    <button class="action-item action-cancel" type="button" data-action="cancel" @click="emit('close')">
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
</style>
