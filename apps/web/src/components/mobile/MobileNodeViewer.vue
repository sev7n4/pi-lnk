<script setup lang="ts">
import { ref } from 'vue'

/**
 * 全屏查看器（D2 · 2026-10-25 规格 §6.2 / §4.1 P3）
 *
 * ⭐ **两条退出通道**（P3「全屏层必须可退」）：
 *   ① 右上角 **X**（内联 SVG，44px 触控目标）
 *   ② **下滑关闭**（位移 > 100px）
 *   且**退出即停**——视频 `pause()`、朗读停止（后续任务扩展）。
 *
 * ⚠️ **D2 契约变更**：props `type` 收窄为 `'image' | 'video' | 'text'`，
 *   **删掉 `audio`** —— 音频永不进查看器（磁贴内联播放，§6.2 音频例外），
 *   留着就是个死分支（未来有人按契约调它必得空白屏）。
 *
 * ⚠️ **§4.11.5 图标纪律**：原左上 `‹` 是 U+2039 **文本字符**（细笔画、
 *   形态随字重不稳 ⇒ 识别失败）⇒ 改为内联 SVG（照抄 `MobileSheet.vue`
 *   的 `.m-sheet-close svg` 写法：24 网格 + `stroke-width:2` + 圆头）。
 */
defineProps<{
  type: 'image' | 'video' | 'text'
  data?: { url?: string; poster?: string; content?: string }
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** 视频元素引用（退出即停用） */
const videoRef = ref<HTMLVideoElement | null>(null)

/** 下滑手势：起始 Y 与当前 Y */
const touchStartY = ref(0)
const touchCurrentY = ref(0)

/** 下滑关闭阈值（px）—— 超过即视为"往下滑关闭" */
const SWIPE_CLOSE_THRESHOLD = 100

/** 统一退出入口：先停播放，再 emit close */
function requestClose() {
  videoRef.value?.pause()
  emit('close')
}

function onTouchStart(e: TouchEvent) {
  const y = e.touches?.[0]?.clientY ?? 0
  touchStartY.value = y
  touchCurrentY.value = y
}

function onTouchMove(e: TouchEvent) {
  touchCurrentY.value = e.touches?.[0]?.clientY ?? touchCurrentY.value
}

function onTouchEnd() {
  if (touchStartY.value - touchCurrentY.value > SWIPE_CLOSE_THRESHOLD) {
    requestClose()
  }
  touchStartY.value = 0
  touchCurrentY.value = 0
}

defineExpose({ videoRef })
</script>

<template>
  <div
    class="mobile-node-viewer"
    role="dialog"
    aria-modal="true"
    data-testid="mobile-viewer"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend="onTouchEnd"
  >
    <!-- 右上角 X（内联 SVG；⛔ 禁文本字符当图标，§4.11.5） -->
    <button
      class="viewer-close"
      type="button"
      aria-label="关闭"
      data-testid="mobile-viewer-close"
      @click="requestClose"
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
      </svg>
    </button>
    <img v-if="type === 'image' && data?.url" :src="data.url" class="viewer-media" alt="" />
    <video
      v-else-if="type === 'video'"
      ref="videoRef"
      :src="data?.url"
      controls
      class="viewer-media"
    />
    <div v-else-if="type === 'text'" class="viewer-reader">{{ data?.content }}</div>
  </div>
</template>

<style scoped>
/* 全屏查看器（D-B）：fixed 贴视口（2026-10-20 定位契约：fixed 而非 absolute 贴 100vh） */
.mobile-node-viewer {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
  /* 下滑手势：纵向滚动交由内部媒体处理，横向不拦 */
  touch-action: pan-y;
}

/* 右上角 X：44px 触控热区（图标视觉 18px，热区达标 ⇒ G-18） */
.viewer-close {
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
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.viewer-close:active {
  background: var(--lnk-pressed-overlay);
}

/* 灯箱媒体：contain 整图可见（不裁切），撑满返回条之外的剩余空间 */
.viewer-media {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
}

/* 短文阅读器：可滚动 + 底部安全区留白 */
.viewer-reader {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--lnk-space-2) var(--lnk-space-4) calc(var(--lnk-space-4) + env(safe-area-inset-bottom));
  font-size: var(--lnk-text-base);
  line-height: var(--lnk-lh-base);
  color: var(--lnk-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
