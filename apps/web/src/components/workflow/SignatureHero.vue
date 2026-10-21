<script setup lang="ts">
import CreativeLauncher from './CreativeLauncher.vue'
import { BRAND_LOGO_URL, BRAND_SLOGAN_LEAD, BRAND_SLOGAN_MAIN } from '@/constants/brand'

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
      <h1
        class="font-bold text-[length:var(--lnk-text-display-2)] leading-[var(--lnk-lh-display-2)] text-[color:var(--lnk-text-on-signature)]"
      >
        想象，落定成图
      </h1>
      <!-- 品牌 slogan（2026-10-21 用户裁定）：双行叙事，先共鸣后承诺。
           只用 on-signature 实色令牌——品牌渐变禁载小字（F-5 3.67:1 不过 AA） -->
      <p
        class="mt-4 text-sm leading-[var(--lnk-lh-sm)] text-[color:var(--lnk-text-on-signature-muted)]"
      >
        {{ BRAND_SLOGAN_LEAD }}
      </p>
      <p
        class="mt-1.5 text-[length:var(--lnk-text-md)] font-medium leading-[var(--lnk-lh-md)] text-[color:var(--lnk-text-on-signature)]"
      >
        {{ BRAND_SLOGAN_MAIN }}
      </p>
      <div class="mt-8">
        <CreativeLauncher
          :model-value="props.modelValue"
          tone="signature"
          @update:model-value="emit('update:modelValue', $event)"
          @create="emit('create')"
        />
      </div>
      <!-- 显色时刻：墨鱼π 品牌形象呼吸（2026-10-21 用户裁定：墨圈 stand-in 换真身，
           资产与导航栏同源 public/brand/mascot-logo.png，走 BRAND_LOGO_URL 单一真相源） -->
      <div class="mt-8 flex justify-center">
        <span class="lnk-mascot" data-testid="brand-mascot">
          <img
            :src="BRAND_LOGO_URL"
            alt="墨鱼π 品牌形象"
            draggable="false"
            class="h-36 w-36 select-none sm:h-44 sm:w-44"
          >
        </span>
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

/* 墨鱼只借 accent-glow 的一层柔光（令牌成对，无裸 rgba） */
.lnk-mascot img {
  filter: drop-shadow(var(--lnk-accent-glow));
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
