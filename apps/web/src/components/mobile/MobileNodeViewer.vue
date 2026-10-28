<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { sameOriginApiMediaUrl } from '@/services/media-url'
import { composeAnnotatedImage } from './annotate/composeAnnotatedImage'
import { renderReviewBaseImage } from './annotate/renderReviewBaseImage'
import { useInkOverlay } from './annotate/useInkOverlay'
import { useTextToSpeech } from '@/composables/useTextToSpeech'
import { useNodeWaveform } from '@/composables/useNodeWaveform'
import { formatMediaDuration } from '@/utils/mediaInfoFormat'
import MobileNodeWaveform from './MobileNodeWaveform.vue'
import MobileAnnotationCapsule from './MobileAnnotationCapsule.vue'

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
    /**
     * 节点数据全量透传（§4.8 审核内容层：pending 时读 status / prompt /
     * imageModel / imageAspect / imageResolution 渲染提议内容层；
     * D2 修订：audio 分支读 url）。
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
   * 标注完成（规格 §4.3 L1 + §17-③ v2）：产出「**一张带标记的整图**」+ 意见。
   * ⭐ `imageBlob` 缺省 = **降级**（取不到帧 / 跨域无 CORS ⇒ 只带文字，不静默失败）。
   * §17 v2：`text` = 胶囊意见框文字（拍板③：composer 正文预填；无字 = 纯图带回）。
   */
  (e: 'annotate', payload: { imageBlob?: Blob; degraded: boolean; text?: string }): void
  /** §17-④：编辑态保存（就地改字）⇒ 壳层覆盖磁贴提示词（拍板②：回画布再确认） */
  (e: 'edit-save', prompt: string): void
  /** 右上「⋯」= 操作全集（打开与长按同一个 Menu，§4.6 同源同容器） */
  (e: 'more'): void
  /** 底部主栏动作被点击（key 透传） */
  (e: 'bottom-action', key: string): void
  /** G1（§4.7.1 入口②）：提示词摘要条单击 ⇒ 打开提示词全文审核层（独立载体） */
  (e: 'open-prompt-review'): void
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

/**
 * G1（§4.7.1 入口②，2026-10-27 S1 批次）：confirmed / error 查看器内的
 * **提示词摘要条**——一行截断，单击打开全文审核层（`MobileNodePromptReviewSheet`）。
 * pending 不渲染（其全文入口 = 审核内容层本体，⛔ 不给第二入口）。
 */
const promptStripVisible = computed(
  () => !isPendingNode.value && !showReviewLayer.value && reviewPrompt.value.length > 0,
)
const promptStripText = computed(() => {
  const p = reviewPrompt.value
  return p.length > 24 ? `${p.slice(0, 24)}…` : p
})
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
  // §17-④：编辑态下底栏 = 取消/保存（就地改字，保存回画布覆盖磁贴——拍板②）
  if (editing.value) {
    return [
      { key: 'edit-cancel', label: '取消' },
      { key: 'edit-save', label: '保存', variant: 'primary' as const },
    ]
  }
  const base = props.bottomActions ?? []
  const isText = props.type === 'text'
  const hasText = Boolean(String(nodeData.value.content ?? '').trim())
  if (isText && hasText && !isPendingNode.value) {
    return [...base, { key: 'tts', label: ttsSpeaking.value ? '停止' : '朗读' }]
  }
  return base
})

/**
 * 底部主栏动作分发（§17 v2）：`annotate` / pending 的 `edit` 在 viewer 内消化
 * （批注态 / 编辑态都沿用原 viewer，⛔ 不跳新页），其余照旧上抛壳层。
 */
function onBottomAction(key: string) {
  if (key === 'annotate') {
    editing.value = false
    if (annotating.value) exitAnnotate()
    else enterAnnotate()
    return
  }
  if (key === 'edit' && isPendingNode.value) {
    // §17-④：pending 提议 ⇒ 编辑态就地改字（改词 sheet 在提议卡场景退役）
    annotating.value = false
    capsuleVisible.value = false
    editText.value = reviewPrompt.value
    editing.value = true
    return
  }
  if (editing.value && key === 'edit-cancel') {
    editing.value = false
    return
  }
  if (editing.value && key === 'edit-save') {
    editing.value = false
    emit('edit-save', editText.value.trim())
    return
  }
  emit('bottom-action', key)
}

/* ── 标注态（L1：只有一支笔 —— 手指自由圈选；共享 useInkOverlay）──────────
 *   ⭐ 2026-10-28 W-26/W-27 真机修复：此前此处与全文层各自实现画笔且同犯
 *   「bitmap 尺寸从未设置」bug（默认 300×150 被拉伸全屏 ⇒ 手指笔画大多落在
 *   bitmap 外不可见）——现收敛到共享组合式（DPR bitmap + Pointer Events +
 *   rAF 重绘 + 中点贝塞尔平滑），修一次两处生效。marks 坐标空间不变（CSS 像素），
 *   合成图（composeAnnotatedImage）零适配。 */
const annotating = ref(false)
/** 画笔实时预览用的覆盖层 canvas */
const inkCanvas = ref<HTMLCanvasElement | null>(null)
/** §17-③：胶囊意见框可见（**首笔落定即弹**，无「完成」步骤） */
const capsuleVisible = ref(false)
const ink = useInkOverlay({
  canvas: inkCanvas,
  active: annotating,
  // 首笔落定即弹胶囊（§17-③）：落定时 marks 已含该笔
  onStrokeEnd: () => {
    capsuleVisible.value = true
  },
})
/** §17-④：编辑态（就地改字，沿用原 viewer，⛔ 不弹 sheet） */
const editing = ref(false)
const editText = ref('')

/** 进入标注态（§17-③：底栏【批注】1 步进入） */
function enterAnnotate() {
  annotating.value = true
  ink.reset()
  capsuleVisible.value = false
}

/** 退出标注态（放弃：清标记收胶囊） */
function exitAnnotate() {
  annotating.value = false
  ink.reset()
  capsuleVisible.value = false
}

/**
 * 胶囊 ⚓ ⇒ 合成「带标记的整图」+ 意见一并上抛。
 * ⭐ 视频先 `pause()` 再取当前帧；⛔ 跨域无 CORS 头 / toBlob 失败 ⇒ **诚实降级**
 *   （只带文字，不静默失败）。拍板③：意见作为 composer 正文预填（图不烧字）。
 */
async function onCapsuleAnchor(payload: { text: string }) {
  capsuleVisible.value = false
  const allMarks = ink.marks.value
  annotating.value = false
  const text = payload.text.trim()
  if (!allMarks.length) {
    emit('annotate', { degraded: true, text })
    return
  }
  try {
    const base = await captureBaseImage()
    if (!base) {
      emit('annotate', { degraded: true, text })
      return
    }
    const composed = composeAnnotatedImage(base.image, base.width, base.height, allMarks)
    const blob = await new Promise<Blob | null>((resolve) => composed.toBlob(resolve, 'image/png'))
    if (!blob) {
      emit('annotate', { degraded: true, text })
      return
    }
    emit('annotate', { imageBlob: blob, degraded: false, text })
  } catch {
    // 跨域污染 / toBlob 失败 ⇒ 诚实降级
    emit('annotate', { degraded: true, text })
  }
}

/** 取底图（图片 = 同源化后的图；视频 = 暂停后的当前帧；⭐ pending 审核层 = 整屏重绘） */
async function captureBaseImage(): Promise<{ image: CanvasImageSource; width: number; height: number } | null> {
  // §17-③（§9 #49）：审核内容层的底图 =「屏幕」⇒ 分层重绘提示词 + 参数摘要，
  // 不依赖产物（此刻本就无产物）——视频/音频提议同样成立，无 CORS / 取帧问题。
  if (showReviewLayer.value) {
    const el = reviewRef.value
    const w = Math.max(320, el?.clientWidth || 390)
    const h = Math.max(480, el?.clientHeight || 640)
    const c = renderReviewBaseImage({
      prompt: reviewPrompt.value,
      paramsLine: reviewParams.value ? `参数：${reviewParams.value}` : '',
      width: w,
      height: h,
    })
    return { image: c, width: w, height: h }
  }
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

/* ── 图片双指缩放（W-5 · 拍板 I1 隐含底线，2026-10-27 S2 批次）──────────────
 * 双指捏合 ⇒ scale 1..4；放大后单指 = 平移（不再参与关闭判定）；
 * 缩回 1 ⇒ 位移复位。⭐ 仲裁纪律：发生捏合/平移的本次触控一律**不触发关闭**
 * （gestureConsumed），与评审 C1「画笔手势不参与关闭」同型。 */
const imgScale = ref(1)
const imgTx = ref(0)
const imgTy = ref(0)
const pinchState = ref<{ initDist: number; initScale: number; initTx: number; initTy: number; initMidX: number; initMidY: number } | null>(null)
const panLast = ref<{ x: number; y: number } | null>(null)
/** 本次触控已消费（捏合/平移）⇒ touchend 不做关闭判定 */
const gestureConsumed = ref(false)
/** 缩放中的 img 元素引用（平移边界按其渲染尺寸折算） */
const imgElRef = ref<HTMLImageElement | null>(null)

const imgTransformStyle = computed(() =>
  props.type === 'image'
    ? {
        transform: `translate(${imgTx.value}px, ${imgTy.value}px) scale(${imgScale.value})`,
        willChange: 'transform' as const,
      }
    : undefined,
)

function pinchDistance(e: TouchEvent): number {
  const a = e.touches[0]!
  const b = e.touches[1]!
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function pinchMidpoint(e: TouchEvent): { x: number; y: number } {
  const a = e.touches[0]!
  const b = e.touches[1]!
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
}

/** 平移边界：放大后允许把图边缘拉进视口，但不许拖出白边（±(scale-1)·半尺寸） */
function clampPan(tx: number, ty: number): { x: number; y: number } {
  const el = imgElRef.value
  const hw = (el?.clientWidth ?? 320) / 2
  const hh = (el?.clientHeight ?? 480) / 2
  const limX = (imgScale.value - 1) * hw
  const limY = (imgScale.value - 1) * hh
  return { x: Math.max(-limX, Math.min(limX, tx)), y: Math.max(-limY, Math.min(limY, ty)) }
}

function resetImageZoom() {
  imgScale.value = 1
  imgTx.value = 0
  imgTy.value = 0
  pinchState.value = null
  panLast.value = null
}

// 节点切换（组件复用场景）⇒ 缩放态复位，不把上一张图的 zoom 带进下一张
watch(
  () => props.data?.url,
  () => resetImageZoom(),
)

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
const reviewRef = ref<HTMLElement | null>(null)

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
  // 都不得关掉查看器（否则收笔后异步合成还没 emit，节点已被清空，标注静默丢失）。
  if (annotating.value) return
  // ⭐ W-5：图片双指捏合进入缩放态——本次手势被消费，不参与关闭判定。
  if (props.type === 'image' && e.touches.length === 2) {
    const mid = pinchMidpoint(e)
    pinchState.value = {
      initDist: pinchDistance(e),
      initScale: imgScale.value,
      initTx: imgTx.value,
      initTy: imgTy.value,
      initMidX: mid.x,
      initMidY: mid.y,
    }
    gestureConsumed.value = true
    panLast.value = null
    return
  }
  // ⭐ W-5：放大态（scale>1）单指 = 平移——同样消费掉，不触发关闭。
  if (props.type === 'image' && imgScale.value > 1 && e.touches.length === 1) {
    panLast.value = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY }
    gestureConsumed.value = true
    return
  }
  gestureConsumed.value = false
  const y = e.touches?.[0]?.clientY ?? 0
  touchStartY.value = y
  touchCurrentY.value = y
  // ⭐ 滚动守卫（2026-10-27 走查③）：touchstart 时记下滚动位置，
  // 只有从顶部（scrollTop ≤ 0）开始的手势才允许累计成「下滑关闭」；
  // 阅读器滚动途中一律不触发（长文误关根因之二）。
  touchStartScrollTop.value = (readerRef.value ?? reviewRef.value)?.scrollTop ?? 0
}

/**
 * 可滚动内容是否已到底（⭐ 回归⑤：上滑关闭的判据）。
 * - 媒体查看器（图/视频/音频）无可滚动内容 ⇒ 恒 true（上滑任意位置可关）；
 * - 文本阅读器 / 审核内容层 ⇒ 仅滚到底后才 true（滚动途中上滑 = 读下文，永不关）。
 */
function scrollContentAtBottom(): boolean {
  const el = readerRef.value ?? reviewRef.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 2
}

function onTouchMove(e: TouchEvent) {
  // ⭐ W-5：双指捏合 ⇒ 缩放 + 双指中点平移；缩回 1 时位移复位。
  if (pinchState.value && e.touches.length === 2) {
    const s = pinchState.value
    const scale = Math.max(1, Math.min(4, s.initScale * (pinchDistance(e) / s.initDist)))
    imgScale.value = scale
    const mid = pinchMidpoint(e)
    if (scale > 1) {
      const p = clampPan(s.initTx + (mid.x - s.initMidX), s.initTy + (mid.y - s.initMidY))
      imgTx.value = p.x
      imgTy.value = p.y
    } else {
      imgTx.value = 0
      imgTy.value = 0
    }
    return
  }
  // ⭐ W-5：放大态单指平移。
  if (panLast.value && e.touches.length === 1 && imgScale.value > 1) {
    const p = clampPan(
      imgTx.value + (e.touches[0]!.clientX - panLast.value.x),
      imgTy.value + (e.touches[0]!.clientY - panLast.value.y),
    )
    imgTx.value = p.x
    imgTy.value = p.y
    panLast.value = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY }
    return
  }
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
  // ⭐ W-5：捏合/平移消费掉的本次触控不做关闭判定；缩回 1 时已复位。
  if (gestureConsumed.value || pinchState.value) {
    pinchState.value = null
    panLast.value = null
    gestureConsumed.value = false
    touchStartY.value = 0
    touchCurrentY.value = 0
    touchStartScrollTop.value = 0
    return
  }
  // ⭐ 评审 C1：标注态（含收笔后的异步合成期间）不触发关闭
  if (annotating.value) return
  // ⭐ 方向判据（2026-10-27 走查③修）：currentY − startY > 0 才是「下拉」。
  // 旧实现 startY − currentY > 100 = **上滑**关闭（方向写反），长文上滑滚动
  // 正中判据 ⇒ 读几行就回到画布。上滑永不关闭（iOS Photos 惯例：下滑关）。
  const deltaY = touchCurrentY.value - touchStartY.value
  if (deltaY > SWIPE_CLOSE_THRESHOLD && touchStartScrollTop.value <= 0) {
    requestClose()
  } else if (-deltaY > SWIPE_CLOSE_THRESHOLD && scrollContentAtBottom()) {
    // ⭐ 回归⑤（真机二轮）：**双向关闭**。下拉在真机被浏览器下拉刷新/边缘回弹
    // 抢手势（passive 监听无法 preventDefault），体感「基本不可用」⇒ 恢复用户
    // 习惯的上滑关闭，但加**到底守卫**：媒体查看器（无可滚动内容）上滑任意位置
    // 可关；长文/审核层仅在滚到底后上滑才关——走查③「滚动途中永不关」不回退。
    requestClose()
  }
  touchStartY.value = 0
  touchCurrentY.value = 0
  touchStartScrollTop.value = 0
}

defineExpose({ videoRef })
</script>

<template>
  <!-- ⛔ 必须 Teleport 到 body（规格 §13.2/B3）：viewer 渲染在 shell 内部时，
       祖先链上的 blur/transform 创建的 stacking context 会把 fixed 层困在局部
       context 内，被 body 层 z=--lnk-z-chrome 的顶栏盖住（viewer 按钮被挡事故）。 -->
  <Teleport to="body">
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
      ⭐ 2026-10-27 真机回归③④结构性修复：媒体区收进 `.viewer-body`（flex:1 +
      position:relative），底部主栏改**文档流**（原 absolute bottom:0 把同位钉底的
      圈选 / 倍速 / 音频控制条全部盖住——音频播/停/拖/圈选与视频倍速「不可用」的根因）。
      圈选 / 倍速的 absolute 锚点随之变为 body 底部 ⇒ 恒在主栏上方，互不遮挡。
    -->
    <div class="viewer-body">
    <!--
      标注入口（L1 · §4.3）：**显式进入**标注态（⛔ 不做隐式双击手势 ——
      单指拖动已是媒体滚动/缩放，隐式手势在移动端极易误触）。
      ⭐ §17 v2：pending 审核层的批注入口 = 底栏【批注】键（onBottomAction 内消化），
      此浮动键在审核层隐藏（无产物底图时不重复给入口；底图 = renderReviewBaseImage）。
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

    <!-- 画笔覆盖层（标注态：单指不再滚动/缩放，touch-action:none；
         Pointer Events 采集 + bitmap 尺寸/DPR 由 useInkOverlay 负责——W-26/W-27 真机修复） -->
    <canvas
      v-show="annotating"
      ref="inkCanvas"
      class="viewer-ink"
      data-testid="mobile-viewer-ink"
      @pointerdown.stop="ink.onPointerDown"
      @pointermove.stop="ink.onPointerMove"
      @pointerup.stop="ink.onPointerUp"
      @pointercancel.stop="ink.onPointerCancel"
    />

    <!-- pending 无产物 ⇒ 审核内容层（提示词全文 + 参数只读），⛔ 禁空黑媒体区。
         §17-④：编辑态就地把提示词换 textarea（原 viewer 内切换，不弹 sheet）；
         §17-③：批注态锁滚动（touch-action:none，V-17a）。 -->
    <div
      v-if="showReviewLayer"
      ref="reviewRef"
      class="viewer-review"
      :class="{ 'is-annotating': annotating }"
      data-testid="mobile-viewer-review"
    >
      <p class="viewer-review-title" data-testid="mobile-viewer-review-title">待确认 · 提议内容</p>
      <textarea
        v-if="editing"
        v-model="editText"
        class="viewer-review-edit"
        data-testid="mobile-viewer-review-edit"
      />
      <p v-else-if="reviewPrompt" class="viewer-review-prompt" data-testid="mobile-viewer-review-prompt">{{ reviewPrompt }}</p>
      <p v-if="reviewParams" class="viewer-review-params" data-testid="mobile-viewer-review-params">{{ reviewParams }}</p>
    </div>
    <img
      v-else-if="type === 'image' && data?.url"
      ref="imgElRef"
      :src="data.url"
      class="viewer-media"
      :class="{ 'is-zoomed': imgScale > 1 }"
      :style="imgTransformStyle"
      alt=""
    />
    <video
      v-else-if="type === 'video' && data?.url"
      ref="videoRef"
      :src="data.url"
      controls
      class="viewer-media"
    />
    <!-- 音频波形查看器（D2 修订 2026-10-27，走查④）：全屏波形 + 播放控制 + 可拖进度 -->
    <div v-else-if="type === 'audio'" class="viewer-audio" data-testid="mobile-viewer-audio">
      <audio
        ref="audioRef"
        :src="data?.url"
        preload="metadata"
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

    <!-- §17-③ 胶囊意见框：首笔落定即弹（in-viewer 内联浮条，可继续补画） -->
    <MobileAnnotationCapsule
      :visible="capsuleVisible"
      @anchor="onCapsuleAnchor"
      @dismiss="capsuleVisible = false"
    />

    <!-- 倍速循环（走查⑤ · W-32）：仅视频；进度条用原生 controls 不自制。
         ⭐ 回归④：原钉在容器 bottom 区被底部主栏盖住 ⇒ 收进 viewer-body（锚点=媒体区底部） -->
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
    </div><!-- /viewer-body -->

    <!-- G1（§4.7.1 入口②）：提示词摘要条 —— confirmed/error 查看器内一行回看，
         单击打开全文审核层；pending 不渲染（审核内容层本体即全文）。 -->
    <button
      v-if="promptStripVisible"
      class="viewer-prompt-strip"
      type="button"
      data-testid="mobile-viewer-prompt-strip"
      @click="emit('open-prompt-review')"
    >
      提示词：{{ promptStripText }}
    </button>

    <!--
      底部主栏（§4.11.6 可达性）：高频动作放**下方拇指区**，顶部只留低频退出类。
      ⭐ 回归③④：改**文档流**（原 absolute bottom:0 覆盖圈选/倍速/音频控制条）——
      媒体区（viewer-body）自动让出主栏高度，四者互不遮挡。
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
        @click="a.key === 'tts' ? toggleReaderSpeak() : onBottomAction(a.key)"
      >
        {{ a.label }}
      </button>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
/* G1（§4.7.1 入口②）：提示词摘要条 —— 文档流窄条（surface-base 承载 + 次级色），
   不与底部主栏互抢（回归③④教训：⛔ 不用 absolute 钉底）。 */
.viewer-prompt-strip {
  flex: none;
  display: block;
  width: 100%;
  margin: 0;
  padding: 4px var(--lnk-space-3);
  border: none;
  border-top: 0.5px solid var(--lnk-border-subtle);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.viewer-prompt-strip:active {
  color: var(--lnk-text-primary);
  background: var(--lnk-surface-overlay);
}

/* 全屏查看器（D-B）：fixed 贴视口（2026-10-20 定位契约：fixed 而非 absolute 贴 100vh） */
.mobile-node-viewer {
  position: fixed;
  inset: 0;
  z-index: var(--lnk-z-overlay);
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
  /* 下滑手势：纵向滚动交由内部媒体处理，横向不拦 */
  touch-action: pan-y;
  /* ⭐ 回归⑤：压住浏览器下拉刷新 / 边缘回弹对手势的抢占（passive 监听无法
     preventDefault，浏览器层不退让则下拉关闭真机形同虚设） */
  overscroll-behavior: none;
}

/* ⭐ 回归③④：媒体区容器——flex:1 吃掉底部主栏以外的全部空间；
   position:relative 作为圈选 / 倍速 / 画布覆盖层的定位锚点（此前锚到
   容器 bottom 区，被底部主栏整体盖住）。 */
.viewer-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* ⭐ W-5：缩放变换不得溢出媒体区（盖住底栏/顶栏） */
  overflow: hidden;
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

/* 底部主栏：高频动作恒在拇指区（§4.11.6）。
   ⭐ 回归③④：文档流（原 absolute bottom:0 z-3 覆盖同区按钮群）——
   viewer-body（flex:1）自动让出本栏高度，圈选/倍速/音频控制条不再被盖。 */
.viewer-bottom-actions {
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

/* pending 审核内容层（§4.8 修订）：提示词全文 + 参数只读摘要，可滚动 */
.viewer-review {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--lnk-space-4) var(--lnk-space-4) calc(var(--lnk-space-5) + env(safe-area-inset-bottom));
}

/* §17-③（V-17a）：批注态下审核层锁滚动 —— 单指拖动 = 画笔，位移必须为 0 */
.viewer-review.is-annotating {
  touch-action: none;
  overflow: hidden;
  user-select: none;
}

/* §17-④：编辑态就地改字（沿用原 viewer，不弹 sheet） */
.viewer-review-edit {
  width: 100%;
  min-height: 40vh;
  box-sizing: border-box;
  padding: var(--lnk-space-3);
  border: 1px solid var(--lnk-accent);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-base);
  line-height: var(--lnk-lh-base);
  resize: none;
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
