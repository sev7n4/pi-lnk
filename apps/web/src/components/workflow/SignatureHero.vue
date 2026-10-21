<script setup lang="ts">
import CreativeLauncher from './CreativeLauncher.vue'
import { BRAND_LOGO_URL, BRAND_SLOGAN_LEAD, BRAND_SLOGAN_MAIN } from '@/constants/brand'

// 2026-10-21/22 用户两轮裁定：① 问候语与「想象，落定成图」旧标题去掉，品牌 slogan 是唯一
// 叙事主角（主行即 h1，每页唯一）；② 底部「灵感 / 我的作品」两口去掉；③ 整体放大霸屏。
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; create: [] }>()
</script>

<template>
  <section
    data-testid="signature-hero"
    class="lnk-hero-screen relative isolate overflow-hidden px-6 py-24 sm:px-10 lg:py-32"
    style="background: var(--lnk-surface-signature)"
  >
    <!-- 墨流粒子：只动 transform/opacity；reduced-motion 下静止 -->
    <div class="lnk-ink-particles pointer-events-none absolute inset-0" aria-hidden="true" />
    <!-- 墨鱼π 品牌氛围位（右上角，装饰非入口）：与导航同源资产，走 BRAND_LOGO_URL。
         墨鱼进 hero + 锚是创作入口两轮裁定叠加 ⇒ 墨鱼降为氛围，
         交互中心让位给 ink-anchor（单 CTA 纪律，装饰位不得变按钮） -->
    <span class="lnk-mascot absolute right-8 top-8 hidden sm:block" data-testid="brand-mascot">
      <img
        :src="BRAND_LOGO_URL"
        alt="墨鱼π 品牌形象"
        draggable="false"
        class="h-20 w-20 select-none lg:h-24 lg:w-24"
      >
    </span>
    <div class="relative mx-auto w-full max-w-4xl text-center">
      <!-- 品牌 slogan（用户裁定）：双行叙事，先共鸣后承诺；主行即页面唯一 h1。
           只用 on-signature 实色令牌——品牌渐变禁载小字（F-5 3.67:1 不过 AA） -->
      <p
        class="text-[length:var(--lnk-text-md)] leading-[var(--lnk-lh-md)] text-[color:var(--lnk-text-on-signature-muted)] sm:text-[length:var(--lnk-text-lg)] sm:leading-[var(--lnk-lh-lg)]"
      >
        {{ BRAND_SLOGAN_LEAD }}
      </p>
      <h1
        class="mt-3 font-bold text-[length:var(--lnk-text-2xl)] leading-[var(--lnk-lh-2xl)] text-[color:var(--lnk-text-on-signature)] sm:text-[length:var(--lnk-text-3xl)] sm:leading-[var(--lnk-lh-3xl)] lg:text-[length:var(--lnk-text-4xl)] lg:leading-[var(--lnk-lh-4xl)]"
      >
        {{ BRAND_SLOGAN_MAIN }}
      </h1>
      <!-- 对话侧：composer 只承担输入（signature 模式无内嵌按钮，CTA 收敛到锚） -->
      <div class="mt-12">
        <CreativeLauncher
          :model-value="props.modelValue"
          tone="signature"
          @update:model-value="emit('update:modelValue', $event)"
          @create="emit('create')"
        />
      </div>

      <!-- 锚 / 传送门（用户裁定）：入口是锚，不是按钮文字。
           左「对话」→ 锚 → 右「画布」，墨鱼用锚酒图，零跳变。
           锚 glyph = 品牌生成锚资产（与画布坞 DockGenerateButton 同源），
           mask + currentColor ⇒ 深浅主题 / hover / disabled 自动跟随 -->
      <div class="mt-16 grid items-center gap-12 lg:grid-cols-[1fr_auto_1fr] lg:gap-10">
        <!-- 左：对话（一囊墨） -->
        <div class="hidden items-center justify-end gap-6 lg:flex">
          <div class="text-right">
            <p class="text-[length:var(--lnk-text-lg)] font-medium text-[color:var(--lnk-text-on-signature)]">
              对话
            </p>
            <p class="mt-2 text-[length:var(--lnk-text-base)] leading-relaxed text-[color:var(--lnk-text-on-signature-muted)]">
              你下指令（一囊墨）<br>composer 含定位锚
            </p>
          </div>
          <span class="h-px w-16 bg-gradient-to-l from-overlay/30 to-transparent" aria-hidden="true" />
        </div>
        <!-- 中：锚（唯一创作入口） -->
        <div class="flex flex-col items-center">
          <button
            type="button"
            data-testid="ink-anchor"
            class="lnk-anchor"
            aria-label="点击锚，进入创作"
            @click="emit('create')"
          >
            <span class="lnk-anchor__ripple" aria-hidden="true" />
            <span class="lnk-anchor__ripple lnk-anchor__ripple--delay" aria-hidden="true" />
            <span class="lnk-anchor__ring" aria-hidden="true" />
            <span class="lnk-anchor__ring lnk-anchor__ring--inner" aria-hidden="true" />
            <span class="lnk-anchor__glyph" aria-hidden="true" />
          </button>
          <p class="mt-7 text-[length:var(--lnk-text-sm)] text-[color:var(--lnk-text-on-signature-muted)]">
            点击锚，进入创作
          </p>
        </div>
        <!-- 右：画布（落地） -->
        <div class="hidden items-center gap-6 lg:flex">
          <span class="h-px w-16 bg-gradient-to-r from-overlay/30 to-transparent" aria-hidden="true" />
          <div class="text-left">
            <p class="text-[length:var(--lnk-text-lg)] font-medium text-[color:var(--lnk-text-on-signature)]">
              画布
            </p>
            <p class="mt-2 text-[length:var(--lnk-text-base)] leading-relaxed text-[color:var(--lnk-text-on-signature-muted)]">
              Agent 把创作落地<br>记住你的模样
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 2026-10-22 用户裁定「霸屏铺满」：hero 占满首屏（顶栏高度走 --neo-header-height），
   四边贴视口，不再是页面容器里露白边的圆角卡片。
   dvh 后置书写：支持 dvh 的浏览器用它（移动端地址栏收缩不跳动），旧 Safari 回退 vh */
.lnk-hero-screen {
  display: flex;
  align-items: center;
  min-height: calc(100vh - var(--neo-header-height));
  min-height: calc(100dvh - var(--neo-header-height));
}

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

/* ===== 锚 / 传送门 ===== */
.lnk-anchor {
  position: relative;
  display: grid;
  width: 168px;
  height: 168px;
  flex-shrink: 0;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: var(--lnk-hi-bg);
  color: var(--lnk-hi-text);
  box-shadow: var(--lnk-hi-shadow);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.lnk-anchor:hover {
  transform: scale(1.06);
}

.lnk-anchor:active {
  transform: scale(0.98);
}

.lnk-anchor:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 4px;
}

/* 品牌生成锚 glyph（源 94×106）：currentColor 上色 + mask 成形 */
.lnk-anchor__glyph {
  display: block;
  width: 70px;
  height: 80px;
  background: currentColor;
  -webkit-mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
  mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
}

/* 同心圆双环：传送门的「门框」，越外越淡 */
.lnk-anchor__ring {
  position: absolute;
  inset: -16px;
  border: 1px solid rgb(var(--lnk-dim-rgb) / 0.3);
  border-radius: 999px;
  pointer-events: none;
}

.lnk-anchor__ring--inner {
  inset: -34px;
  border-color: rgb(var(--lnk-dim-rgb) / 0.14);
}

/* 双层脉冲涟漪：错峰 1.4s，像锚在「呼吸」 */
.lnk-anchor__ripple {
  position: absolute;
  inset: 0;
  border: 1px solid rgb(var(--lnk-dim-rgb) / 0.4);
  border-radius: 999px;
  pointer-events: none;
  animation: lnk-anchor-pulse 2.8s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
}

.lnk-anchor__ripple--delay {
  animation-delay: 1.4s;
}

@keyframes lnk-anchor-pulse {
  0% {
    transform: scale(1);
    opacity: 0.55;
  }
  100% {
    transform: scale(1.85);
    opacity: 0;
  }
}

/* 动效只三处（规格 §7.4），但每一处都必须能被系统「减少动态效果」停掉 */
@media (prefers-reduced-motion: reduce) {
  .lnk-ink-particles,
  .lnk-mascot {
    animation: none;
  }

  .lnk-anchor__ripple {
    animation: none;
    opacity: 0.22;
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
