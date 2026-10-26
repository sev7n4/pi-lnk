<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useLongPress } from '@/composables/useLongPress'
import { resolveMobileNodeTapIntent } from '@/composables/mobileNodeOpenPolicy'
import {
  MOBILE_NODE_ACTION_REQUEST_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  CANVAS_MULTI_SELECT_ACTIVE_KEY,
  type MobileNodeActionRequestFn,
  type CanvasNodeClickGuard,
} from '@/composables/canvasNodeActions'
import { useTextToSpeech } from '@/composables/useTextToSpeech'
import { nodeTypeConfigs } from './nodeTypeConfigs'
import MobileNodeWaveform from './MobileNodeWaveform.vue'
import { useNodeWaveform } from '@/composables/useNodeWaveform'
import { resolveMobileNodeState } from '@/composables/mobileNodeState'
import { formatElapsed } from '@/components/canvas/nodeTaskChrome'
import NodePendingPrompt from '@/components/canvas/NodePendingPrompt.vue'
import { mediaInfoLine } from '@/utils/mediaInfoFormat'
import {
  resolveImageNodeDisplaySize,
  resolveVideoNodeDisplaySize,
} from '@/components/canvas/mediaNodeDisplaySize'

/** 文本节点：超过该字数的 tap 走 TTS 朗读，否则开阅读器（D-A，R1-T6） */
const TTS_THRESHOLD = 120

const props = defineProps<{
  id?: string
  type: 'image' | 'video' | 'audio' | 'text'
  data?: {
    url?: string
    poster?: string
    content?: string
    status?: string
    generationStartedAt?: string
    /** 提议的提示词（propose 建节点时写入 data.prompt）——R4-T1 起在瓦片上直接可见 */
    prompt?: string
    /** 提议的上下文标签 */
    label?: string
    /** 模型 / 比例 / 分辨率（按模态各一） */
    imageModel?: string
    videoModel?: string
    textModel?: string
    audioModel?: string
    imageAspect?: string
    imageResolution?: string
    videoSettings?: unknown
    /**
     * 媒体属性摘要（走查②，2026-10-24）：PC 三卡由 `MediaInfoSummary`
     * 渲染「尺寸/分辨率 · 比例 · 大小」（视频另有时长/格式），移动端瓦片
     * 重构后整条消失 ⇒ 在同一 `data.mediaInfo` 上补回对等的一行。
     * 字段缺失时不渲染（⛔ 不猜不占位）。
     */
    mediaInfo?: unknown
  }
  status?: string
  /**
   * R4-T4：节点是否被选中（vue-flow 的 node 对象字段，经 `NodeRenderer` 的
   * `v-bind="attrs"` 落到这里）。声明成 prop 才能拿到布尔语义——否则它只是一个
   * DOM attribute。多选勾选徽标依赖它。
   */
  selected?: boolean
}>()

const emit = defineEmits<{
  (e: 'tap'): void
  (e: 'open-reader'): void
  (e: 'retry'): void
  /**
   * D4 / H1（§4.9 选择模式）：选择模式下轻点 = **切换选中**（对标 iOS 照片多选）
   * —— 不开查看器、不弹 Menu。⛔ 只在选择模式下发；常态轻点仍走 `tap`。
   */
  (e: 'toggle-select'): void
}>()
const tts = useTextToSpeech()

const cfg = computed(() => nodeTypeConfigs[props.type])

/**
 * R3-T2：节点状态的取值来源。
 *
 * ⭐ 断链修复：此前 `NodeRenderer` 传给磁贴的 props 只有 `id / type / data`
 *   （+ `v-bind="attrs"`），**没有 status** ⇒ `statusBadge()` 恒返回 null
 *   ⇒ 状态徽标当前根本不渲染（桌面组件自己读 `data.status`，所以桌面无此问题）。
 *
 * ⚠️ 为什么不新增一个平行的 `status` prop 给桌面组件：`CanvasNodeImage` 等
 *   桌面组件的 props 里**没有** `status`（status 在 `data` 里）⇒ 传过去会
 *   fallthrough 成 DOM 属性（`status="generating"` 落到节点根 div）= DOM 污染。
 *   而 `data` 本来就整体传给磁贴 ⇒ 直接从 `data.status` 读，零额外 prop、零污染。
 *   `status` prop 保留为「显式覆盖」入口（外部可直接传）。
 */
const effectiveStatus = computed(() => props.status ?? props.data?.status)
const badge = computed(() => cfg.value.statusBadge(effectiveStatus.value))

/**
 * R3-T3：五态（判据来自纯函数 `resolveMobileNodeState`，与徽标 / 壳层状态栏
 * 消费同一答案）。瓦片按态渲染轻态：generating = 骨架 + 不确定态进度环，
 * error = 红边 + 重试入口，pending = 待确认角标。
 */
const state = computed(() =>
  resolveMobileNodeState({ type: props.type, data: props.data as Record<string, unknown> }),
)

/**
 * 生成计时（R3-T3）。
 *
 * ⭐ **不假造进度百分比**：全仓取证——节点数据里唯一百分比是 `uploadProgress`
 *   （仅上传态）；生成态只有 `generationStartedAt` + 已耗时
 *   （`AgentSideRail.vue:1125` 明写「progress / eta：现链路只有已耗时」）。
 *   ⇒ 这里只显示计时（复用桌面同款 `formatElapsed`），绝不显示假的 0%→100%。
 */
const nowMs = ref(Date.now())
let elapsedTimer: ReturnType<typeof setInterval> | null = null

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

function syncElapsedTimer() {
  stopElapsedTimer()
  if (state.value !== 'generating') return
  elapsedTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
}

watch(state, syncElapsedTimer, { immediate: true })
onBeforeUnmount(stopElapsedTimer)

const elapsedText = computed(() =>
  formatElapsed(props.data?.generationStartedAt, nowMs.value),
)

/** 重试（R3-T3）：复用桌面同一注入键 `CANVAS_NODE_RETRY_KEY`，不新建。 */
function onRetryClick(e: Event) {
  e.stopPropagation()
  e.preventDefault()
  emit('retry')
}

/**
 * R4-T1：提议内容的参数摘要（模型 · 比例 · 分辨率）。
 *
 * ⭐ 为什么移动端要有这一行：PC 靠常驻的参数面板承载这些参数
 *   （`NodePendingPrompt` 注释明说「比例 / 分辨率 / 张数等参数由 dock 的设置面板承载，
 *   不在此重复」）；**移动端没有常驻 dock**（R1 已删）⇒ 参数在移动端别处不可见 ⇒
 *   在瓦片上补一行摘要，用户不点开任何东西就知道 agent 想用什么参数生成。
 *
 * 只取**实际有值**的项（缺省模型不猜、不显示占位）。
 */
const proposeParams = computed(() => {
  const d = (props.data ?? {}) as Record<string, unknown>
  const model = d.imageModel ?? d.videoModel ?? d.textModel ?? d.audioModel
  const parts: string[] = []
  if (typeof model === 'string' && model.trim()) parts.push(model.trim())
  if (typeof d.imageAspect === 'string' && d.imageAspect.trim()) parts.push(d.imageAspect.trim())
  if (typeof d.imageResolution === 'string' && d.imageResolution.trim()) parts.push(d.imageResolution.trim())
  return parts.join(' · ')
})

/**
 * 是否有提议内容可显示。
 *
 * ⭐ 判据与 PC 的 `NodePendingPrompt` 同源（status === pending_confirm 且提示词非空），
 *   但**移动端多一条**：待确认时磁贴角标让位给提议卡自带 chip
 *   （避免「角标：待确认 + chip：待确认」两处重复标识）。
 */
const showPropose = computed(() => {
  if (state.value !== 'pending') return false
  return String(props.data?.prompt ?? '').trim().length > 0
})

/**
 * 媒体属性一行（走查②，2026-10-24）。
 *
 * PC 三卡（CanvasNodeImage/Video/Audio）都有 `MediaInfoSummary` footer：
 * 图片「1024×1024 · 1:1 · 1.2MB」/ 视频「1920×1080 · 16:9 · 8.4MB」/
 * 音频「0:12 · MP3 · 240KB」。移动端重构后整条消失，用户在原 WEB 端
 * 能看到的尺寸/分辨率/大小没了 ⇒ 在同一 `data.mediaInfo` 上补回。
 *
 * ⭐ 判据单一真源：`mediaInfoLine`（utils/mediaInfoFormat）——PC 的
 *   MediaInfoSummary 也消费它，两边永不走漂。
 * ⛔ 只显示真实有值的字段：无 mediaInfo / 字段缺失 ⇒ 空串 ⇒ 不渲染。
 */
const mediaInfoText = computed(() => {
  const info = props.data?.mediaInfo
  if (!info || typeof info !== 'object') return ''
  return mediaInfoLine(info as Parameters<typeof mediaInfoLine>[0])
})

/**
 * 空态主动作提示（走查③，2026-10-24；D1/D3 修订 2026-10-25）：
 * 新建节点不再自动弹编辑 sheet（用户裁决：创建 ≠ 编辑，auto-open 是 R2 的权宜），
 * 空瓦片自身必须把「长按编辑 / 长按撰写」这个入口写出来——否则用户拿到一个不知能干嘛的空卡。
 *
 * ⭐ D1/D3（2026-10-25 规格 §5.1 · 铁律 P1「单击 = 查看」）：
 * 单击不再进编辑器 ⇒ CTA 文案随之从「点按生成 / 点按撰写」改为「长按编辑 / 长按撰写」
 * （文案与「轻提示」共用同一串，见 `longPressLabel`）。
 */
const longPressLabel = computed(() => (props.type === 'text' ? '长按撰写' : '长按编辑'))

/** 空瓦片 CTA 文案（= 长按引导文案，与 P1「单击 = 查看」一致）。 */
const emptyCtaLabel = longPressLabel

/**
 * 磁贴外框：与桌面包络同源（图 280 / 视频 320，见 mediaNodeDisplaySize）；
 * 文本 / 音频走 NODE_SIZES 同值（280×160 / 280×140）。
 * ⭐ 为什么磁贴必须自带确定尺寸：addNode 不写 style/dimensions ⇒ vue-flow 按内容测量，
 *   而 <img>/<video> 的固有尺寸是原始像素 ⇒ 不钉死外框，每张图一个尺寸且撑破节点框。
 */
const TEXT_TILE_SIZE = { width: 280, height: 160 }
const AUDIO_TILE_SIZE = { width: 280, height: 140 }

const tileSize = computed(() => {
  const data = (props.data ?? {}) as Record<string, unknown>
  if (props.type === 'image') return resolveImageNodeDisplaySize(data)
  if (props.type === 'video') return resolveVideoNodeDisplaySize(data)
  if (props.type === 'audio') return AUDIO_TILE_SIZE
  return TEXT_TILE_SIZE
})

const tileStyle = computed(() => ({
  width: `${tileSize.value.width}px`,
  height: `${tileSize.value.height}px`,
}))

/**
 * 空图 / 空视频的类型名（占位标签）。
 * 与音频波纹、文本「空文本」并列，让空节点自解释类型。
 */
const placeholderLabel = computed(() => (props.type === 'video' ? '视频' : '图片'))

/**
 * R4-T4：多选勾选徽标。
 *
 * ⭐ 断链修复：PC 的勾选徽标是 `.neo-node-multi-badge`（`NeoBaseNode.vue:175`），
 *   其 CSS 选择器绑定 `.neo-node`（`neo-node.css:428`）⇒ **移动端磁贴（`.mobile-node-tile`）
 *   永远命中不到** ⇒ 移动端进入多选后用户看不出哪些节点被选中（只有底部计数）。
 *   判据复用 PC 同一注入键 `CANVAS_MULTI_SELECT_ACTIVE_KEY` + 节点 `selected`，
 *   但**用磁贴自有类名**（不改 PC 的 `.neo-node*` 样式 ⇒ PC 零 diff）。
 */
const multiSelectActive = inject(CANVAS_MULTI_SELECT_ACTIVE_KEY, ref(false))
const isMultiSelected = computed(() => multiSelectActive.value && props.selected === true)
/**
 * D4 / H1：选择模式是否激活（**统一取布尔**）。
 *
 * ⭐ 为什么不用模板直接判 `multiSelectActive`：注入方可能是**真 ref**（生产：
 *   CanvasPage `provide(CANVAS_MULTI_SELECT_ACTIVE_KEY, mobileMultiSelectActive)`），
 *   也可能是**普通对象 `{ value: boolean }`**（测试注入形态）⇒ 模板对真 ref 会解包、
 *   对普通对象不解包 ⇒ 直接判会得到「对象恒 truthy」的错判。走 computed 后两种
 *   形态都取 `.value` ⇒ 一致。
 */
const isSelectionMode = computed(() => multiSelectActive.value === true)

const mobileActionRequest = inject<MobileNodeActionRequestFn>(MOBILE_NODE_ACTION_REQUEST_KEY, () => {})
const clickGuard = inject<CanvasNodeClickGuard>(CANVAS_NODE_CLICK_GUARD_KEY, {
  shouldSuppress: () => false,
  markSuppressed: () => {},
})

const { bindings } = useLongPress(() => {
  const id = props.id
  // D4 / H1（§4.9）：**选择模式内的长按 = 同义切换选中**，不再弹单节点 Menu
  // （避免退回单节点管理语境，破坏 selection mode 的心智）。
  if (isSelectionMode.value) {
    emit('toggle-select')
    return
  }
  if (id && mobileActionRequest) {
    mobileActionRequest({ id, type: props.type, data: props.data })
  }
})

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref(false)

/**
 * D-D 音频波形。
 *
 * ⭐ 数据可能不落地（无 url / 跨域拿不到 / 没有 Web Audio）⇒ 组件始终拿到定长
 *   64 点数据：优先真实峰值，否则 nodeId 哈希的确定性占位（同节点永不跳变）。
 *   组件层不关心来源，由 `MobileNodeWaveform` 按 source 决定视觉强弱。
 */
const { peaks: waveformPeaks, source: waveformSource, loading: waveformLoading } = useNodeWaveform({
  nodeId: () => props.id,
  url: () => props.data?.url,
})
function toggleAudio() {
  const el = audioEl.value
  if (!el) return
  if (playing.value) {
    el.pause()
    playing.value = false
    return
  }
  playing.value = true
  try {
    const p = el.play() as Promise<void> | undefined
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    /* jsdom 无媒体实现，忽略 */
  }
}

function onTileClick() {
  /**
   * ⭐ D4 / H1（§4.9 选择模式）：**选择模式下轻点 = 切换选中**，不打开查看器、
   *   不弹 Menu（对标 iOS 照片多选：进入模式后纯靠轻点选节点）。
   *   ⭐ 多选态信号用**已有的** `CANVAS_MULTI_SELECT_ACTIVE_KEY` 注入
   *   （R4-T4 起用于多选徽标）⇒ 不新增第二个真源。
   */
  if (isSelectionMode.value) {
    emit('toggle-select')
    return
  }

  /**
   * ⭐ D1/D3（2026-10-25 规格 §5.1 · 铁律 P1「单击 = 查看」）：
   * tap 意图由纯函数 `resolveMobileNodeTapIntent` 单一判定（不各写一遍，审阅焦点 #2）。
   * - 'none'（空 / 生成中 / 失败无旧产物）⇒ 无 op + 轻提示「长按编辑 / 长按撰写」，
   *   **不开 viewer、不开 editor**（管理操作只走长按）；
   * - 'viewer'（pending / confirmed / 失败但有旧产物）⇒ 交 NodeRenderer 开查看器；
   * - 'inline'（音频）⇒ 磁贴内联播放（不进查看器 / 编辑器）。
   */
  const intent = resolveMobileNodeTapIntent({
    type: props.type,
    data: props.data as Record<string, unknown>,
  })

  if (props.type === 'audio') {
    // R2-T2：空音频（无 url）不播一个不存在的源；P1 下也不再进编辑器 ⇒ 轻提示。
    if (!props.data?.url) {
      showHint()
      return
    }
    toggleAudio()
    return
  }
  if (intent === 'none') {
    showHint()
    return
  }
  if (props.type === 'text') {
    handleTextTap()
    return
  }
  if (clickGuard?.shouldSuppress?.()) return
  emit('tap')
}

/**
 * 轻提示（P1「单击 = 查看」的落地）：无 op 时告诉用户「改走长按」，1.5s 自动消失。
 *
 * ⭐ 为什么在磁贴内而不是全局 toast：全局 toast 需 CanvasPage 承接（本任务不碰），
 *   而磁贴本身就在用户手指底下 ⇒ 就地提示最短路径、不遮挡画布。
 * ⛔ 不进任何全屏层（规格 §6.2：「无 op + 提示」= 轻 toast，不开查看器 / 编辑器）。
 */
const HINT_DURATION_MS = 1500
const hint = ref('')
let hintTimer: ReturnType<typeof setTimeout> | null = null

function showHint() {
  hint.value = longPressLabel.value
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    hint.value = ''
    hintTimer = null
  }, HINT_DURATION_MS)
}

function clearHint() {
  if (hintTimer) {
    clearTimeout(hintTimer)
    hintTimer = null
  }
  hint.value = ''
}

onBeforeUnmount(clearHint)

/** 文本范式反转（D-A）：长文朗读、短文开阅读器；主动作不再"打开节点详情" */
function handleTextTap() {
  const content = props.data?.content ?? ''
  if (content.length > TTS_THRESHOLD) {
    tts.speak(content)
  } else {
    emit('open-reader')
  }
}
</script>

<template>
  <div
    class="mobile-node-tile"
    :data-type="type"
    :data-state="state"
    :data-playing="playing ? 'true' : undefined"
    :style="tileStyle"
    @click="onTileClick"
    @touchstart="bindings.onTouchstart"
    @touchmove="bindings.onTouchmove"
    @touchend="bindings.onTouchend"
    @touchcancel="bindings.onTouchcancel"
  >
    <!--
      R3-T3 生成中轻态：骨架 + 不确定态进度环 + 计时。
      ⛔ 不显示任何百分比（全仓无生成进度字段，假造比不做更糟）。
      生成中不渲染旧媒体（用户看到的是「正在重做」而非旧图）。
    -->
    <div v-if="state === 'generating'" class="mobile-node-generating">
      <span class="mobile-node-spinner" aria-hidden="true" />
      <span class="mobile-node-generating-label">生成中</span>
      <span class="mobile-node-elapsed">{{ elapsedText }}</span>
    </div>
    <!--
      R4-T1：提议内容直接长在瓦片上（D1）。
      ⭐ 用户的设计意图：「提示词直接在节点瓦片上，省去了点击的二次动作」。
      复用 PC 的 `NodePendingPrompt`（零新判据——它内部已判 pending_confirm + 提示词非空）；
      提议的 prompt/模型/比例本就早于 propose 写进了 node.data，只是移动端一直没渲染。
      下方补一行移动端特有的参数摘要（移动端无常驻 dock）。
    -->
    <div v-else-if="showPropose" class="mobile-node-propose">
      <NodePendingPrompt
        :prompt="data?.prompt"
        :label="data?.label"
        :status="data?.status"
        hide-hint
      />
      <p v-if="proposeParams" class="mobile-node-params" data-testid="mobile-node-params">
        {{ proposeParams }}
      </p>
    </div>
    <div v-else-if="type === 'image' && data?.url" class="mobile-node-media-box">
      <img :src="data.url" class="mobile-node-media" alt="" />
      <!-- 走查②：PC MediaInfoSummary 的移动端对等物（尺寸 · 比例 · 大小） -->
      <p v-if="mediaInfoText" class="mobile-node-media-info" data-testid="mobile-node-media-info">
        {{ mediaInfoText }}
      </p>
    </div>
    <div v-else-if="type === 'video' && data?.url" class="mobile-node-media-box">
      <video
        :src="data?.url"
        :poster="data?.poster"
        preload="none"
        muted
        playsinline
        class="mobile-node-media"
      />
      <p v-if="mediaInfoText" class="mobile-node-media-info" data-testid="mobile-node-media-info">
        {{ mediaInfoText }}
      </p>
    </div>
    <div v-else-if="type === 'audio'" class="mobile-node-media-box">
      <div class="mobile-audio-wave">
        <button class="mobile-audio-play" type="button" :aria-label="playing ? '暂停' : '播放'" @click.stop="toggleAudio">▶</button>
        <MobileNodeWaveform
          :peaks="waveformPeaks"
          :source="waveformSource"
          :loading="waveformLoading"
        />
      </div>
      <audio ref="audioEl" :src="data?.url" />
      <p v-if="mediaInfoText" class="mobile-node-media-info" data-testid="mobile-node-media-info">
        {{ mediaInfoText }}
      </p>
    </div>
    <div v-else-if="type === 'text'" class="mobile-node-text-wrap">
      <p class="mobile-node-text">{{ data?.content || '空文本' }}</p>
      <!-- 走查③：空文本也要有点按入口（tap ⇒ 编辑 sheet） -->
      <span v-if="!data?.content" class="mobile-node-text-cta">{{ emptyCtaLabel }}</span>
    </div>
    <!--
      空图 / 空视频的类型占位（2026-10-23 真机走查）：
      空节点时磁贴里没有任何媒体元素 ⇒ 只剩卡面 + 描边 ⇒ 几何形状成了唯一线索，
      图片（正方形）与视频（矩形条）视觉上无法区分。补「类型图标 + 类型名」，
      与音频波纹 / 文本「空文本」形成一致的类型可辨识性。
      图标 path 复用 NeoBaseNode.vue 同款，保证与桌面节点类型图标一致。
    -->
    <div v-else class="mobile-node-placeholder" :data-type="type">
      <svg
        v-if="type === 'image'"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <rect x="2.5" y="3" width="19" height="18" rx="3" />
        <circle cx="8" cy="9" r="2" />
        <path d="M21.5 15.5l-5-5L4 21" />
      </svg>
      <svg
        v-else-if="type === 'video'"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      <span class="mobile-node-placeholder-label">{{ placeholderLabel }}</span>
      <!-- 走查③：空态主动作提示（tap 整卡 ⇒ 编辑 sheet，D-C empty 行） -->
      <span class="mobile-node-empty-cta">{{ emptyCtaLabel }}</span>
    </div>

    <!--
      轻提示（P1「单击 = 查看」）：空 / 生成中 / 失败无旧产物时 tap 的唯一反馈——
      就地告诉用户「改走长按」，1.5s 自动消失（不进任何全屏层）。
    -->
    <span v-if="hint" class="mobile-node-hint" data-testid="mobile-node-hint" role="status">
      {{ hint }}
    </span>

    <!--
      状态角标（R3-T2）。⚠️ pending 态让位给提议卡自带的「待确认」chip
      （R4-T1）：否则同一节点上会出现「角标：待确认 + chip：待确认」两处重复标识。
    -->
    <span v-if="badge && !showPropose" class="mobile-node-badge" :data-tone="badge.tone">{{ badge.label }}</span>

    <!--
      D4 / H1（§4.9 选择模式）：**全局圆圈指示器** —— 进入选择模式后画布上
      **所有**节点右上角浮现圆形指示器（未选 = 空心圈 / 已选 = 实心 + 对勾），
      这是模式的**唯一发现入口**（对标 iOS 照片多选）。
      ⭐ 与上面的「多选勾选徽标」并存：徽标只在**已选**时出现（既有 R4-T4 行为），
      指示器在**选择模式全程**出现（含未选节点）—— 两者形态不同、不冲突。
    -->
    <span
      v-if="isSelectionMode"
      class="mobile-node-select-indicator"
      :class="{ 'is-selected': isMultiSelected }"
      data-testid="mobile-node-select-indicator"
      aria-hidden="true"
    >
      <svg v-if="isMultiSelected" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4">
        <path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>

    <!-- R4-T4：多选勾选徽标（PC 的 `.neo-node-multi-badge` 选择器绑定 `.neo-node`，移动端命中不到） -->
    <span v-if="isMultiSelected" class="mobile-node-multi-badge" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4">
        <path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>

    <!--
      R3-T3 失败态重试入口（D-C error 行：红边 + 「重试」入口）。
      44px 触控目标（`--lnk-touch-target`）—— 磁贴小，命中区不能更小。
      动作走桌面同一注入键 `CANVAS_NODE_RETRY_KEY`（由 NodeRenderer 转发），
      ⛔ 不新建重试通路。
    -->
    <button
      v-if="state === 'error'"
      type="button"
      class="mobile-node-retry"
      aria-label="重试生成"
      @click="onRetryClick"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* 磁贴根元素：圆角裁切（外框尺寸由 script 区 tileStyle 内联钉死，内联优先故此处不写宽高）。
   卡面 + 发丝线对所有类型生效——媒体加载后 cover 撑满自然盖住卡面；
   空节点（无 url）也保持为一个可见的浅卡，不会是隐形框。 */
.mobile-node-tile {
  position: relative;
  overflow: hidden;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-base);
  box-sizing: border-box;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.mobile-node-tile:active {
  transform: scale(0.98);
}

/* ── R3-T3 状态轻态（D-C generating / error 两行）──────────────────────── */

/* 失败态：红边（内容照常可见，用户能看见自己那张图 + 知道失败了） */
.mobile-node-tile[data-state='error'] {
  border-color: var(--lnk-error-border);
}

/* 生成中：骨架 + 不确定态进度环 + 计时（轻量，不堆 PC 卡） */
.mobile-node-generating {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--lnk-space-2);
  box-sizing: border-box;
  color: var(--lnk-text-muted);
}

/* 不确定态进度环：匀速旋转，无百分比（⛔ 不假造进度） */
.mobile-node-spinner {
  width: 20px;
  height: 20px;
  flex: none;
  border: 2px solid var(--lnk-border-strong);
  border-top-color: var(--lnk-accent);
  border-radius: var(--lnk-radius-full);
  animation: mobile-node-spin 0.8s linear infinite;
}

@keyframes mobile-node-spin {
  to {
    transform: rotate(360deg);
  }
}

.mobile-node-generating-label {
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
}

.mobile-node-elapsed {
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 重试入口：44px 触控目标（磁贴小，命中区不能更小） */
.mobile-node-retry {
  position: absolute;
  right: var(--lnk-space-2);
  bottom: var(--lnk-space-2);
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-raised);
  color: var(--lnk-error);
  box-shadow: 0 0 0 1px var(--lnk-error-border);
}

.mobile-node-retry svg {
  width: 18px;
  height: 18px;
}

.mobile-node-retry:active {
  background: var(--lnk-surface-overlay);
}

/* 媒体盒（走查②）：媒体撑满剩余空间 + 属性行沉底——与 PC 节点卡
   「媒体 + MediaInfoSummary footer」同构，不叠加、不遮画。
   ⛔ 属性行只用主题成对令牌（surface/text-muted）：它贴在卡内而非覆在媒体上，
     随主题翻转是正确行为；覆媒体的字幕才需要固定色，这里没有。 */
.mobile-node-media-box {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  box-sizing: border-box;
}

/* 媒体撑满磁贴：cover 裁填——绝不按原始像素渲染、绝不溢出节点框 */
.mobile-node-media {
  display: block;
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: cover;
}

/* 属性行（尺寸 · 比例 · 大小）：PC MediaInfoSummary 的移动端对等物 */
.mobile-node-media-info {
  flex: none;
  margin: 0;
  padding: 2px 6px 3px;
  background: var(--lnk-surface-base);
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 轻提示（P1「单击 = 查看」）：tap 无 op 时的就地引导（1.5s 自动消失）
   —— 绝对定位浮在磁贴上方，不占布局、不遮挡长按。 */
.mobile-node-hint {
  position: absolute;
  left: 50%;
  bottom: var(--lnk-space-2);
  transform: translateX(-50%);
  max-width: calc(100% - var(--lnk-space-4));
  padding: var(--lnk-space-1) var(--lnk-space-2);
  border-radius: var(--lnk-radius-sm);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

/* 空态主动作提示（走查③）：小而清晰，accent 文本色读作「可点」 */
.mobile-node-empty-cta {
  margin-top: 2px;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-accent-text);
}

.mobile-node-text-cta {
  display: block;
  margin-top: 2px;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-accent-text);
}

/* 音频：44px 播放钮 + 波形条（D-D）。波形条自带描边令牌与「波形加载中」微标。 */
.mobile-audio-wave {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  align-items: center;
  gap: var(--lnk-space-3);
  padding: var(--lnk-space-3);
  box-sizing: border-box;
}

.mobile-audio-play {
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  flex: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-audio-play:active {
  background: var(--lnk-pressed-overlay);
}

/* 文本：3 行截断 + 省略（设计 §5.4） */
.mobile-node-text-wrap {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  box-sizing: border-box;
}

.mobile-node-text {
  display: -webkit-box;
  flex: 1;
  min-height: 0;
  width: 100%;
  margin: 0;
  padding: var(--lnk-space-3);
  overflow: hidden;
  box-sizing: border-box;
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  color: var(--lnk-text-primary);
  word-break: break-word;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

/* R4-T1：提议内容容器（提示词卡 + 参数摘要）
   —— 提议内容直接长在瓦片上，用户不点开任何东西就能读到 agent 想生成什么。 */
.mobile-node-propose {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  justify-content: center;
  gap: var(--lnk-space-2);
  box-sizing: border-box;
  overflow: hidden;
  padding: var(--lnk-space-2);
}

/* 参数摘要：模型 · 比例 · 分辨率（移动端特有——PC 靠常驻参数面板承载） */
.mobile-node-params {
  margin: 0;
  overflow: hidden;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 移动端磁贴比 PC 节点小 ⇒ 提示词正文截断更短（PC 5 行，移动端 3 行）。
   （hint 那行由 `NodePendingPrompt` 的 `hide-hint` prop 关掉，不靠 CSS 藏。） */
.mobile-node-propose :deep(.node-pending-prompt-text) {
  -webkit-line-clamp: 3;
  line-clamp: 3;
}

/* D4 / H1：选择模式圆形指示器（未选 = 空心圈 / 已选 = 实心 + 对勾）
   —— 视觉尺寸 20px（磁贴小），但它是**纯信号**不承载点击（点击走整块磁贴） */
.mobile-node-select-indicator {
  position: absolute;
  top: var(--lnk-space-2);
  right: var(--lnk-space-2);
  z-index: 2;
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-canvas);
  border: 2px solid var(--lnk-text-primary);
  color: var(--lnk-accent-on-signature);
  pointer-events: none;
}

.mobile-node-select-indicator.is-selected {
  background: var(--lnk-accent);
  border-color: var(--lnk-accent);
}

/* R4-T4：多选勾选徽标（磁贴自有类名，不复用 PC 的 `.neo-node-multi-badge`——那个绑定 `.neo-node`） */
.mobile-node-multi-badge {
  position: absolute;
  top: var(--lnk-space-2);
  right: var(--lnk-space-2);
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
  pointer-events: none;
}

.mobile-node-multi-badge svg {
  width: 12px;
  height: 12px;
}

/* 状态角标：绝对定位浮于媒体之上，不挤占内容布局 */
.mobile-node-badge {
  position: absolute;
  top: var(--lnk-space-2);
  left: var(--lnk-space-2);
  padding: 0 var(--lnk-space-1);
  border-radius: var(--lnk-radius-xs);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
}

/* 三态配色（R3-T2 补齐 busy / warn）。
   ⚠️ 用 --lnk-error / --lnk-warning / --lnk-info（深浅成对的 L2 语义色），
   **不是** --lnk-status-error——那个变量全仓未定义（既有两处引用都是错引用，
   error 徽标颜色实际不生效），本 PR 一并修正。 */
.mobile-node-badge[data-tone='error'] {
  color: var(--lnk-error);
}

.mobile-node-badge[data-tone='warn'] {
  color: var(--lnk-warning);
}

.mobile-node-badge[data-tone='busy'] {
  color: var(--lnk-info);
}

/* 空图 / 空视频的类型占位（2026-10-23 真机走查·辨识度）
   —— 空节点无媒体元素时只剩卡面 + 描边，图片（正方形）与视频（矩形条）无法区分；
   补「类型图标 + 类型名」，与音频波纹 / 文本「空文本」并列。 */
.mobile-node-placeholder {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--lnk-space-2);
  box-sizing: border-box;
  color: var(--lnk-text-muted);
}

.mobile-node-placeholder svg {
  width: 32px;
  height: 32px;
  flex: none;
}

.mobile-node-placeholder-label {
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
}
</style>
