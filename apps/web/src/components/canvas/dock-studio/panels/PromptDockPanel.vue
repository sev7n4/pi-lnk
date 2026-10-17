<script setup lang="ts">
import { computed } from 'vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { UpstreamNodeContext } from '@/composables/useUpstreamNodeContext'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import type { NodeRef } from '@/composables/useNodeRefs'
import DockToolbarShell from '@/components/canvas/dock-studio/shared/DockToolbarShell.vue'
import { PROMPT_MODE_LABELS } from '@lnkpi/shared'

/**
 * 🔴 2026-10-17 prompt 节点下线：本面板降级为**存量只读查看器**。
 * 曾在此的编辑/生成能力（DockPromptSection 输入、模型选择、场景模板、语音、
 * 引用上传、DockGenerateButton 生成触发）随 prompt 节点退役一并移除——
 * 创建入口已删、生成端点已删（studio.generatePrompt / run_prompt_generation）。
 * 生产画布已无 prompt 节点；此面板仅为意外残留的历史节点兜底展示。
 */
const MODE_LABELS = PROMPT_MODE_LABELS

const props = defineProps<{
  node: EditableFlowNode
  upstream: UpstreamNodeContext
  refs?: NodeRef[]
  mentions?: MentionOption[]
  generating?: boolean
}>()

const emit = defineEmits<{
  close: []
  removeRef: [ref: NodeRef]
}>()

const promptText = computed(() => String(props.node.data?.prompt ?? ''))

const promptModeLabel = computed(() => {
  const mode = props.node.data?.promptMode
  return mode ? (MODE_LABELS[String(mode)] ?? String(mode)) : ''
})

const textRefs = computed(() => (props.refs ?? []).filter((ref) => ref.mediaType === 'text'))
</script>

<template>
  <DockToolbarShell type="prompt" :show-close="false" @close="emit('close')">
    <DockRefStrip
      v-if="textRefs.length"
      :refs="textRefs"
      @remove="emit('removeRef', $event)"
    />

    <div class="legacy-prompt-view">
      <p class="legacy-prompt-view__hint">提示词节点已下线；此为历史节点的只读视图，新建文案请使用文本节点。</p>
      <p v-if="promptText" class="legacy-prompt-view__text">{{ promptText }}</p>
      <p v-else class="legacy-prompt-view__empty">（无内容）</p>
    </div>

    <div class="bottom-toolbar-actions flex-wrap">
      <span
        v-if="promptModeLabel"
        class="rounded-md bg-fuchsia-500/15 px-2 py-0.5 text-[10px] text-fuchsia-300"
      >
        {{ promptModeLabel }}
      </span>
    </div>
  </DockToolbarShell>
</template>

<style scoped>
.legacy-prompt-view {
  margin: 0 12px 10px;
  border-radius: 10px;
  border: 1px solid var(--lnk-border-subtle, rgba(148, 163, 184, 0.25));
  padding: 10px 12px;
}
.legacy-prompt-view__hint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--lnk-text-secondary, #94a3b8);
  margin-bottom: 8px;
}
.legacy-prompt-view__text {
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.legacy-prompt-view__empty {
  font-size: 12px;
  color: var(--lnk-text-tertiary, #64748b);
}
</style>
