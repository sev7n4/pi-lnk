<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useLongPress } from '@/composables/useLongPress'
import {
  MOBILE_NODE_ACTION_REQUEST_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  type MobileNodeActionRequestFn,
  type CanvasNodeClickGuard,
} from '@/composables/canvasNodeActions'
import { useTextToSpeech } from '@/composables/useTextToSpeech'
import { nodeTypeConfigs } from './nodeTypeConfigs'
import {
  resolveImageNodeDisplaySize,
  resolveVideoNodeDisplaySize,
} from '@/components/canvas/mediaNodeDisplaySize'

/** 文本节点：超过该字数的 tap 走 TTS 朗读，否则开阅读器（D-A，R1-T6） */
const TTS_THRESHOLD = 120

const props = defineProps<{
  id?: string
  type: 'image' | 'video' | 'audio' | 'text'
  data?: { url?: string; poster?: string; content?: string; status?: string }
  status?: string
}>()

const emit = defineEmits<{ (e: 'tap'): void; (e: 'open-reader'): void }>()
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
    :data-playing="playing ? 'true' : undefined"
    :style="tileStyle"
    @click="onTileClick"
    @touchstart="bindings.onTouchstart"
    @touchmove="bindings.onTouchmove"
    @touchend="bindings.onTouchend"
    @touchcancel="bindings.onTouchcancel"
  >
    <img
      v-if="type === 'image' && data?.url"
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

    <span v-if="badge" class="mobile-node-badge" :data-tone="badge.tone">{{ badge.label }}</span>
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
