<script setup lang="ts">
import CreativeLauncher from './CreativeLauncher.vue'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'

// greeting 是必填 prop：时段问候由 WorkflowPage 计算并传入，本组件不做时段判断
// （避免两处问候逻辑漂移）。字号降级由本组件的 text-sm 承担。
const props = defineProps<{ modelValue: string; greeting: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; create: [] }>()
</script>

<template>
  <section
    data-testid="signature-hero"
    class="relative isolate overflow-hidden rounded-2xl px-6 py-16 sm:py-20"
    style="background: var(--lnk-surface-signature)"
  >
    <!-- 墨流粒子：只动 transform/opacity；reduced-motion 下静止 -->
    <div class="lnk-ink-particles pointer-events-none absolute inset-0" aria-hidden="true" />
    <div class="relative mx-auto max-w-2xl text-center">
      <p data-greeting class="mb-6 text-left text-sm text-[color:var(--lnk-text-on-signature-muted)]">
        {{ props.greeting }}
      </p>
      <h2
        class="font-bold text-[length:var(--lnk-text-display-2)] leading-[var(--lnk-lh-display-2)] text-[color:var(--lnk-text-on-signature)]"
      >
        想象，落定成图
      </h2>
      <p class="mt-3 text-sm text-[color:var(--lnk-text-on-signature-muted)]">
        一句话，在无限画布上生成图像 · 视频 · 漫剧
      </p>
      <div class="mt-8">
        <CreativeLauncher
          :model-value="props.modelValue"
          tone="signature"
          @update:model-value="emit('update:modelValue', $event)"
          @create="emit('create')"
        />
      </div>
      <!-- 显色时刻：mascot 呼吸 -->
      <div class="mt-8 flex justify-center">
        <BrandPatternAvatar seed="mascot" name="墨鱼 π" size="lg" class="lnk-mascot" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.lnk-ink-particles {
  background-image:
    radial-gradient(circle 18% at 12% 24%, rgb(var(--lnk-dim-rgb) / 0.32) 0%, transparent 70%),
    radial-gradient(circle 12% at 78% 18%, rgb(var(--lnk-dim-rgb) / 0.24) 0%, transparent 70%),
    radial-gradient(circle 22% at 62% 76%, rgb(var(--lnk-dim-rgb) / 0.2) 0%, transparent 70%);
  animation: lnk-ink-drift 12s ease-in-out infinite alternate;
}

.lnk-mascot {
  animation: lnk-mascot-breathe 4s ease-in-out infinite;
}

/* 动效只三处（规格 §7.4），但每一处都必须能被系统「减少动态效果」停掉 */
@media (prefers-reduced-motion: reduce) {
  .lnk-ink-particles,
  .lnk-mascot {
    animation: none;
  }
}

@keyframes lnk-ink-drift {
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(0, -8px, 0);
  }
}

@keyframes lnk-mascot-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.04);
  }
}
</style>
