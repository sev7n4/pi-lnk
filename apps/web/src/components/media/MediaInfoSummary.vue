<script setup lang="ts">
import { computed } from 'vue'
import type { MediaRefWarningLevel } from '@lnkpi/shared'
import { mediaInfoLine } from '@/utils/mediaInfoFormat'

const props = defineProps<{
  kind?: 'image' | 'video' | 'audio'
  width?: number
  height?: number
  bytes?: number
  aspectRatio?: string
  resolution?: string
  durationSec?: number
  format?: string
  refWarning?: MediaRefWarningLevel
}>()

// 分段判据的单一真源在 utils/mediaInfoFormat（移动端瓦片共用同一份，2026-10-24）
const line = computed(() => mediaInfoLine(props))

const refWarningLabel = computed(() => {
  if (props.refWarning === 'error') return 'ref 过大'
  if (props.refWarning === 'warn') return 'ref 偏大'
  return null
})
</script>

<template>
  <div v-if="line || refWarningLabel" class="neo-media-info-summary nodrag">
    <span v-if="line" class="neo-media-info-summary-text">{{ line }}</span>
    <span
      v-if="refWarningLabel"
      class="neo-media-info-summary-warn"
      :class="refWarning === 'error' ? 'is-error' : 'is-warn'"
      :title="refWarningLabel"
    >
      ⚠ {{ refWarningLabel }}
    </span>
  </div>
</template>
