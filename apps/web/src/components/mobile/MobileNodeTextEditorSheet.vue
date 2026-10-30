<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'

/**
 * 移动端**文本节点原生编辑器**（2026-10-30 优化 · 问题③）。
 *
 * ⭐ **职责**：文本节点 viewer 底部「编辑」的落点——直接编辑**生成内容（产物）**，
 *   即对生成结果的校正，**不是**改提示词（词）。
 * ⭐ **机制**：沿用系统原生 `<textarea>`（弹出手机键盘），「保存」走本地落库
 *   —— 即时校正，不绕 agent、不弹「编辑提示词」页。
 *
 * ⛔ **与 `MobileNodeEditorSheet` 职责分离**（避免用户踩错的二次入口）：
 *   - 改**生成内容**（产物校正）  ⇒ 本组件（本地保存）；
 *   - 改**提示词**重生成          ⇒ `MobileNodeEditorSheet`（交给 agent）。
 */
const props = withDefaults(
  defineProps<{
    node: EditableFlowNode
  }>(),
  {},
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', payload: { content: string }): void
}>()

const nodeData = computed(() => (props.node.data ?? {}) as Record<string, unknown>)
const originalContent = String(nodeData.value.content ?? '')
const content = ref(originalContent)
const areaRef = ref<HTMLTextAreaElement | null>(null)

const canSave = computed(
  () => content.value.trim().length > 0 && content.value !== originalContent,
)

/** 打开即聚焦，弹出系统键盘（移动端动态浮层 autofocus 不可靠，手动聚焦更稳） */
onMounted(async () => {
  await nextTick()
  areaRef.value?.focus()
})

function save() {
  if (!canSave.value) return
  emit('save', { content: content.value })
}
</script>

<template>
  <div class="mobile-text-editor" role="dialog" aria-modal="true" aria-label="编辑文本">
    <div class="mobile-text-editor-head">
      <span class="mobile-text-editor-title">编辑文本</span>
      <!-- 右上角 X（44px 触控目标 + 内联 SVG，§4.11.5 禁文本字符当图标） -->
      <button
        class="sheet-close"
        type="button"
        aria-label="关闭"
        data-action="close"
        data-testid="mobile-text-editor-close"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="mobile-text-editor-body">
      <textarea
        ref="areaRef"
        v-model="content"
        class="mobile-text-editor-area"
        rows="10"
        placeholder="输入或编辑文本内容"
        data-testid="mobile-text-editor-area"
      />
    </div>

    <div class="mobile-text-editor-foot">
      <button
        type="button"
        class="mobile-text-editor-save"
        :disabled="!canSave"
        data-testid="mobile-text-editor-save"
        @click="save"
      >
        保存
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 全屏原生编辑器（与 MobileNodeEditorSheet 同族，但只做内容校正） */
.mobile-text-editor {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: flex;
  flex-direction: column;
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
}

.mobile-text-editor-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  min-height: var(--lnk-touch-target);
  padding: calc(var(--lnk-space-2) + env(safe-area-inset-top)) var(--lnk-pad-card) var(--lnk-space-2);
  border-bottom: 1px solid var(--lnk-divider);
}

.mobile-text-editor-title {
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
}

.sheet-close {
  flex: none;
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-secondary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.sheet-close:active {
  background: var(--lnk-pressed-overlay);
}

.mobile-text-editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--lnk-pad-card);
}

.mobile-text-editor-area {
  width: 100%;
  min-height: 240px;
  box-sizing: border-box;
  padding: var(--lnk-space-3);
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  resize: none;
}

.mobile-text-editor-area:focus {
  outline: none;
  border-color: var(--lnk-accent);
}

.mobile-text-editor-foot {
  flex: none;
  padding: var(--lnk-space-3) var(--lnk-pad-card) calc(var(--lnk-space-3) + env(safe-area-inset-bottom));
  border-top: 1px solid var(--lnk-divider);
}

.mobile-text-editor-save {
  width: 100%;
  min-height: var(--lnk-touch-target);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-text-editor-save:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
