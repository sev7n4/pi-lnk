<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { sameOriginApiMediaUrl } from '@/services/media-url'
import { composeAnnotatedImage, type AnnotateMark } from './annotate/composeAnnotatedImage'
import { useTextToSpeech } from '@/composables/useTextToSpeech'

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
const props = withDefaults(
  defineProps<{
    type: 'image' | 'video' | 'text'
    /**
     * 节点数据全量透传（§4.8 审核内容层：pending 时读 status / prompt /
     * imageModel / imageAspect / imageResolution 渲染提议内容层）。
     */
    data?: {
      url?: string
      poster?: string
      content?: string
      status?: string
      prompt?: string
      imageModel?: string
      imageAspect?: string
      imageResolution?: string
    }
    /**
     * 底部主栏动作（§4.11.6 可达性：高频操作放下方拇指区，顶部只放低频退出类）。
     * ⭐ 如 confirmed 态的「改词」—— ⛔ 不放右上角（那是低频区）。
     */
    bottomActions?: Array<{ key: string; label: string; variant?: 'primary' | 'danger' }>
  }>(),
  { bottomActions: () => [] },
)

const emit = defineEmits<{
  (e: 'close'): void
  /**
   * 标注完成（规格 §4.3 L1）：产出「**一张带标记的整图**」+ 意见。
   * ⭐ `imageBlob` 缺省 = **降级**（取不到帧 / 跨域无 CORS ⇒ 只带文字，不静默失败）。
   */
  (e: 'annotate', payload: { imageBlob?: Blob; degraded: boolean }): void
  /** 右上「⋯」= 操作全集（打开与长按同一个 Menu，§4.6 同源同容器） */
  (e: 'more'): void
  /** 底部主栏动作被点击（key 透传） */
  (e: 'bottom-action', key: string): void
}>()

/** 文本阅读器朗读（规格 §6.2「可朗读、可停」）：朗读状态本地维护，退出即停 */
const tts = useTextToSpeech()
const ttsSpeaking = ref(false)

/** 朗读自然结束复位：SpeechSynthesis 在 utterance 结束时派发 'end' 事件
 * （onend 在实例上、不在 SpeechSynthesis 上）。用具名 handler 以便重复朗读时
 * 不累积监听器、卸载时移除。 */
let ttsEndHandler: (() => void) | null = null

function toggleReaderSpeak() {
  if (ttsSpeaking.value) {
    tts.stop()
    ttsSpeaking.value = false
    return
  }
  const text = String((props.data as Record<string, unknown> | undefined)?.content ?? '')
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
  if (ttsEndHandler && typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.removeEventListener('end', ttsEndHandler)
  }
})

/**
 * 查看器底部主栏动作：外部注入的 bottomActions + 文本节点的「朗读 / 停止」。
 * ⭐ TTS 状态在查看器内局部维护（按钮态切换 + 退出即停），不走页面层 handler。
 * pending 节点决策层优先，故朗读按钮让位（决策层见壳层 viewerBottomActions）。
 */
const nodeData = computed(() => (props.data ?? {}) as Record<string, unknown>)
const isPendingNode = computed(() =>
  ['pending_confirm', 'pending'].includes(String(nodeData.value.status ?? '')),
)
const hasProduct = computed(() => Boolean(String(nodeData.value.url ?? '').trim()))

/**
 * pending 审核内容层（规格 §4.8 修订，2026-10-26）：
 * propose_generation 的产物要**确认后**才生成 ⇒ pending 打开查看器时无 url 可看。
 * ⛔ 此时**禁止**渲染空媒体区（历史缺陷：满屏 `--lnk-surface-canvas` 黑底 +
 * 只剩底部决策按钮，R2-T2「空白全屏」在 pending 分支复活）。
 * ✅ 改为渲染「审核内容层」：提议提示词全文 + 参数只读摘要——
 * 磁贴放不下的长提示词在这里全量可读，确认 / 拒绝因此有据可依。
 */
const showReviewLayer = computed(() => isPendingNode.value && !hasProduct.value)
const reviewPrompt = computed(() => String(nodeData.value.prompt ?? '').trim())
/** 参数只读摘要：与磁贴 proposeParams 同源（缺省模型不猜、不显示占位） */
const reviewParams = computed(() => {
  const d = nodeData.value
  const model = d.imageModel ?? d.videoModel ?? d.textModel ?? d.audioModel
  const parts: string[] = []
  if (typeof model === 'string' && model.trim()) parts.push(model.trim())
  if (typeof d.imageAspect === 'string' && d.imageAspect.trim()) parts.push(d.imageAspect.trim())
  if (typeof d.imageResolution === 'string' && d.imageResolution.trim()) parts.push(d.imageResolution.trim())
  return parts.join(' · ')
})

const resolvedBottomActions = computed(() => {
  const base = props.bottomActions ?? []
  const isText = props.type === 'text'
  const hasText = Boolean(String(nodeData.value.content ?? '').trim())
  if (isText && hasText && !isPendingNode.value) {
    return [...base, { key: 'tts', label: ttsSpeaking.value ? '停止' : '朗读' }]
  }
  return base
})

/* ── 标注态（L1：只有一支笔 —— 手指自由圈选）──────────────────────── */
const annotating = ref(false)
/** 当前手绘的标记（一条 = 一串点） */
const marks = ref<AnnotateMark[]>([])
/** 画笔实时预览用的覆盖层 canvas */
const inkCanvas = ref<HTMLCanvasElement | null>(null)
/** 手势起点 */
const inkStart = ref<{ x: number; y: number } | null>(null)
/** 当前这一笔 */
const inkPoints = ref<Array<{ x: number; y: number }>>([])

function inkPoint(e: TouchEvent): { x: number; y: number } {
  const t = e.touches?.[0] ?? e.changedTouches?.[0]
  const rect = inkCanvas.value?.getBoundingClientRect()
  return {
    x: Math.round((t?.clientX ?? 0) - (rect?.left ?? 0)),
    y: Math.round((t?.clientY ?? 0) - (rect?.top ?? 0)),
  }
}

function onInkStart(e: TouchEvent) {
  if (!annotating.value) return
  const p = inkPoint(e)
  inkStart.value = p
  inkPoints.value = [p]
  drawInk()
}

function onInkMove(e: TouchEvent) {
  if (!annotating.value || !inkStart.value) return
  inkPoints.value = [...inkPoints.value, inkPoint(e)]
  drawInk()
}

function drawInk() {
  const canvas = inkCanvas.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(255, 64, 64, 0.92)'
  const pts = inkPoints.value
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(pts[0]!.x, pts[0]!.y, 6, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 64, 64, 0.18)'
    ctx.fill()
    return
  }
  if (pts.length < 2) return
  ctx.beginPath()
  ctx.moveTo(pts[0]!.x, pts[0]!.y)
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
  ctx.stroke()
}

/** 进入标注态 */
function enterAnnotate() {
  annotating.value = true
  marks.value = []
  inkPoints.value = []
}

/** 退出标注态（放弃） */
function exitAnnotate() {
  annotating.value = false
  marks.value = []
  inkPoints.value = []
}

/**
 * 松手 ⇒ 收笔 + 合成「带标记的整图」。
 * ⭐ 视频先 `pause()` 再取当前帧；⛔ 跨域无 CORS 头 ⇒ `toBlob` 抛 SecurityError
 *   ⇒ **catch 后走 degraded 分支**（只带文字，明说降级，不静默失败）。
 */
async function onInkEnd() {
  if (!annotating.value) return
  if (inkPoints.value.length) {
    marks.value = [...marks.value, { points: inkPoints.value }]
  }
  inkPoints.value = []
  const allMarks = marks.value
  annotating.value = false
  if (!allMarks.length) {
    emit('annotate', { degraded: true })
    return
  }
  try {
    const base = await captureBaseImage()
    if (!base) {
      emit('annotate', { degraded: true })
      return
    }
    const composed = composeAnnotatedImage(base.image, base.width, base.height, allMarks)
    const blob = await new Promise<Blob | null>((resolve) => composed.toBlob(resolve, 'image/png'))
    if (!blob) {
      emit('annotate', { degraded: true })
      return
    }
    emit('annotate', { imageBlob: blob, degraded: false })
  } catch {
    // 跨域污染 / toBlob 失败 ⇒ 诚实降级
    emit('annotate', { degraded: true })
  }
}

/** 取底图（图片 = 同源化后的图；视频 = 暂停后的当前帧） */
async function captureBaseImage(): Promise<{ image: CanvasImageSource; width: number; height: number } | null> {
  const type = props.type
  if (type === 'video') {
    const video = videoRef.value
    if (!video) return null
    video.pause()
    const w = video.videoWidth || video.clientWidth
    const h = video.videoHeight || video.clientHeight
    if (!w || !h) return null
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, w, h)
    return { image: c, width: w, height: h }
  }
  // 图片：⛔ 必须**同源化**后再 drawImage（否则 canvas 被污染 ⇒ toBlob 抛错）
  const url = String((props.data as Record<string, unknown> | undefined)?.url ?? '')
  if (!url) return null
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = sameOriginApiMediaUrl(url)
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('底图加载失败'))
  })
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return null
  return { image: img, width: w, height: h }
}

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
  tts.stop()
  ttsSpeaking.value = false
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
    <!--
      右上「⋯」= 操作全集（§4.6 · §4.11.6）
      ⭐ 与画布长按**同一个 Menu 浮层**（同源同容器，避免双入口分裂）。
      ⛔ 顶部只放**低频**（退出 / 更多）—— 高频的「改词」在底部主栏。
      ⛔ 内联 SVG（禁文本字符 ⋯，§4.11.5）。
    -->
    <button
      class="viewer-more"
      type="button"
      aria-label="更多操作"
      data-testid="mobile-viewer-more"
      @click="emit('more')"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M6 12h.01M12 12h.01M18 12h.01" stroke-linecap="round" />
      </svg>
    </button>

    <!--
      标注入口（L1 · §4.3）：**显式进入**标注态（⛔ 不做隐式双击手势 ——
      单指拖动已是媒体滚动/缩放，隐式手势在移动端极易误触）。
      ⭐ 音频不进查看器 ⇒ 音频的标注入口在磁贴上（本期不做，见 §12 后续包）。
      ⭐ pending 且无产物时**不提供**（§4.8 修订：propose 确认前无产物底图，
      圈选无从谈起 ⇒ 意见走文字通道 = 底部「改词」进轻量编辑器）。
    -->
    <button
      v-if="type !== 'text' && !showReviewLayer"
      class="viewer-annotate"
      type="button"
      :aria-label="annotating ? '取消圈选' : '圈选'"
      data-testid="mobile-viewer-annotate"
      @click="annotating ? exitAnnotate() : enterAnnotate()"
    >
      {{ annotating ? '取消' : '圈选' }}
    </button>

    <!-- 画笔覆盖层（标注态：单指不再滚动/缩放，touch-action: none） -->
    <canvas
      v-show="annotating"
      ref="inkCanvas"
      class="viewer-ink"
      data-testid="mobile-viewer-ink"
      @touchstart.passive="onInkStart"
      @touchmove.passive="onInkMove"
      @touchend="onInkEnd"
      @touchcancel="onInkEnd"
    />

    <!-- pending 无产物 ⇒ 审核内容层（提示词全文 + 参数只读），⛔ 禁空黑媒体区 -->
    <div v-if="showReviewLayer" class="viewer-review" data-testid="mobile-viewer-review">
      <p class="viewer-review-title" data-testid="mobile-viewer-review-title">待确认 · 提议内容</p>
      <p v-if="reviewPrompt" class="viewer-review-prompt" data-testid="mobile-viewer-review-prompt">{{ reviewPrompt }}</p>
      <p v-if="reviewParams" class="viewer-review-params" data-testid="mobile-viewer-review-params">{{ reviewParams }}</p>
    </div>
    <img v-else-if="type === 'image' && data?.url" :src="data.url" class="viewer-media" alt="" />
    <video
      v-else-if="type === 'video' && data?.url"
      ref="videoRef"
      :src="data.url"
      controls
      class="viewer-media"
    />
    <div v-else-if="type === 'text'" class="viewer-reader">{{ data?.content }}</div>

    <!--
      底部主栏（§4.11.6 可达性）：高频动作放**下方拇指区**，顶部只留低频退出类。
      ⭐ 「改词」经此下沉（§4.6 / §4.8 修订：⛔ 不再放右上角）。
    -->
    <div v-if="resolvedBottomActions.length" class="viewer-bottom-actions">
      <button
        v-for="a in resolvedBottomActions"
        :key="a.key"
        type="button"
        class="viewer-bottom-action"
        :class="{ 'is-primary': a.variant === 'primary' }"
        :data-action="a.key"
        :data-testid="`mobile-viewer-bottom-${a.key}`"
        @click="a.key === 'tts' ? toggleReaderSpeak() : emit('bottom-action', a.key)"
      >
        {{ a.label }}
      </button>
    </div>
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

/* 右上「⋯」（44px 触控目标，§4.11.6） */
.viewer-more {
  position: absolute;
  top: calc(env(safe-area-inset-top) + var(--lnk-space-2));
  right: calc(var(--lnk-space-2) + var(--lnk-touch-target) + var(--lnk-space-1));
  z-index: 3;
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

.viewer-more:active {
  background: var(--lnk-pressed-overlay);
}

/* 底部主栏：高频动作恒在拇指区（§4.11.6） */
.viewer-bottom-actions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-3) var(--lnk-space-3)
    calc(var(--lnk-space-3) + env(safe-area-inset-bottom));
  background: var(--lnk-surface-overlay);
}

.viewer-bottom-action {
  flex: 1;
  min-height: var(--lnk-touch-target);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-medium);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.viewer-bottom-action.is-primary {
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
}

/* 标注入口按钮（44px 触控目标，§4.11.6） */
.viewer-annotate {
  position: absolute;
  right: var(--lnk-space-2);
  bottom: calc(var(--lnk-space-3) + env(safe-area-inset-bottom, 0px));
  z-index: 3;
  display: inline-flex;
  min-width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  padding: 0 var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-medium);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.viewer-annotate:active {
  background: var(--lnk-pressed-overlay);
}

/* 画笔覆盖层：标注态独占手势（touch-action: none ⇒ 单指不滚动/缩放） */
.viewer-ink {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  touch-action: none;
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

/* pending 审核内容层（§4.8 修订）：提示词全文 + 参数只读摘要，可滚动 */
.viewer-review {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--lnk-space-4) var(--lnk-space-4) calc(var(--lnk-space-5) + env(safe-area-inset-bottom));
}

.viewer-review-title {
  margin-bottom: var(--lnk-space-2);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  color: var(--lnk-text-secondary);
}

.viewer-review-prompt {
  font-size: var(--lnk-text-base);
  line-height: var(--lnk-lh-base);
  color: var(--lnk-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.viewer-review-params {
  margin-top: var(--lnk-space-3);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  color: var(--lnk-text-secondary);
}
</style>
