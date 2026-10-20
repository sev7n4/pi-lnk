<script setup lang="ts">
/**
 * tone: 'signature' 用于深海墨底签名画面——placeholder 必须换 on-signature 令牌，
 * 否则浅色主题下 text-fg-3（深色）压深底会静默不可见（P0 计划 Review Focus #1）。
 */
withDefaults(defineProps<{ modelValue: string; tone?: 'default' | 'signature' }>(), {
  tone: 'default',
})
const emit = defineEmits<{ 'update:modelValue': [v: string]; create: [] }>()
</script>

<template>
  <div class="flex items-center gap-2 rounded-lg border border-overlay/12 bg-surface-sunken p-2">
    <input
      :value="modelValue"
      type="text"
      class="min-w-0 flex-1 bg-transparent px-2 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-[var(--lnk-border-focus)]"
      :class="
        tone === 'signature'
          ? 'text-[color:var(--lnk-text-on-signature)] placeholder:text-[color:var(--lnk-text-on-signature-muted)]'
          : 'text-fg placeholder:text-fg-3'
      "
      placeholder="描述你的创意…"
      aria-label="描述你的创意，按下 Enter 开始创作"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('create')"
    />
    <button type="button" class="btn-primary" @click="emit('create')">开始创作</button>
  </div>
</template>
