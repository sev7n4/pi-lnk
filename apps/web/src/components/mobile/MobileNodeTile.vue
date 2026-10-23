<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useLongPress } from '@/composables/useLongPress'
import {
  MOBILE_NODE_ACTION_REQUEST_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  CANVAS_MULTI_SELECT_ACTIVE_KEY,
  type MobileNodeActionRequestFn,
  type CanvasNodeClickGuard,
} from '@/composables/canvasNodeActions'
import { useTextToSpeech } from '@/composables/useTextToSpeech'
import { nodeTypeConfigs } from './nodeTypeConfigs'
import { resolveMobileNodeState } from '@/composables/mobileNodeState'
import { formatElapsed } from '@/components/canvas/nodeTaskChrome'
import NodePendingPrompt from '@/components/canvas/NodePendingPrompt.vue'
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

const mobileActionRequest = inject<MobileNodeActionRequestFn>(MOBILE_NODE_ACTION_REQUEST_KEY, () => {})
const clickGuard = inject<CanvasNodeClickGuard>(CANVAS_NODE_CLICK_GUARD_KEY, {
  shouldSuppress: () => false,
  markSuppressed: () => {},
})

const { bindings } = useLongPress(() => {
  const id = props.id
  if (id && mobileActionRequest) {
    mobileActionRequest({ id, type: props.type, data: props.data })
  }
})

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
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
  if (props.type === 'audio') {
    // R2-T2：空音频（无 url）不播一个不存在的源，改为交策略（→ 编辑 sheet）。
    // 有 url 时仍内联播放（不进 viewer/editor 路由）。
    if (!props.data?.url) {
      emit('tap')
      return
    }
    toggleAudio()
    return
  }
  if (props.type === 'text') {
    handleTextTap()
    return
  }
  if (clickGuard?.shouldSuppress?.()) return
  emit('tap')
}

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
    <img
      v-else-if="type === 'image' && data?.url"
      :src="data.url"
      class="mobile-node-media"
      alt=""
    />
    <video
      v-else-if="type === 'video' && data?.url"
      :src="data?.url"
      :poster="data?.poster"
      preload="none"
      muted
      playsinline
      class="mobile-node-media"
    />
    <div v-else-if="type === 'audio'" class="mobile-audio-wave" role="img" aria-label="音频波形占位">
      <button class="mobile-audio-play" type="button" :aria-label="playing ? '暂停' : '播放'" @click.stop="toggleAudio">▶</button>
      <audio ref="audioEl" :src="data?.url" />
    </div>
    <p v-else-if="type === 'text'" class="mobile-node-text">{{ data?.content || '空文本' }}</p>
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
    </div>

    <!--
      状态角标（R3-T2）。⚠️ pending 态让位给提议卡自带的「待确认」chip
      （R4-T1）：否则同一节点上会出现「角标：待确认 + chip：待确认」两处重复标识。
    -->
    <span v-if="badge && !showPropose" class="mobile-node-badge" :data-tone="badge.tone">{{ badge.label }}</span>

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

/* 媒体撑满磁贴：cover 裁填——绝不按原始像素渲染、绝不溢出节点框 */
.mobile-node-media {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 音频：44px 播放钮 + 波形占位条（D-D 真数据到达前的前端先行形态） */
.mobile-audio-wave {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  gap: var(--lnk-space-3);
  padding: var(--lnk-space-3);
  box-sizing: border-box;
}

.mobile-audio-wave::after {
  content: '';
  flex: 1;
  height: 36px;
  border-radius: var(--lnk-radius-full);
  background: repeating-linear-gradient(
    90deg,
    var(--lnk-border-strong) 0 2px,
    transparent 2px 7px
  );
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
.mobile-node-text {
  display: -webkit-box;
  width: 100%;
  height: 100%;
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
