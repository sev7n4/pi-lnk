<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { sameOriginApiMediaUrl } from '@/services/media-url'
import { composeAnnotatedImage, type AnnotateMark } from './annotate/composeAnnotatedImage'
import { useTextToSpeech } from '@/composables/useTextToSpeech'
import { useNodeWaveform } from '@/composables/useNodeWaveform'
import { formatMediaDuration } from '@/utils/mediaInfoFormat'
import MobileNodeWaveform from './MobileNodeWaveform.vue'

/**
 * 全屏查看器（D2 · 2026-10-25 规格 §6.2 / §4.1 P3）
 *
 * ⭐ **两条退出通道**（P3「全屏层必须可退」）：
 *   ① 右上角 **X**（内联 SVG，44px 触控目标）
 *   ② **下滑关闭**（下拉 > 100px；⭐ 2026-10-27 走查③加仲裁规则：
 *      只认下拉（上滑永不关闭——旧实现方向写反成上滑关）+
 *      滚动守卫（可滚动容器 scrollTop>0 时一律不触发））
 *   且**退出即停**——视频 `pause()`、音频 `pause()`、朗读停止。
 *
 * ⚠️ **D2 修订（2026-10-27 真机走查④）**：恢复 **audio** 分支——
 *   不是恢复死分支，而是**正经的音频波形查看器**（全屏波形 + 播放控制 +
 *   可拖进度 + 圈选标注，§4.3 音频底图 = 波形图）。原「音频永不进查看器」
 *   使 §4.3 的音频标注承诺没有全屏载体，真机实证后修订（§14 拍板 D）。
 *
 * ⚠️ **§4.11.5 图标纪律**：原左上 `‹` 是 U+2039 **文本字符**（细笔画、
 *   形态随字重不稳 ⇒ 识别失败）⇒ 改为内联 SVG（照抄 `MobileSheet.vue`
 *   的 `.m-sheet-close svg` 写法：24 网格 + `stroke-width:2` + 圆头）。
 */
const props = withDefaults(
  defineProps<{
    type: 'image' | 'video' | 'audio' | 'text'
    data?: { url?: string; poster?: string; content?: string }
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
const resolvedBottomActions = computed(() => {
  const base = props.bottomActions ?? []
  const isText = props.type === 'text'
  const isPending = ['pending_confirm', 'pending'].includes(
    String((props.data as Record<string, unknown> | undefined)?.status ?? ''),
  )
  const hasText = Boolean(String((props.data as Record<string, unknown> | undefined)?.content ?? '').trim())
  if (isText && hasText && !isPending) {
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
  if (type === 'audio') {
    // 底图 = 波形图（§4.3）：显示组件是 SVG 不可 drawImage ⇒ 用同一 peaks
    // 真源画一份 canvas。⭐ 评审 I1：**只认真实 peaks**（waveSource==='real'）——
    // 占位波形是确定性假数据（nodeId 种子），跨域无 CORS / 文件过大时把它合成进
    // 标注图 = 给 agent 一张与音频无关的假波形，违反「诚实降级，不静默失败」。
    if (waveSource.value !== 'real') return null
    const p = wavePeaks.value
    if (!p.length || !p.some((v) => v > 0)) return null
    const barW = 4
    const gap = 2
    const h = 160
    const w = Math.max(320, p.length * (barW + gap))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = 'rgba(110, 110, 110, 0.9)'
    p.forEach((peak, i) => {
      const bh = Math.max(2, peak * (h - 8))
      ctx.fillRect(i * (barW + gap), (h - bh) / 2, barW, bh)
    })
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

/* ── 音频波形查看器（D2 修订 2026-10-27，走查④）────────────────────── */
const audioRef = ref<HTMLAudioElement | null>(null)
const audioPlaying = ref(false)
const audioCurrent = ref(0)
const audioDuration = ref(0)
/** 波形真源与磁贴同一 composable（peaks 占位/真实 + 模块级 url 去重）。
 *  ⭐ 评审 I2：仅音频提供 url——图片/视频打开时不发起任何波形解码请求。 */
const { peaks: wavePeaks, source: waveSource, loading: waveLoading } = useNodeWaveform({
  nodeId: () => (props.type === 'audio' ? props.data?.url : undefined),
  url: () => (props.type === 'audio' ? props.data?.url : undefined),
})

function toggleAudioPlay() {
  const el = audioRef.value
  if (!el) return
  if (audioPlaying.value) {
    el.pause()
    return
  }
  void el.play().catch(() => {
    /* 自动播放策略拦截：用户再点一次即可，不静默失败 */
  })
}

function onAudioTime() {
  audioCurrent.value = audioRef.value?.currentTime ?? 0
}

function onAudioMeta() {
  const d = audioRef.value?.duration
  if (d != null && Number.isFinite(d)) audioDuration.value = d
}

function onAudioSeek(e: Event) {
  const el = audioRef.value
  const v = Number((e.target as HTMLInputElement).value)
  if (el && Number.isFinite(v)) el.currentTime = v
}

const audioTimeLabel = computed(
  () => `${formatMediaDuration(audioCurrent.value) ?? '0:00'} / ${formatMediaDuration(audioDuration.value) ?? '--:--'}`,
)

/* ── 视频倍速循环（走查⑤ · W-32：进度条用原生 controls，倍速按钮补齐）── */
const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const
const rateIdx = ref(0)
const videoRate = computed(() => PLAYBACK_RATES[rateIdx.value]!)
const videoRateLabel = computed(() => `${videoRate.value}x`)

function cycleVideoRate() {
  rateIdx.value = (rateIdx.value + 1) % PLAYBACK_RATES.length
  const el = videoRef.value
  if (el) el.playbackRate = videoRate.value
}

/** 可滚动内容容器（文本阅读器等）—— 滚动守卫的真源（§6.2 退出表仲裁规则） */
const readerRef = ref<HTMLElement | null>(null)

/** 下滑手势：起始 Y 与当前 Y；起始时滚动容器的 scrollTop（守卫用） */
const touchStartY = ref(0)
const touchCurrentY = ref(0)
const touchStartScrollTop = ref(0)

/** 下滑关闭阈值（px）—— 超过即视为"往下滑关闭" */
const SWIPE_CLOSE_THRESHOLD = 100

/** 统一退出入口：先停播放，再 emit close */
function requestClose() {
  videoRef.value?.pause()
  audioRef.value?.pause()
  tts.stop()
  ttsSpeaking.value = false
  emit('close')
}

function onTouchStart(e: TouchEvent) {
  // ⭐ 评审 C1：标注态画笔手势不参与关闭判定——任何 >100px 的圈选笔画
  // 都不得关掉查看器（否则 onInkEnd 的异步合成还没 emit，节点已被清空，标注静默丢失）。
  if (annotating.value) return
  const y = e.touches?.[0]?.clientY ?? 0
  touchStartY.value = y
  touchCurrentY.value = y
  // ⭐ 滚动守卫（2026-10-27 走查③）：touchstart 时记下滚动位置，
  // 只有从顶部（scrollTop ≤ 0）开始的手势才允许累计成「下滑关闭」；
  // 阅读器滚动途中一律不触发（长文误关根因之二）。
  touchStartScrollTop.value = readerRef.value?.scrollTop ?? 0
}

function onTouchMove(e: TouchEvent) {
  // ⭐ 评审 I5：多点触控（捏合/换指）时 touches[0] 身份会跳变 ⇒ 位移不可信，
  // 冻结本次手势（当前点回拨到起点），second finger 抬起后重新开始累计。
  if (e.touches.length > 1) {
    touchCurrentY.value = touchStartY.value
    return
  }
  touchCurrentY.value = e.touches?.[0]?.clientY ?? touchCurrentY.value
}

/** 系统接管手势（来电/通知）⇒ 只复位，不触发关闭（评审 M6） */
function onTouchCancel() {
  touchStartY.value = 0
  touchCurrentY.value = 0
  touchStartScrollTop.value = 0
}

function onTouchEnd() {
  // ⭐ 评审 C1：标注态（含 onInkEnd 异步合成期间）不触发关闭
  if (annotating.value) return
  // ⭐ 方向判据（2026-10-27 走查③修）：currentY − startY > 0 才是「下拉」。
  // 旧实现 startY − currentY > 100 = **上滑**关闭（方向写反），长文上滑滚动
  // 正中判据 ⇒ 读几行就回到画布。上滑永不关闭（iOS Photos 惯例：下滑关）。
  const deltaY = touchCurrentY.value - touchStartY.value
  if (deltaY > SWIPE_CLOSE_THRESHOLD && touchStartScrollTop.value <= 0) {
    requestClose()
  }
  touchStartY.value = 0
  touchCurrentY.value = 0
  touchStartScrollTop.value = 0
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
    @touchcancel="onTouchCancel"
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
    -->
    <button
      v-if="type !== 'text'"
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

    <img v-if="type === 'image' && data?.url" :src="data.url" class="viewer-media" alt="" />
    <video
      v-else-if="type === 'video'"
      ref="videoRef"
      :src="data?.url"
      controls
      class="viewer-media"
    />
    <!-- 倍速循环（走查⑤ · W-32）：仅视频；进度条用原生 controls 不自制 -->
    <button
      v-if="type === 'video'"
      class="viewer-speed"
      type="button"
      :aria-label="`倍速 ${videoRateLabel}`"
      data-testid="mobile-viewer-speed"
      @click="cycleVideoRate"
    >
      {{ videoRateLabel }}
    </button>
    <!-- 音频波形查看器（D2 修订 2026-10-27，走查④）：全屏波形 + 播放控制 + 可拖进度 -->
    <div v-else-if="type === 'audio'" class="viewer-audio" data-testid="mobile-viewer-audio">
      <audio
        ref="audioRef"
        :src="data?.url"
        @play="audioPlaying = true"
        @pause="audioPlaying = false"
        @timeupdate="onAudioTime"
        @loadedmetadata="onAudioMeta"
      />
      <div class="viewer-audio-wave">
        <MobileNodeWaveform :peaks="wavePeaks" :source="waveSource" :loading="waveLoading" />
      </div>
      <div
        class="viewer-audio-controls"
        @touchstart.stop
        @touchmove.stop
        @touchend.stop
        @touchcancel.stop
      >
        <button
          class="viewer-audio-play"
          type="button"
          :aria-label="audioPlaying ? '暂停' : '播放'"
          data-testid="mobile-viewer-audio-play"
          @click="toggleAudioPlay"
        >
          <svg v-if="!audioPlaying" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
          </svg>
        </button>
        <input
          class="viewer-audio-seek"
          type="range"
          min="0"
          :max="audioDuration || 0"
          step="0.1"
          :value="audioCurrent"
          aria-label="播放进度"
          @input="onAudioSeek"
        />
        <span class="viewer-audio-time">{{ audioTimeLabel }}</span>
      </div>
    </div>
    <div v-else-if="type === 'text'" ref="readerRef" class="viewer-reader">{{ data?.content }}</div>

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

/* 倍速循环按钮（走查⑤）：左下角，与右下「圈选」对称（44px 触控目标） */
.viewer-speed {
  position: absolute;
  left: var(--lnk-space-2);
  bottom: calc(var(--lnk-space-3) + env(safe-area-inset-bottom, 0px));
  z-index: 3;
  display: inline-flex;
  min-width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  padding: 0 var(--lnk-space-2);
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

/* 音频波形查看器（D2 修订 2026-10-27）：波形居中 + 底部控制条 */
.viewer-audio {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--lnk-space-4);
  padding: var(--lnk-space-4) var(--lnk-space-4) calc(var(--lnk-space-8) + env(safe-area-inset-bottom));
}

.viewer-audio-wave {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
}

.viewer-audio-controls {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-3);
}

.viewer-audio-play {
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  flex: none;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.viewer-audio-seek {
  flex: 1;
  min-width: 0;
  min-height: var(--lnk-touch-target);
  accent-color: var(--lnk-accent);
}

.viewer-audio-time {
  flex: none;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
