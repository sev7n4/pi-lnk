<script setup lang="ts">
import { computed } from 'vue'
import type { NodeWaveformSource } from '@/composables/useNodeWaveform'

/**
 * 移动端音频节点的波形条（D-D）。
 *
 * ⭐ 组件**只消费 peaks**，不关心数据从哪来——真实 PCM 降采样出来的也好、
 *   后端契约到达后的也好、nodeId 哈希的确定性占位也好，形状完全一致。
 *   这就是规格 §10.2 D-D 要的「与数据源解耦」。
 *
 * ⭐ 「波形加载中」微标不是装饰：占位波形本质上是**装饰而非数据**，
 *   不标注的话用户会以为那是这段音频的真实起伏（=false information）。
 *   真数据到位或明确放弃后就不再显示——不再尝试就说 foolish 自己在 loading，是假的。
 */
const props = defineProps<{
  peaks: number[]
  source?: NodeWaveformSource
  loading?: boolean
}>()

/** 视觉下限：静音段也要「有条」，不能消失成一排空气 */
const MIN_BAR_RATIO = 0.08

const bars = computed(() =>
  props.peaks.map((p) => {
    const v = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0
    return Math.round((MIN_BAR_RATIO + (1 - MIN_BAR_RATIO) * v) * 1000) / 10
  }),
)

const isPlaceholder = computed(() => props.source !== 'real')

const ariaLabel = computed(() => {
  if (props.loading) return '音频波形加载中'
  return isPlaceholder.value ? '音频波形占位' : '音频波形'
})
</script>

<template>
  <div
    class="mobile-node-waveform"
    :data-source="source ?? 'placeholder'"
    role="img"
    :aria-label="ariaLabel"
    data-testid="mobile-node-waveform"
  >
    <span
      v-for="(height, i) in bars"
      :key="i"
      class="mobile-node-waveform-bar"
      :style="{ height: height + '%' }"
    />
    <span
      v-if="loading"
      class="mobile-node-waveform-loading"
      data-testid="mobile-node-waveform-loading"
      >波形加载中</span
    >
  </div>
</template>

<style scoped>
.mobile-node-waveform {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  height: 36px;
  gap: 2px;
}

.mobile-node-waveform-bar {
  flex: 1;
  min-width: 2px;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-border-strong);
}

/* 占位态用更弱的描边令牌——一眼就不是「精确音量」的意思 */
.mobile-node-waveform[data-source='placeholder'] .mobile-node-waveform-bar {
  background: var(--lnk-border-default);
}

.mobile-node-waveform-loading {
  position: absolute;
  right: 0;
  bottom: -2px;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
  white-space: nowrap;
  pointer-events: none;
}
</style>
