<script setup lang="ts">
import { computed, ref } from 'vue'
import CreativeLauncher from './CreativeLauncher.vue'
import {
  BRAND_LOGO_URL,
  BRAND_SLOGAN_LEAD,
  BRAND_SLOGAN_MAIN,
  BRAND_SLOGAN_MAIN_ACCENT,
  BRAND_SLOGAN_MAIN_MASCOT_BEFORE,
} from '@/constants/brand'

// 2026-10-21/22 用户两轮裁定：① 问候语与「想象，落定成图」旧标题去掉，品牌 slogan 是唯一
// 叙事主角（主行即 h1，每页唯一）；② 底部「灵感 / 我的作品」两口去掉；③ 整体放大霸屏。
// 2026-10-22 第三轮（叙事与仪式感）：④ 墨鱼进 slogan 字标；⑤ 锚=落款印章（墨环+墨晕+
// 内阴线，禁浮起面板语言）；⑥ 入口=门阶 pill；⑦ slogan 重音；⑧ 文案归位。
// 第三轮·第二批（动结构）：⑨ 叙事动线重排——输入框进三联左侧（它本来就是「对话」），
// 左「说」→ 中「锚」→ 右「落」，空间即故事；⑩ 墨点动效（「一点一滴」视觉化）；
// ⑪ 落款微时刻（点锚 = 盖章：压下回弹 + 墨点四散）。
// 第三轮·第三批（用户四条反馈）：⑫ 墨鱼对位「洒下的墨」正上方——2026-10-22 无头浏览器
// 实测：墨鱼 inline 在句中时图标中心距锚轴恒定 -157.2px（1280~1920 四档一致，居中末行
// 的行首），几何上不可能既「在『记住你的模样』前面」又「在墨滴上方」。改为悬在落域顶：
// 恰在居中末行「记住你的模样。」正下方、墨滴正上方，「墨从它身上撒下来」由结构保证，
// 不依赖视口/字体；行内留等宽垫片保住断行节奏。⑬ 输入框重做；⑭ 锚外环紫晕减重；
// ⑮ 墨点改水滴形。另修：三联两侧 1fr 被 min-content 撑得不均等 ⇒ 锚比 slogan 中轴
// 偏右 30px（实测 750.1 vs 720）⇒ 改 minmax(0,1fr) 归中。
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; create: [] }>()

// slogan 主行切分：单一真相源是 BRAND_SLOGAN_MAIN 整句，按标记词切段渲染——
// 不复制文案，防两处漂移；拼接结果必须等于整句（SignatureHero.test.ts 锁定）。
// 两处标记：accent（视觉重音）+ mascot（inline 墨鱼位，插在该词之前）。
const sloganSegments = computed(() => {
  const marks: { at: number; len: number; accent: boolean; mascot: boolean }[] = []
  const a = BRAND_SLOGAN_MAIN.indexOf(BRAND_SLOGAN_MAIN_ACCENT)
  const m = BRAND_SLOGAN_MAIN.indexOf(BRAND_SLOGAN_MAIN_MASCOT_BEFORE)
  if (a >= 0) {
    marks.push({ at: a, len: BRAND_SLOGAN_MAIN_ACCENT.length, accent: true, mascot: false })
  }
  if (m >= 0) {
    marks.push({ at: m, len: BRAND_SLOGAN_MAIN_MASCOT_BEFORE.length, accent: false, mascot: true })
  }
  if (!marks.length) return [{ text: BRAND_SLOGAN_MAIN, accent: false, mascot: false }]
  marks.sort((x, y) => x.at - y.at)
  const out: { text: string; accent: boolean; mascot: boolean }[] = []
  let cur = 0
  for (const k of marks) {
    if (k.at > cur) out.push({ text: BRAND_SLOGAN_MAIN.slice(cur, k.at), accent: false, mascot: false })
    out.push({ text: BRAND_SLOGAN_MAIN.slice(k.at, k.at + k.len), accent: k.accent, mascot: k.mascot })
    cur = k.at + k.len
  }
  if (cur < BRAND_SLOGAN_MAIN.length) {
    out.push({ text: BRAND_SLOGAN_MAIN.slice(cur), accent: false, mascot: false })
  }
  return out
})

// 落款微时刻（2026-10-22 用户裁定「点击瞬间是品牌最可被截图的记忆点」）：
// 点锚 = 盖章——印章压下回弹 + 墨点四散。class 由点击方自摘（600ms），
// 连点时先清旧定时器再重启，防定时器叠加/class 卡死。
const stamping = ref(false)
let stampTimer: number | undefined

function onAnchorClick() {
  emit('create')
  stamping.value = true
  window.clearTimeout(stampTimer)
  stampTimer = window.setTimeout(() => {
    stamping.value = false
  }, 600)
}
</script>

<template>
  <section
    data-testid="signature-hero"
    class="lnk-hero-screen relative isolate overflow-hidden px-6 py-12 sm:px-10 lg:py-32"
    style="background: var(--lnk-surface-signature)"
  >
    <!-- 墨流粒子：只动 transform/opacity；reduced-motion 下静止 -->
    <div class="lnk-ink-particles pointer-events-none absolute inset-0" aria-hidden="true" />
    <div class="relative mx-auto w-full max-w-4xl text-center">
      <!-- 品牌字标（2026-10-22 用户裁定「墨鱼入场」）：墨鱼图标本体悬在落域顶——
           「记住你的模样。」居中末行的正下方、洒下的墨的正上方，与墨滴、锚同轴；
           行内只留等宽垫片保断行节奏（见 .lnk-slogan-mascot-gap）。装饰位不变按钮。 -->
      <div class="lnk-hero-lockup">
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
          <template v-for="(seg, i) in sloganSegments" :key="i"><span v-if="seg.accent" class="lnk-slogan-accent">{{ seg.text }}</span><span v-else-if="seg.mascot" class="lnk-slogan-mascot"><span class="lnk-slogan-mascot-gap" aria-hidden="true"></span>{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template>
        </h1>
      </div>

      <!-- 叙事舞台（2026-10-22 用户裁定「空间即故事」）：输入框进三联左侧——它本来
           就是「对话」，从此不再坐在叙事位 200px 开外。左「说」→ 中「锚」→ 右「落」，
           一条动线一次读完；移动端自然竖排（输入 → 锚 → 落点注脚），锚+门阶始终首屏可见。
           ⚠️ 两侧必须 minmax(0,1fr)：裸 1fr 的隐式 min 是 min-content，左右列内容宽度
           不等会把中列挤偏——实测锚因此偏离 slogan 中轴 30px（750 vs 720）。
           ⛔ 2026-10-23 用户裁定：窄屏也**完整复刻**这三叙事（对话标签组 / 墨鱼→墨滴→锚 /
           画布标签组），只是尺寸压缩；不得另造一条「三联 legend」插在旁边（那是对叙事的
           二次转述，用户判定为多出来、违背品牌设计意图）。 -->
      <div class="lnk-stage mt-6 grid justify-items-center gap-y-6 lg:mt-0 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-x-10 lg:gap-y-12">
        <!-- 左：对话（输入站） -->
        <div class="flex w-full flex-col items-center gap-3 lg:flex-row lg:items-center lg:justify-end lg:gap-6">
          <div class="lnk-stage__talk flex w-full max-w-md flex-col items-center gap-3 lg:max-w-none lg:items-end">
            <!-- 窄屏也显示「对话 / 你说出想法」（2026-10-23）：PC 三叙事的左列内容整体复用，
                 字号按窄屏降一档（lg 断点还原 PC 尺寸）。 -->
            <div class="text-center lg:text-right">
              <p class="text-[length:var(--lnk-text-base)] font-medium text-[color:var(--lnk-text-on-signature)] lg:text-[length:var(--lnk-text-lg)]">
                对话
              </p>
              <p class="mt-2 text-[length:var(--lnk-text-base)] leading-relaxed text-[color:var(--lnk-text-on-signature-muted)]">
                你说出想法
              </p>
            </div>
            <CreativeLauncher
              class="w-full"
              :model-value="props.modelValue"
              tone="signature"
              @update:model-value="emit('update:modelValue', $event)"
              @create="emit('create')"
            />
          </div>
          <span class="hidden h-px w-16 shrink-0 bg-gradient-to-l from-overlay/30 to-transparent lg:block" aria-hidden="true" />
        </div>

        <!-- 中：落域（墨鱼悬顶 + 墨滴散落）+ 落款印章（唯一创作入口）+ 门阶 pill -->
        <div class="relative flex flex-col items-center">
          <!-- 墨滴落域（2026-10-22 用户裁定「一点一滴视觉化」+「墨鱼在洒下的墨的上方」）：
               墨鱼悬在落域顶（恰在居中末行「记住你的模样。」正下方），三颗水滴墨从它身上
               散开、落入锚顶——墨鱼 → 墨滴 → 锚一条垂直轴，对位由 flex 居中结构保证。
               落域高度含 stage 在 lg 下的外距（48px 空隙 + 96px 落程），锚的位置不变；
               移动端不占位（锚+门阶保持首屏可见）。 -->
          <div class="lnk-drop-zone relative w-full" aria-hidden="true">
            <span class="lnk-mascot-hang" data-testid="brand-mascot">
              <img
                :src="BRAND_LOGO_URL"
                alt="墨鱼π 品牌形象"
                draggable="false"
                class="lnk-mascot lnk-mascot-hang__img"
              >
            </span>
            <span class="lnk-ink-drop" style="--drop-dx0: -10px; --drop-dx1: -40px; --drop-delay: 0s" />
            <span class="lnk-ink-drop" style="--drop-dx0: 0px; --drop-dx1: 6px; --drop-delay: 1.2s" />
            <span class="lnk-ink-drop" style="--drop-dx0: 8px; --drop-dx1: 48px; --drop-delay: 2.4s" />
          </div>
          <button
            type="button"
            data-testid="ink-anchor"
            class="lnk-anchor"
            :class="{ 'lnk-anchor--stamping': stamping }"
            aria-label="点击锚，进入创作"
            @click="onAnchorClick"
          >
            <span class="lnk-anchor__halo" aria-hidden="true" />
            <span class="lnk-anchor__brush" aria-hidden="true" />
            <span class="lnk-anchor__ripple" aria-hidden="true" />
            <span class="lnk-anchor__ripple lnk-anchor__ripple--delay" aria-hidden="true" />
            <span class="lnk-anchor__glyph" aria-hidden="true" />
            <!-- 落款微时刻：盖章瞬间六颗墨点四散（方向各自带 --sx/--sy） -->
            <span class="lnk-anchor__spark" aria-hidden="true" style="--sx: -78px; --sy: -40px" />
            <span class="lnk-anchor__spark" aria-hidden="true" style="--sx: -30px; --sy: -84px" />
            <span class="lnk-anchor__spark" aria-hidden="true" style="--sx: 44px; --sy: -70px" />
            <span class="lnk-anchor__spark" aria-hidden="true" style="--sx: 82px; --sy: -18px" />
            <span class="lnk-anchor__spark" aria-hidden="true" style="--sx: -64px; --sy: 52px" />
            <span class="lnk-anchor__spark" aria-hidden="true" style="--sx: 60px; --sy: 58px" />
          </button>
          <!-- 门阶（2026-10-22 用户裁定「入口升层」）：全页唯一动作入口的标记。
               窄屏收紧上间距（2026-10-23：移动端品牌页要一屏装下完整三叙事） -->
          <p class="lnk-anchor__cta mt-5 lg:mt-7">
            点击锚，进入创作
          </p>
        </div>

        <!-- 右：画布（落点） -->
        <div class="flex w-full flex-col items-center gap-3 lg:flex-row lg:items-center lg:justify-start lg:gap-6">
          <span class="hidden h-px w-16 shrink-0 bg-gradient-to-r from-overlay/30 to-transparent lg:block" aria-hidden="true" />
          <div class="text-center lg:text-left">
            <!-- 窄屏也显示「画布」标签（2026-10-23）：PC 三叙事的右列内容整体复用，
                 字号按窄屏降一档（lg 断点还原 PC 尺寸）。 -->
            <p class="text-[length:var(--lnk-text-base)] font-medium text-[color:var(--lnk-text-on-signature)] lg:text-[length:var(--lnk-text-lg)]">
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
  /* ===== 窄屏尺寸组（2026-10-23 用户裁定「移动端品牌页 = 完整复刻 PC 三叙事」）=====
     移动端品牌页要一屏装下完整三叙事（对话标签组 + 输入框 + 墨鱼→墨滴→锚 + 画布标签组），
     而 PC 端那套尺寸（锚 168px / 落程 144px / 墨鱼 40px）是给三列横排设计的。
     ⇒ 窄屏用压缩值、lg 断点还原 PC 值（沿用本文件已有的 lg 断点写法，不引入新补丁）。
     变量清单：落程（墨鱼→墨滴→锚）/ 墨滴起点 / 锚盘尺寸 / 锚 glyph 尺寸 / 墨鱼尺寸。 */
  --lnk-drop-fall: 72px;
  --lnk-drop-start: 22px;
  --lnk-anchor-size: 132px;
  --lnk-anchor-glyph-w: 54px;
  --lnk-anchor-glyph-h: 62px;
  --lnk-mascot-size: 32px;
}

@media (min-width: 1024px) {
  .lnk-hero-screen {
    /* 墨滴落域的唯一真相源：落域高度与 keyframe 落距都引用它，改一处即同步。
       144px = stage 在 lg 下的 48px 空隙 + 96px 落程——落域吃掉空隙后锚的位置不变 */
    --lnk-drop-fall: 144px;
    /* 墨滴起点：悬在落域顶的墨鱼（40px）下方，墨从它身上离开的那条线 */
    --lnk-drop-start: 32px;
    --lnk-anchor-size: 168px;
    --lnk-anchor-glyph-w: 70px;
    --lnk-anchor-glyph-h: 80px;
    --lnk-mascot-size: 40px;
  }
}

/* slogan 唯一重音（2026-10-22 用户裁定）：签名面专用强调紫。
   ⛔ 不用 --lnk-accent-text：它随主题翻转，浅色下是紫 700，压恒深签名底只有 2.4:1 */
.lnk-slogan-accent {
  color: var(--lnk-accent-on-signature);
}

/* inline 墨鱼位（2026-10-22 第三批反馈 ① 的落地形态）：墨鱼图标本体已悬到落域顶
   （「在洒下的墨的上方」，见 .lnk-mascot-hang），行内留一枚**等宽隐形垫片**——
   ① 保住断行节奏：垫片占位 ≈ 原图标宽度，拿掉后整句可能挤进一行，「记住你的模样。」
   不再独占居中末行，墨鱼就失去「就在这句话正下方」的邻近性；
   ② 视觉节奏与用户已认可的版本逐像素一致（原来这里是图标，现在是空位）。 */
.lnk-slogan-mascot {
  white-space: nowrap;
}

.lnk-slogan-mascot-gap {
  display: inline-block;
  width: 1.24em;
}

.lnk-ink-particles {
  background-image:
    radial-gradient(circle 18% at 12% 24%, rgb(var(--lnk-dim-rgb) / 0.32) 0%, transparent 70%),
    radial-gradient(circle 12% at 78% 18%, rgb(var(--lnk-dim-rgb) / 0.24) 0%, transparent 70%),
    radial-gradient(circle 22% at 62% 76%, rgb(var(--lnk-dim-rgb) / 0.2) 0%, transparent 70%);
  animation: lnk-ink-drift 12s ease-in-out infinite alternate;
}

/* 呼吸 + 一层 accent 柔光（令牌成对，无裸 rgba）。
   墨鱼悬在落域顶（img 是 block），transform 只对非 inline 生效 ⇒ 动画挂在 img 上。 */
.lnk-mascot {
  animation: lnk-mascot-breathe 4s ease-in-out infinite;
  filter: drop-shadow(var(--lnk-accent-glow));
}

/* ===== 墨滴落域（2026-10-22 用户裁定「一点一滴视觉化」）=====
   墨鱼悬在落域顶，三颗水滴墨从它身上散开、落入锚顶，到缘即没（锚是不透明盘面，
   DOM 序在落域之后 ⇒ 墨滴被盘面自然吞没）。对位由 flex 居中结构保证，不依赖视口。
   2026-10-22 第三批反馈 ④：水滴形——尖头朝上（border-radius 的 0 角旋转到正上方），
   下落途中被重力拉长（scaleY > scaleX）。
   只动 transform/opacity；reduced-motion 下静止且不可见。
   ⚠️ 2026-10-23：窄屏**也显示**（移动端品牌页完整复刻 PC 三叙事 ⇒ 墨鱼→墨滴→锚
   必须在位），落域高度改由 --lnk-drop-fall 决定（窄屏 72px / PC 144px）。 */
.lnk-drop-zone {
  display: block;
  height: var(--lnk-drop-fall);
}

/* 墨鱼悬在洒下的墨正上方：落域顶、水平居中——与墨滴、锚同一条垂直轴。
   line-height: 0 防止行盒把落域撑高。移动端随落域一起隐藏（墨的故事只在 lg 讲）。 */
.lnk-mascot-hang {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  line-height: 0;
}

.lnk-mascot-hang__img {
  display: block;
  width: var(--lnk-mascot-size);
  height: var(--lnk-mascot-size);
  user-select: none;
}

.lnk-ink-drop {
  position: absolute;
  top: var(--lnk-drop-start);
  left: 50%;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  /* 尖角在左上角；rotate(45deg) 把它转到正上方（0 角 → 屏幕上方），即水滴的头 */
  border-radius: 0 50% 50% 50%;
  background: var(--lnk-accent);
  opacity: 0;
  pointer-events: none;
  /* 重力曲线：起步慢、越落越快（不是匀速linear，那读不出「滴」） */
  animation: lnk-ink-drop-fall 3.6s cubic-bezier(0.42, 0, 0.85, 0.45) infinite;
  animation-delay: var(--drop-delay, 0s);
}

/* ⚠️ 变换顺序不能改：rotate 在最后（先作用）把尖头转正，scale 在中间按**屏幕**轴向
   拉长（translate 是纯平移，不改变轴向）⇒ 水滴沿下落方向被抽长，而不是斜着长。
   起点 dx0 ≈ 0（墨鱼正下方），终点 dx1 散开（±48px，落在锚盘上）——「洒」的扇形
   在下落中展开，水平漂移 ≤ 48px / 落程 112px ≈ 23°，是「被撒开」不是「被吹斜」。 */
@keyframes lnk-ink-drop-fall {
  0% {
    transform: translate(var(--drop-dx0, 0), 0) scale(0.5) rotate(45deg);
    opacity: 0;
  }
  10% {
    opacity: 0.9;
  }
  72% {
    opacity: 0.9;
  }
  92% {
    opacity: 0.5;
  }
  100% {
    transform: translate(var(--drop-dx1, var(--drop-dx0, 0)), calc(var(--lnk-drop-fall) - var(--lnk-drop-start))) scale(0.82, 1.22) rotate(45deg);
    opacity: 0;
  }
}

/* ===== 锚 / 落款印章 ===== */
.lnk-anchor {
  position: relative;
  display: grid;
  width: var(--lnk-anchor-size);
  height: var(--lnk-anchor-size);
  flex-shrink: 0;
  place-items: center;
  border: none;
  border-radius: 999px;
  /* 2026-10-22 用户裁定「锚是印章，不是贴纸」：
     ① 铸造就差的内阴线——刻痕色是盘面反向色；② 墨色环境光——accent 混色。
     旧语言是「浮起面板」：黑影 + 白晕，全页最亮的物体飘在墨上，读作贴上去的按钮。
     ⛔ 盘面/刻痕必须走 --lnk-stamp-*-on-signature（主题不变式），不能用 --lnk-hi-bg /
     --lnk-hi-text：那对令牌随主题翻转，压在**不翻转**的恒深签名底上会让锚在浅色
     主题下翻成近黑盘、整颗沉进墨里（2026-10-22 用户实测「白天应该放白色高亮的」）。 */
  background: var(--lnk-stamp-face-on-signature);
  color: var(--lnk-stamp-ink-on-signature);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-stamp-ink-on-signature) 20%, transparent),
    0 0 20px color-mix(in srgb, var(--lnk-accent) 16%, transparent);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.lnk-anchor:hover {
  transform: scale(1.06);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-stamp-ink-on-signature) 30%, transparent),
    0 0 32px color-mix(in srgb, var(--lnk-accent) 26%, transparent);
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
  width: var(--lnk-anchor-glyph-w);
  height: var(--lnk-anchor-glyph-h);
  background: currentColor;
  -webkit-mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
  mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
}

/* 墨色环境光（2026-10-22 第三批反馈 ③「外环光晕紫色效果偏重」）：
   平铺圆收小到 -20px，紫度对折（accent-subtle 再混一半透明）——原来 -34px 满强度
   的紫饼把整颗锚泡在紫里，像开了滤镜；现在只做「墨未干」的一圈薄雾。 */
.lnk-anchor__halo {
  position: absolute;
  inset: -20px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lnk-accent-subtle) 50%, transparent);
  pointer-events: none;
}

/* 墨环（enso 感）：不对称紫环——上右实、下左淡，一笔扫过的呼吸感。
   ⚠️ 类名不叫 ink-enso：那是锚资产就绪前的自造墨圈替身名，已退役（守卫锁名）。
   它是真锚资产背后的装饰环，不是替身。
   紫度同 ③：强侧由 accent-border 降到 65%，去掉「紫圈描边」的塑料感。 */
.lnk-anchor__brush {
  position: absolute;
  inset: -15px;
  border: 1.5px solid color-mix(in srgb, var(--lnk-accent-border) 65%, transparent);
  border-bottom-color: var(--lnk-accent-subtle);
  border-left-color: var(--lnk-accent-subtle);
  border-radius: 999px;
  pointer-events: none;
  transition: border-color 0.2s ease;
}

.lnk-anchor:hover .lnk-anchor__brush {
  border-color: color-mix(in srgb, var(--lnk-accent) 65%, transparent);
  border-bottom-color: var(--lnk-accent-border);
  border-left-color: var(--lnk-accent-border);
}

/* 双层脉冲涟漪：错峰 1.4s，像锚在「呼吸」。
   2026-10-22 材质重做时同步修正：旧实现用恒黑 dim 环，压近黑签名底几乎不可见——
   「呼吸」的意图没有兑现；改走 accent 实色，扩散渐隐，意图与观感一致。
   紫度同 ③：65% + 起始 opacity 0.45，脉冲是呼吸不是霓虹。 */
.lnk-anchor__ripple {
  position: absolute;
  inset: 0;
  border: 1px solid color-mix(in srgb, var(--lnk-accent) 65%, transparent);
  border-radius: 999px;
  pointer-events: none;
  animation: lnk-anchor-pulse 2.8s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
}

.lnk-anchor__ripple--delay {
  animation-delay: 1.4s;
}

/* 落款微时刻（2026-10-22 用户裁定「点击瞬间是品牌最可被截图的记忆点」）：
   盖章——印章压下（0.9）→ 回弹（1.05）→ 归位；同时六颗墨点四散渐隐。
   class 由点击方 600ms 自摘（见 script），reduced-motion 下整段静止。 */
.lnk-anchor--stamping {
  animation: lnk-anchor-stamp 0.5s cubic-bezier(0.2, 0.8, 0.3, 1);
}

@keyframes lnk-anchor-stamp {
  0% {
    transform: scale(1);
  }
  35% {
    transform: scale(0.9);
  }
  70% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
  }
}

.lnk-anchor__spark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 5px;
  height: 5px;
  margin: -2.5px 0 0 -2.5px;
  border-radius: 999px;
  background: var(--lnk-accent);
  opacity: 0;
  pointer-events: none;
}

.lnk-anchor--stamping .lnk-anchor__spark {
  animation: lnk-anchor-spark 0.6s ease-out forwards;
}

@keyframes lnk-anchor-spark {
  0% {
    transform: translate(0, 0) scale(1);
    opacity: 0.95;
  }
  100% {
    transform: translate(var(--sx, 0), var(--sy, 0)) scale(0.2);
    opacity: 0;
  }
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

  .lnk-ink-drop {
    animation: none;
    opacity: 0;
  }

  .lnk-anchor__ripple {
    animation: none;
    opacity: 0;
  }

  .lnk-anchor--stamping,
  .lnk-anchor--stamping .lnk-anchor__spark {
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

@keyframes lnk-anchor-pulse {
  0% {
    transform: scale(1);
    opacity: 0.45;
  }
  100% {
    transform: scale(1.85);
    opacity: 0;
  }
}
</style>
