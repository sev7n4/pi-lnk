<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import type { NodeRef } from '@/composables/useNodeRefs'

/**
 * 移动端**轻量编辑器**（2026-10-25 规格 §4.2 J1/K1，缺陷 D8）。
 *
 * ⭐ **为什么不再挂 PC 的 `DockStudioRouter`**（本组件此前直接复用它）：
 *   1. **参数所有权在 agent 侧** —— 提议阶段服务端已写死模型 / 比例 / 分辨率
 *      （`proposeGeneration`），用户再调 ⇒ 两套参数语义打架；
 *   2. PC dock ≈ 4800 行、参数选择器在窄屏**已实证弹不开**（走查⑥），
 *      此前是靠 35 行 `:deep()` 补丁硬修的 —— 换掉 dock 后补丁一并消失；
 *   3. 模式① 的心智是「我说，你做」⇒ 本组件只做「改词 + 提意见」，
 *      出口是「**发给 agent 修改**」（**不**有本地提交按钮）。
 *
 * ⭐ **为什么是全屏浮层**（不走 `MobileSheet`）：本组件要输入长提示词与意见，
 *   需要整屏输入面；`MobileSheet` 是 62vh 封顶的**选择型**底部浮层（§4.11.8）。
 *   ⇒ 它是「全屏表单」，保留自己的 X 关闭 + 44px 命中区 + `--lnk-*` 令牌。
 */
const props = withDefaults(
  defineProps<{
    node: EditableFlowNode
    refs?: NodeRef[]
    mentions?: MentionOption[]
    generating?: boolean
  }>(),
  {
    refs: () => [],
    mentions: () => [],
    generating: false,
  },
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'patch', patch: Record<string, unknown>): void
  /**
   * 模式①：把「改后提示词 + 我的意见」交给 agent（**不是**本地提交）。
   * ⭐ 页面层负责：写回提示词 → 切回对话页签 → 把意见放进 composer 输入框
   *   （用户自己按下发送 = 保留意图表达权，§4.5「看得见落地」）。
   */
  (e: 'send-to-agent', payload: { prompt: string; opinion: string }): void
}>()

const nodeData = computed(() => (props.node.data ?? {}) as Record<string, unknown>)

/** 提示词初值（agent 提议时写入 `data.prompt`） */
const prompt = ref(String(nodeData.value.prompt ?? ''))

/** 我的意见（要一起交给 agent 的自然语言） */
const opinion = ref('')

/**
 * 参数**只读**摘要（agent 定的，用户不可改）。
 * ⭐ 只给一行、只给已有值（⛔ 不猜不占位）；没有参数就不显示这一行。
 */
const paramsSummary = computed(() => {
  const d = nodeData.value
  const parts = [
    typeof d.imageModel === 'string' ? d.imageModel : '',
    typeof d.imageAspect === 'string' ? d.imageAspect : '',
    typeof d.imageResolution === 'string' ? d.imageResolution : '',
    typeof d.videoModel === 'string' ? d.videoModel : '',
    typeof d.textModel === 'string' ? d.textModel : '',
    typeof d.audioModel === 'string' ? d.audioModel : '',
  ].filter(Boolean)
  return parts.join(' · ')
})

/** 引用 chips（只读展示；⛔ 不在此提供删除入口 —— 删除引用走画布层） */
const refChips = computed(() =>
  (props.refs ?? []).map((r) => ({ id: r.refId, label: r.label || r.refId })),
)

const canSubmit = computed(() => prompt.value.trim().length > 0 || opinion.value.trim().length > 0)

function submit() {
  const nextPrompt = prompt.value.trim()
  const nextOpinion = opinion.value.trim()
  if (!canSubmit.value) return
  // 提示词有改动才回写（避免无谓落库）
  if (nextPrompt && nextPrompt !== String(nodeData.value.prompt ?? '')) {
    emit('patch', { prompt: nextPrompt })
  }
  emit('send-to-agent', { prompt: nextPrompt, opinion: nextOpinion })
}
</script>

<template>
  <div class="mobile-editor-sheet" role="dialog" aria-modal="true" aria-label="编辑节点">
    <div class="mobile-editor-head">
      <span class="mobile-editor-title">编辑提示词</span>
      <!-- 右上角 X（走查⑤）：44px 触控目标 + 内联 SVG（⛔ 禁文本字符当图标，§4.11.5） -->
      <button
        class="sheet-close"
        type="button"
        aria-label="关闭"
        data-action="close"
        data-testid="mobile-editor-close"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="mobile-editor-body">
      <!-- 提示词：可改词（这是「改词」的落点） -->
      <label class="mobile-editor-field">
        <span class="mobile-editor-label">提示词</span>
        <textarea
          v-model="prompt"
          class="mobile-editor-textarea"
          rows="5"
          placeholder="要改哪句？"
          data-testid="mobile-editor-prompt"
        />
      </label>

      <!-- 参数只读摘要（agent 定的，用户不可改） -->
      <div v-if="paramsSummary" class="mobile-editor-params" data-testid="mobile-editor-params">
        <span class="mobile-editor-label">参数</span>
        <span class="mobile-editor-params-text">{{ paramsSummary }}</span>
      </div>

      <!-- 引用 chips（只读） -->
      <div v-if="refChips.length" class="mobile-editor-refs" data-testid="mobile-editor-refs">
        <span class="mobile-editor-label">引用</span>
        <span v-for="c in refChips" :key="c.id" class="mobile-editor-ref-chip">{{ c.label }}</span>
      </div>

      <!-- 我的意见：交给 agent 的自然语言 -->
      <label class="mobile-editor-field">
        <span class="mobile-editor-label">我的意见</span>
        <textarea
          v-model="opinion"
          class="mobile-editor-textarea"
          rows="4"
          placeholder="想让 agent 怎么改？"
          data-testid="mobile-editor-opinion"
        />
      </label>
    </div>

    <!-- 主出口：交给 agent（⛔ 移动端不提供本地提交按钮） -->
    <div class="mobile-editor-foot">
      <button
        type="button"
        class="mobile-editor-submit"
        :disabled="!canSubmit"
        data-testid="mobile-editor-send"
        @click="submit"
      >
        发给 agent 修改
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 全屏表单浮层（不是选择型底部浮层 ⇒ 不走 MobileSheet） */
.mobile-editor-sheet {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: flex;
  flex-direction: column;
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
}

.mobile-editor-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  min-height: var(--lnk-touch-target);
  padding: calc(var(--lnk-space-2) + env(safe-area-inset-top)) var(--lnk-pad-card) var(--lnk-space-2);
  border-bottom: 1px solid var(--lnk-divider);
}

/* 右上角 X（走查⑤）：44px 触控目标 + 按下反馈 */
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

.mobile-editor-title {
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
}

.mobile-editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-4);
  padding: var(--lnk-pad-card);
}

.mobile-editor-field {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
}

.mobile-editor-label {
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-medium);
  color: var(--lnk-text-secondary);
}

.mobile-editor-textarea {
  width: 100%;
  min-height: 96px;
  box-sizing: border-box;
  padding: var(--lnk-space-3);
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  resize: vertical;
}

.mobile-editor-textarea:focus {
  outline: none;
  border-color: var(--lnk-accent);
}

/* 参数只读摘要：一行、弱化（用户不可改） */
.mobile-editor-params {
  display: flex;
  align-items: baseline;
  gap: var(--lnk-space-2);
}

.mobile-editor-params-text {
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-muted);
}

/* 引用 chips：只读展示 */
.mobile-editor-refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--lnk-space-2);
}

.mobile-editor-ref-chip {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 var(--lnk-space-2);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
}

.mobile-editor-foot {
  flex: none;
  padding: var(--lnk-space-3) var(--lnk-pad-card) calc(var(--lnk-space-3) + env(safe-area-inset-bottom));
  border-top: 1px solid var(--lnk-divider);
}

/* 唯一主出口：交给 agent */
.mobile-editor-submit {
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

.mobile-editor-submit:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
