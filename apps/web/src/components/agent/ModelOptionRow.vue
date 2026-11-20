<script setup lang="ts">
import { computed } from 'vue'
import type { SelectorModelOption } from '@/composables/useModelSelectorOptions'

/**
 * 模型选择列表行（2026-11-21 模型卡 R2）：PC 锚定卡与移动底部 Sheet 共用的唯一行渲染。
 * WorkBuddy 排布（用户拍板）：左=模型名，其右「可识图」徽标 + 渠道徽标；
 * 行末右对齐=倍率（`1.10x`，两位小数），选中行保留勾。不可用=灰显防呆。
 * 令牌纪律：零 hex、零深浅翻转令牌（hi-* 家族一律禁用），选中态走 accent 三件套。
 */
const props = defineProps<{
  option: SelectorModelOption
  selected: boolean
  /** 分隔线（移动端全宽列表用；PC popover 紧凑列表可关）。 */
  divided?: boolean
}>()

const emit = defineEmits<{ select: [] }>()

const multiplierLabel = computed(() =>
  typeof props.option.multiplier === 'number' && Number.isFinite(props.option.multiplier)
    ? `${props.option.multiplier.toFixed(2)}x`
    : null,
)

const isLive = computed(() => props.selected && !props.option.unavailable)
</script>

<template>
  <button
    type="button"
    class="mor-row"
    :class="{ 'is-selected': isLive, 'is-divided': divided }"
    :disabled="option.unavailable || undefined"
    :aria-pressed="isLive"
    @click="emit('select')"
  >
    <span class="mor-name">{{ option.name }}</span>
    <span v-if="option.unavailable" class="mor-unavailable">暂不可用</span>
    <span
      v-else-if="option.healthDot"
      class="mor-dot"
      :class="option.healthDot.kind === 'red' ? 'is-red' : 'is-warn'"
      :title="option.healthDot.title"
    />
    <span v-if="option.visionCapable && !option.unavailable" class="mor-badge mor-vision">可识图</span>
    <span class="mor-badge mor-channel">{{ option.channelName }}</span>
    <span class="mor-trailing">
      <span v-if="multiplierLabel" class="mor-multiplier" data-testid="model-multiplier">{{ multiplierLabel }}</span>
      <svg
        v-if="isLive"
        viewBox="0 0 24 24"
        class="mor-check"
        data-testid="model-option-check"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </span>
  </button>
</template>

<style scoped>
.mor-row {
  display: flex;
  width: 100%;
  min-height: var(--lnk-touch-target);
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2) var(--lnk-space-3);
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--lnk-duration-fast) ease;
}

.mor-row + .mor-row.is-divided {
  border-top: 1px solid var(--lnk-border-subtle);
}

.mor-row:hover {
  background: var(--lnk-pressed-overlay);
}

.mor-row:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

/* 选中态：主题稳定 accent 三件套（两主题同构，禁翻转令牌）。 */
.mor-row.is-selected {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
  box-shadow: inset 0 0 0 1px var(--lnk-accent-border);
}

.mor-name {
  min-width: 0;
  overflow: hidden;
  font-weight: var(--lnk-weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mor-unavailable {
  flex: none;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-xs);
}

.mor-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
}

.mor-dot.is-red {
  background: var(--lnk-error);
}

.mor-dot.is-warn {
  background: var(--lnk-warning);
}

.mor-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 0 var(--lnk-space-2);
  border-radius: 999px;
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
}

.mor-vision {
  border: 1px solid var(--lnk-success-border);
  background: var(--lnk-success-bg);
  color: var(--lnk-success);
}

.mor-channel {
  min-width: 0;
  max-width: 96px;
  overflow: hidden;
  border: 1px solid var(--lnk-border-subtle);
  background: var(--lnk-pressed-overlay);
  color: var(--lnk-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mor-trailing {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--lnk-space-1);
  margin-left: auto;
}

.mor-multiplier {
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-xs);
  font-variant-numeric: tabular-nums;
}

.mor-row.is-selected .mor-multiplier {
  color: var(--lnk-accent-text);
}

.mor-check {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--lnk-accent-text);
}
</style>
