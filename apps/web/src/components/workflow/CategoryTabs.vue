<script setup lang="ts">
defineProps<{
  categories: readonly string[]
  modelValue: string
}>()

defineEmits<{ 'update:modelValue': [v: string] }>()
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <button
      v-for="cat in categories"
      :key="cat"
      type="button"
      class="rounded-full px-4 py-1.5 text-sm transition"
      :class="modelValue === cat ? 'bg-[#6366f1] text-fg' : 'bg-overlay/5 text-fg-2 hover:text-fg'"
      @click="$emit('update:modelValue', cat)"
    >
      {{ cat }}
    </button>
  </div>
</template>
