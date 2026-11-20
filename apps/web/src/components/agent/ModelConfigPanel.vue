<script setup lang="ts">
// 模型配置页共用面板（2026-11-20）：移动 MobileSheet 与 PC 锚定卡共用同一模板与样式。
// WorkBuddy 风格两行 disclosure 列表；视图状态由宿主（useModelConfigView）持有，
// 面板按 view prop 渲染并以 update:view 上抛导航意图；档位写回走 setThinking 事件。
import type { ModelConfigView } from '@/composables/useModelConfigView'
import { THINKING_LEVELS, type ThinkingLevel } from './composer/thinkingLevels'

const props = defineProps<{
  /** 当前视图（宿主持有；'list' 不进本面板）。 */
  view: Exclude<ModelConfigView, 'list'>
  thinkingSupported: boolean
  thinkingLevel: ThinkingLevel | null
  readOnly: boolean
  /** contextWindowLabel 的展示串（只读语义在宿主侧决定，面板不重算规则）。 */
  contextLabel: string
}>()

const emit = defineEmits<{
  'update:view': [view: Exclude<ModelConfigView, 'list'>]
  setThinking: [level: ThinkingLevel]
}>()
</script>

<template>
  <!-- 配置页：两行 disclosure 列表 -->
  <div v-if="props.view === 'config'" class="model-config-group">
    <button
      type="button"
      class="model-config-row is-tappable"
      data-testid="model-thinking-row"
      @click="emit('update:view', 'thinking')"
    >
      <span class="model-config-label">思考强度</span>
      <span class="model-config-trailing">
        <span v-if="props.thinkingSupported" class="model-config-value">{{ props.thinkingLevel }}</span>
        <span v-else class="model-config-value model-config-muted">不支持</span>
        <svg viewBox="0 0 24 24" class="model-config-chevron" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </button>
    <button
      type="button"
      class="model-config-row is-tappable"
      data-testid="model-context-row"
      @click="emit('update:view', 'context')"
    >
      <span class="model-config-label">上下文窗口</span>
      <span class="model-config-trailing">
        <span class="model-config-value">{{ props.contextLabel }}</span>
        <svg viewBox="0 0 24 24" class="model-config-chevron" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </button>
  </div>

  <!-- 思考强度二级页：三档 radio 列表，选中态 accent checkmark -->
  <div v-else-if="props.view === 'thinking'" class="model-config-group">
    <p v-if="!props.thinkingSupported" class="model-config-empty">当前模型不支持思考强度</p>
    <template v-else>
      <button
        v-for="lv in THINKING_LEVELS"
        :key="lv"
        type="button"
        class="model-config-row is-tappable"
        :class="{ 'is-selected': lv === props.thinkingLevel }"
        data-testid="thinking-level-option"
        :aria-pressed="lv === props.thinkingLevel"
        :disabled="props.readOnly"
        @click="emit('setThinking', lv)"
      >
        <span class="model-config-label">{{ lv }}</span>
        <svg v-if="lv === props.thinkingLevel" viewBox="0 0 24 24" class="model-config-check" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </button>
    </template>
  </div>

  <!-- 上下文窗口只读详情页：由当前模型能力推导，无任何输入控件 -->
  <div v-else class="model-config-group">
    <div class="model-config-row">
      <span class="model-config-label">当前窗口</span>
      <span class="model-config-value">{{ props.contextLabel }}</span>
    </div>
    <p class="model-context-note">由当前模型能力推导，暂不可配置。</p>
  </div>
</template>

<style scoped>
.model-config-group {
  overflow: hidden;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-xl);
  background: var(--lnk-surface-base);
}

/* WorkBuddy 风格 disclosure 行：左标签、右值 + 箭头，整行 44px+ 触控区。 */
.model-config-row {
  display: flex;
  width: 100%;
  min-height: calc(var(--lnk-touch-target) + var(--lnk-space-3));
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-3) var(--lnk-space-4);
  border: 0;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  text-align: left;
}

.model-config-row.is-tappable {
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.model-config-row.is-tappable:active {
  background: var(--lnk-pressed-overlay);
}

.model-config-row.is-tappable:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.model-config-row.is-selected {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
}

.model-config-row + .model-config-row {
  border-top: 1px solid var(--lnk-border-subtle);
}

.model-config-label {
  min-width: 0;
  font-weight: var(--lnk-weight-semibold);
}

.model-config-trailing {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--lnk-space-2);
}

.model-config-value {
  color: var(--lnk-text-secondary);
}

.model-config-muted {
  color: var(--lnk-text-muted);
}

.model-config-chevron,
.model-config-check {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--lnk-text-muted);
}

.model-config-check {
  color: var(--lnk-accent-text);
}

.model-config-empty,
.model-context-note {
  margin: 0;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
}

.model-config-empty {
  padding: var(--lnk-space-3) var(--lnk-space-4);
}

.model-context-note {
  padding: 0 var(--lnk-space-4) var(--lnk-space-4);
}
</style>
