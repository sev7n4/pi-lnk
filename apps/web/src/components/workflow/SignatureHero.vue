<script setup lang="ts">
import { computed } from 'vue'
import CreativeLauncher from './CreativeLauncher.vue'
import {
  BRAND_LOGO_URL,
  BRAND_SLOGAN_LEAD,
  BRAND_SLOGAN_MAIN,
  BRAND_SLOGAN_MAIN_ACCENT,
} from '@/constants/brand'

// 2026-10-21/22 用户两轮裁定：① 问候语与「想象，落定成图」旧标题去掉，品牌 slogan 是唯一
// 叙事主角（主行即 h1，每页唯一）；② 底部「灵感 / 我的作品」两口去掉；③ 整体放大霸屏。
// 2026-10-22 第三轮（叙事与仪式感）：④ 墨鱼从右上角孤立角标移入 slogan 字标，
// 从「吉祥物」变「墨的源头」；⑤ 锚重做为「落款印章」——墨环 + 墨晕 + 内阴线，
// 退掉「浮起面板」语言（旧黑影 + 白晕读作贴上去的按钮）；⑥ 入口升为「门阶」pill
// （13px 弱色小字 ⇒ 16px 实色 + 字距 + 细框）；⑦ 主行按 BRAND_SLOGAN_MAIN_ACCENT
// 切分，唯一强调词上签名面专用紫；⑧ 左右叙事文案归位（产品术语退出品牌诗）。
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; create: [] }>()

// slogan 主行切分：单一真相源是 BRAND_SLOGAN_MAIN 整句，按强调词切段渲染——
// 不复制文案，防两处漂移；拼接结果必须等于整句（SignatureHero.test.ts 锁定）。
const sloganSegments = computed(() => {
  const idx = BRAND_SLOGAN_MAIN.indexOf(BRAND_SLOGAN_MAIN_ACCENT)
  if (idx < 0) return [{ text: BRAND_SLOGAN_MAIN, accent: false }]
  return [
    { text: BRAND_SLOGAN_MAIN.slice(0, idx), accent: false },
    { text: BRAND_SLOGAN_MAIN_ACCENT, accent: true },
    { text: BRAND_SLOGAN_MAIN.slice(idx + BRAND_SLOGAN_MAIN_ACCENT.length), accent: false },
  ]
})
</script>

<template>
  <section
    data-testid="signature-hero"
    class="lnk-hero-screen relative isolate overflow-hidden px-6 py-24 sm:px-10 lg:py-32"
    style="background: var(--lnk-surface-signature)"
  >
    <!-- 墨流粒子：只动 transform/opacity；reduced-motion 下静止 -->
    <div class="lnk-ink-particles pointer-events-none absolute inset-0" aria-hidden="true" />
    <div class="relative mx-auto w-full max-w-4xl text-center">
      <!-- 品牌字标（2026-10-22 用户裁定「墨鱼入场」）：slogan 右对齐 + 墨鱼在旁，
           构成「字 + 角色」的品牌签名。墨鱼与导航同源资产（BRAND_LOGO_URL），
           装饰位不变按钮（单 CTA 纪律）；移动端让位给 slogan 宽度（hidden sm:block）。 -->
      <div class="lnk-hero-lockup flex items-center justify-center gap-5 sm:gap-6">
        <div class="min-w-0 text-center sm:text-right">
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
            <template v-for="(seg, i) in sloganSegments" :key="i"><span v-if="seg.accent" class="lnk-slogan-accent">{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template>
          </h1>
        </div>
        <span class="lnk-mascot hidden shrink-0 sm:block" data-testid="brand-mascot">
          <img
            :src="BRAND_LOGO_URL"
            alt="墨鱼π 品牌形象"
            draggable="false"
            class="h-11 w-11 select-none sm:h-14 sm:w-14"
          >
        </span>
      </div>
      <!-- 对话侧：composer 只承担输入（signature 模式无内嵌按钮，CTA 收敛到锚） -->
      <div class="mt-12">
        <CreativeLauncher
          :model-value="props.modelValue"
          tone="signature"
          @update:model-value="emit('update:modelValue', $event)"
          @create="emit('create')"
        />
      </div>

      <!-- 锚 / 落款印章（用户两轮裁定）：入口是锚，不是按钮文字。
           左「对话」→ 锚 → 右「画布」：空间即故事，三个动作一次读完。
           锚 glyph = 品牌生成锚资产（与画布坞 DockGenerateButton 同源），
           mask + currentColor ⇒ 深浅主题 / hover / disabled 自动跟随 -->
      <div class="mt-16 grid items-center gap-12 lg:grid-cols-[1fr_auto_1fr] lg:gap-10">
        <!-- 左：对话（你说出想法） -->
        <div class="hidden items-center justify-end gap-6 lg:flex">
          <div class="text-right">
            <p class="text-[length:var(--lnk-text-lg)] font-medium text-[color:var(--lnk-text-on-signature)]">
              对话
            </p>
            <p class="mt-2 text-[length:var(--lnk-text-base)] leading-relaxed text-[color:var(--lnk-text-on-signature-muted)]">
              你说出想法<br>一囊墨有了方向
            </p>
          </div>
          <span class="h-px w-16 bg-gradient-to-l from-overlay/30 to-transparent" aria-hidden="true" />
        </div>
        <!-- 中：锚（唯一创作入口）+ 门阶 pill -->
        <div class="flex flex-col items-center">
          <button
            type="button"
            data-testid="ink-anchor"
            class="lnk-anchor"
            aria-label="点击锚，进入创作"
            @click="emit('create')"
          >
            <span class="lnk-anchor__halo" aria-hidden="true" />
            <span class="lnk-anchor__brush" aria-hidden="true" />
            <span class="lnk-anchor__ripple" aria-hidden="true" />
            <span class="lnk-anchor__ripple lnk-anchor__ripple--delay" aria-hidden="true" />
            <span class="lnk-anchor__glyph" aria-hidden="true" />
          </button>
          <!-- 门阶（2026-10-22 用户裁定「入口升层」）：全页唯一动作入口的标记，
               从 13px 弱色小字升为 16px 实色 + 字距 + 细框 pill -->
          <p class="lnk-anchor__cta mt-7">
            点击锚，进入创作
          </p>
        </div>
        <!-- 右：画布（墨鱼替你落墨） -->
        <div class="hidden items-center gap-6 lg:flex">
          <span class="h-px w-16 bg-gradient-to-r from-overlay/30 to-transparent" aria-hidden="true" />
          <div class="text-left">
            <p class="text-[length:var(--lnk-text-lg)] font-medium text-[color:var(--lnk-text-on-signature)]">
              画布
            </p>
            <p class="mt-2 text-[length:var(--lnk-text-base)] leading-relaxed text-[color:var(--lnk-text-on-signature-muted)]">
              墨鱼替你落墨<br>画布记住你的模样
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

/* slogan 唯一重音（2026-10-22 用户裁定）：签名面专用强调紫。
   ⛔ 不用 --lnk-accent-text：它随主题翻转，浅色下是紫 700，压恒深签名底只有 2.4:1 */
.lnk-slogan-accent {
  color: var(--lnk-accent-on-signature);
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

/* ===== 锚 / 落款印章 ===== */
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
  /* 2026-10-22 用户裁定「锚是印章，不是贴纸」：
     ① 铸造就差的内阴线——hi-text 是盘面反向色（深主题深线压白盘 / 浅主题浅线压墨盘），
        双主题自适应；② 墨色环境光——accent 混色，与墨鱼 drop-shadow 同一紫色家族。
     旧语言是「浮起面板」：黑影 + 白晕，全页最亮的物体飘在墨上，读作贴上去的按钮。 */
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-hi-text) 20%, transparent),
    0 0 28px color-mix(in srgb, var(--lnk-accent) 26%, transparent);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.lnk-anchor:hover {
  transform: scale(1.06);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-hi-text) 30%, transparent),
    0 0 44px color-mix(in srgb, var(--lnk-accent) 40%, transparent);
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

/* 墨色环境光：accent-subtle 平铺圆（令牌级紫晕，双主题自适应） */
.lnk-anchor__halo {
  position: absolute;
  inset: -34px;
  border-radius: 999px;
  background: var(--lnk-accent-subtle);
  pointer-events: none;
}

/* 墨环（enso 感）：不对称紫环——上右实、下左淡，一笔扫过的呼吸感。
   ⚠️ 类名不叫 ink-enso：那是锚资产就绪前的自造墨圈替身名，已退役（守卫锁名）。
   它是真锚资产背后的装饰环，不是替身。 */
.lnk-anchor__brush {
  position: absolute;
  inset: -15px;
  border: 1.5px solid var(--lnk-accent-border);
  border-bottom-color: var(--lnk-accent-subtle);
  border-left-color: var(--lnk-accent-subtle);
  border-radius: 999px;
  pointer-events: none;
  transition: border-color 0.2s ease;
}

.lnk-anchor:hover .lnk-anchor__brush {
  border-color: var(--lnk-accent);
  border-bottom-color: var(--lnk-accent-border);
  border-left-color: var(--lnk-accent-border);
}

/* 双层脉冲涟漪：错峰 1.4s，像锚在「呼吸」。
   2026-10-22 材质重做时同步修正：旧实现用恒黑 dim 环，压近黑签名底几乎不可见——
   「呼吸」的意图没有兑现；改走 accent 实色，扩散渐隐，意图与观感一致。 */
.lnk-anchor__ripple {
  position: absolute;
  inset: 0;
  border: 1px solid var(--lnk-accent);
  border-radius: 999px;
  pointer-events: none;
  animation: lnk-anchor-pulse 2.8s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
}

.lnk-anchor__ripple--delay {
  animation-delay: 1.4s;
}

/* 门阶 pill（2026-10-22 用户裁定「入口升层」）：全页唯一动作入口的标记。
   16px 实色 + 0.18em 字距 + 细框；右内距用 calc 抵掉末字字距，保持视觉居中 */
.lnk-anchor__cta {
  display: inline-flex;
  align-items: center;
  border: 1px solid color-mix(in srgb, var(--lnk-text-on-signature) 24%, transparent);
  border-radius: 999px;
  padding: 7px calc(18px - 0.18em) 7px 18px;
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  letter-spacing: 0.18em;
  color: var(--lnk-text-on-signature);
}

/* 动效只三处（规格 §7.4），但每一处都必须能被系统「减少动态效果」停掉 */
@media (prefers-reduced-motion: reduce) {
  .lnk-ink-particles,
  .lnk-mascot {
    animation: none;
  }

  .lnk-anchor__ripple {
    animation: none;
    opacity: 0;
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
</style>
