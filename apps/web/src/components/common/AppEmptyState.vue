<script setup lang="ts">
/**
 * 统一空状态。Design_system §3.9 契约：
 *   主文案 14 / text-fg；次文案 12 / text-fg-3；CTA 由调用方传入但句式统一。
 *
 * illustration 为可选的 IP 插画 URL。本期仓库无 IP 资产（assets/ 下只有
 * anchor-generate / anchor-locate / send-arrow 三张功能性图标），故一律不传，
 * 靠文案承担情绪；不新造资产、不用 emoji 顶替。资产就绪后按 props 接入，
 * 届时文案无需改动。
 *
 * desc 既可传 prop（静态文案）也可填 `#desc` slot（动态文案），两者互斥，
 * slot 优先。
 */
withDefaults(defineProps<{ illustration?: string; desc?: string }>(), {
  illustration: '',
  desc: '',
})
</script>

<template>
  <div class="flex flex-col items-center justify-center px-4 py-14 text-center" role="status">
    <img
      v-if="illustration"
      :src="illustration"
      alt=""
      aria-hidden="true"
      class="mb-4 h-24 w-24 object-contain"
    />
    <p class="text-sm text-fg"><slot /></p>
    <p v-if="$slots.desc || desc" class="mt-1 text-xs text-fg-3">
      <slot name="desc">{{ desc }}</slot>
    </p>
    <div v-if="$slots.action" class="mt-4"><slot name="action" /></div>
  </div>
</template>
