<script setup lang="ts">
import { computed } from 'vue'
import { brandPattern } from './brand-pattern'

const props = withDefaults(
  defineProps<{
    seed: string
    name?: string
    src?: string | null
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { size: 'md' },
)

const sizeMap = { sm: 'h-8 w-8 text-sm', md: 'h-12 w-12 text-lg', lg: 'h-16 w-16 text-2xl' } as const

/**
 * 墨点走 --lnk-dim-rgb 恒黑通道（P6 先例，双主题同值 0 0 0）。
 * 不用白色 alpha：否则图案会随主题翻转，品牌识别失去连续性。
 */
const dots = computed(() =>
  brandPattern(props.seed)
    .dots.map(
      (d) =>
        `radial-gradient(circle ${d.r}% at ${d.x}% ${d.y}%, rgb(var(--lnk-dim-rgb) / ${d.alpha}) 0%, transparent 70%)`,
    )
    .join(', '),
)

const initial = computed(() => props.name?.[0] ?? '')
const alt = computed(() => (props.name ? `${props.name} 的头像` : '头像'))
</script>

<template>
  <span
    data-testid="brand-pattern"
    class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-semibold text-fg-on"
    :class="sizeMap[size]"
    :style="src ? undefined : { backgroundImage: dots }"
    :aria-label="alt"
    role="img"
  >
    <img v-if="src" :src="src" :alt="alt" class="h-full w-full object-cover" />
    <span v-else aria-hidden="true">{{ initial }}</span>
  </span>
</template>
