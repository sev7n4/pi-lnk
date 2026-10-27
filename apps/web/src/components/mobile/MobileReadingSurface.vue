<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useTextToSpeech } from '@/composables/useTextToSpeech'

/**
 * 共享「全屏文本阅读面」（规格 §4.8.1，2026-10-27 S1 批次）。
 *
 * 承载三形态收敛的**交互范式**：全屏可滚动文本 + X + 下滑可退（P3）+ 朗读/停 +
 * 安全区 + reduce-motion。首个消费方 = `MobileNodePromptReviewSheet`（§4.7.1 全文层）。
 *
 * ⭐ §4.8.1 数据层纪律：共享的是**壳与手势**，不是取数——⛔ 共享面内部不得摸
 * `data.content`：朗读文本经 `speechText` prop **显式注入**（§4.7.1 复用边界
 * 「TTS 文本源参数化」的落地；旧 `MobileNodeViewer.vue` 的硬编码是反面教材）。
 * 正文内容走 default slot——文本阅读器读产物、全文层读提示词，各喂各的。
 *
 * ⚠️ `MobileNodeViewer` 的 reader/review 分支迁入本组件按 §4.8.1 属「后续 PR」
 * ——本批先立共享结构 + 全文层消费，viewer 迁移随其下次改动上收（本仓惯例），
 * 已记账 gap 文档。
 *
 * 手势仲裁与 `MobileNodeViewer` 同源同判据（§6.2 退出表 + 回归⑤双向关闭）：
 * ① 顶部下拉 ≥100px 关闭（scrollTop≤0 守卫）；② 上滑仅滚到底后关闭；
 * ③ 多点触控冻结本次手势；④ 系统接管只复位；⑤ `gestureLocked` = 标注/编辑态
 * 消费方上锁（画笔手势不得触发关闭——评审 C1 同款）。
 */
const props = withDefaults(
  defineProps<{
    /** 阅读面标题行（左上，超长省略）——如「提示词 · 封面图」 */
    title?: string
    /** 朗读文本源（参数化注入；空 = 不渲染朗读按钮，§4.8.1 禁共享面自取数） */
    speechText?: string
    /** 手势上锁（标注态画笔 / 编辑态输入时不触发关闭手势，评审 C1 同款） */
    gestureLocked?: boolean
  }>(),
  { title: '', speechText: '', gestureLocked: false },
)

const emit = defineEmits<{
  (e: 'close'): void
}>()

/* ── 朗读（§6.2「可朗读、可停」）：文本源 = props.speechText，退出即停 ── */
const tts = useTextToSpeech()
const ttsSpeaking = ref(false)
let ttsEndHandler: (() => void) | null = null

const showTts = computed(() => Boolean(props.speechText.trim()))

function toggleSpeak() {
  if (ttsSpeaking.value) {
    tts.stop()
    ttsSpeaking.value = false
    return
  }
  const text = props.speechText
  if (!text.trim()) return
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  if (ttsEndHandler && synth) synth.removeEventListener('end', ttsEndHandler)
  ttsEndHandler = () => {
    ttsSpeaking.value = false
  }
  if (synth) synth.addEventListener('end', ttsEndHandler)
  ttsSpeaking.value = true
  tts.speak(text)
}

onBeforeUnmount(() => {
  tts.stop()
  if (ttsEndHandler && typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.removeEventListener('end', ttsEndHandler)
  }
})

/* ── 双向关闭手势（§6.2 退出表 + 回归⑤；与 MobileNodeViewer 同判据）────── */
const bodyRef = ref<HTMLElement | null>(null)
const touchStartY = ref(0)
const touchCurrentY = ref(0)
const touchStartScrollTop = ref(0)
const SWIPE_CLOSE_THRESHOLD = 100

function requestClose() {
  tts.stop()
  ttsSpeaking.value = false
  emit('close')
}

function onTouchStart(e: TouchEvent) {
  if (props.gestureLocked) return
  const y = e.touches?.[0]?.clientY ?? 0
  touchStartY.value = y
  touchCurrentY.value = y
  // 滚动守卫（走查③）：只有从顶部开始的手势才允许累计成「下拉关闭」
  touchStartScrollTop.value = bodyRef.value?.scrollTop ?? 0
}

function onTouchMove(e: TouchEvent) {
  if (props.gestureLocked) return
  // 多点触控（捏合/换指）位移不可信 ⇒ 冻结本次手势（评审 I5 同款）
  if (e.touches.length > 1) {
    touchCurrentY.value = touchStartY.value
    return
  }
  touchCurrentY.value = e.touches?.[0]?.clientY ?? touchCurrentY.value
}

function onTouchCancel() {
  touchStartY.value = 0
  touchCurrentY.value = 0
  touchStartScrollTop.value = 0
}

/** 可滚动内容是否已到底（回归⑤：上滑关闭的判据——滚动途中上滑 = 读下文，永不关） */
function scrollContentAtBottom(): boolean {
  const el = bodyRef.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 2
}

function onTouchEnd() {
  if (props.gestureLocked) {
    touchStartY.value = 0
    touchCurrentY.value = 0
    touchStartScrollTop.value = 0
    return
  }
  const deltaY = touchCurrentY.value - touchStartY.value
  if (deltaY > SWIPE_CLOSE_THRESHOLD && touchStartScrollTop.value <= 0) {
    requestClose()
  } else if (-deltaY > SWIPE_CLOSE_THRESHOLD && scrollContentAtBottom()) {
    requestClose()
  }
  touchStartY.value = 0
  touchCurrentY.value = 0
  touchStartScrollTop.value = 0
}
</script>

<template>
  <div
    class="mobile-reading-surface"
    role="dialog"
    aria-modal="true"
    data-testid="mobile-reading-surface"
    :class="{ 'is-locked': gestureLocked }"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchCancel"
  >
    <!-- 右上角 X（内联 SVG，44px 触控热区，§4.11.5 禁文本字符图标） -->
    <button
      class="mrs-close"
      type="button"
      aria-label="关闭"
      data-testid="mobile-reading-close"
      @click="requestClose"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
      </svg>
    </button>

    <!-- 标题行（左上，超长省略）——媒体查看器顶栏显示名称的对位（评审 M4 同语义） -->
    <p v-if="title" class="mrs-title" data-testid="mobile-reading-title">{{ title }}</p>

    <!-- 阅读主体：全屏可滚动；标注态锁滚动（touch-action:none，V-17a 同款） -->
    <div ref="bodyRef" class="mrs-body" data-testid="mobile-reading-body">
      <slot />
    </div>

    <!-- 底栏：朗读（speechText 非空时）+ 消费方动作（#actions slot）。
         高频动作放下方拇指区（§4.11.6 可达性）。 -->
    <div v-if="showTts || $slots.actions" class="mrs-bottom">
      <button
        v-if="showTts"
        class="mrs-action"
        type="button"
        data-testid="mobile-reading-tts"
        @click="toggleSpeak"
      >
        {{ ttsSpeaking ? '停止' : '朗读' }}
      </button>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
/* 全屏阅读面：fixed 贴视口（2026-10-20 定位契约）+ 安全区 + 压浏览器下拉刷新 */
.mobile-reading-surface {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
  touch-action: pan-y;
  overscroll-behavior: none;
}

/* 右上角 X：44px 触控热区（G-18 同款） */
.mrs-close {
  position: absolute;
  top: calc(env(safe-area-inset-top) + var(--lnk-space-2));
  right: var(--lnk-space-2);
  z-index: 2;
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: transparent;
  color: var(--lnk-text-primary);
  cursor: pointer;
}

.mrs-title {
  flex: none;
  margin: 0;
  padding: var(--lnk-space-2) calc(var(--lnk-space-2) + var(--lnk-touch-target)) 0 var(--lnk-space-3);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 阅读主体：flex:1 吃掉底栏以外全部空间；标注态锁滚动 */
.mrs-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--lnk-space-3);
  box-sizing: border-box;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-md);
  white-space: pre-wrap;
  word-break: break-word;
}

.mobile-reading-surface.is-locked .mrs-body {
  overflow: hidden;
  touch-action: none;
}

/* 底栏（文档流，不钉 absolute——回归③④「布局互殴」教训） */
.mrs-bottom {
  flex: none;
  display: flex;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2) var(--lnk-space-3) calc(var(--lnk-space-2) + env(safe-area-inset-bottom));
  border-top: 0.5px solid var(--lnk-border-subtle);
  background: var(--lnk-surface-base);
}

.mrs-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  cursor: pointer;
}

/* ⭐ reduce-motion：本面无过渡动画（静态面），无动画即天然尊重
   prefers-reduced-motion；若未来加过渡必须在此补 @media 分支（V-6）。 */
</style>
