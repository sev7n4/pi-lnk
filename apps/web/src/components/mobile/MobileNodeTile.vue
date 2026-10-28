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
import { nodeTypeConfigs } from './nodeTypeConfigs'
import MobileNodeWaveform from './MobileNodeWaveform.vue'
import { useNodeWaveform } from '@/composables/useNodeWaveform'
import { resolveMobileNodeState } from '@/composables/mobileNodeState'
import { formatElapsed } from '@/components/canvas/nodeTaskChrome'
import NodePendingPrompt from '@/components/canvas/NodePendingPrompt.vue'
import { mediaInfoLine } from '@/utils/mediaInfoFormat'
import { getNeoNodeMeta } from '@/components/canvas/neoNodeMeta'
import { useNodeMediaInfoFooter } from '@/composables/useNodeMediaInfoFooter'
import type { NodeMediaInfoSummary } from '@/composables/useMediaInspector'
import {
  resolveImageNodeDisplaySize,
  resolveVideoNodeDisplaySize,
} from '@/components/canvas/mediaNodeDisplaySize'

/**
 * 文本节点 tap 行为见 `handleTextTap`：统一打开阅读器（规格 §6.2），
 * 朗读不作为单击默认动作 —— 阅读器内置「朗读 / 停止」（§6.2「可朗读、可停」，
 * 退出即停）。早先「长文直接 TTS」属于实现偏离书面规格，已移除。
 */

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
  /**
   * G1（§4.7 / §4.7.1，2026-10-27 S1 批次）：提示词 chips 单击 ⇒ 打开
   * **提示词全文审核层**（`MobileNodePromptReviewSheet`，独立于媒体查看器）。
   * ⛔ 不复用 `tap`（那会开查看器/编辑器）—— 全文层是独立契约位。
   */
  (e: 'open-prompt-review'): void
}>()
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
 * 有产物判据（G1，§4.7 表「有旧产物」列的单一真源）：媒体看 url、文本看 content。
 * generating 淡化与提示词 chips 共用，不各写一遍。
 */
const hasProduct = computed(() =>
  props.type === 'text'
    ? Boolean(String(props.data?.content ?? '').trim())
    : Boolean(String(props.data?.url ?? '').trim()),
)

/**
 * G1（§4.7 表第 3 行，2026-10-27）：**改词 / 反馈重生成**（generating 且有旧产物）
 * ⇒ 旧产物**淡化保留** + 「重新生成中」角标 + 提示词 chips —— 保留视觉锚点不闪空
 * （旧实现直接短路掉所有媒体分支 = 规格明文要避免的「闪空」）。首生成（无旧产物）
 * 仍走骨架轻态。
 */
const isRegenerating = computed(() => state.value === 'generating' && hasProduct.value)

/**
 * G1（§4.7 原则行）：有产物态（confirmed / error / 改词重生成）提示词降级为
 * **一行可点 chips**，单击打开全文层（§4.7.1）。
 *
 * ⭐ Ruling（2026-10-27）：**pending 不渲染 chips** —— pending 的全文入口已由
 * §16-④ 拍板（磁贴「点按查看全文」引导 → 查看器审核内容层，M5 批注/编辑语义），
 * chips 会制造第二条全文入口与「单一确认面」纪律打架；empty 无产物无 chips。
 */
const showPromptChip = computed(() => {
  if (!String(props.data?.prompt ?? '').trim()) return false
  if (!hasProduct.value) return false
  return state.value === 'confirmed' || state.value === 'error' || isRegenerating.value
})

/**
 * 「查看全文」引导（§16-④，2026-10-27 真机走查裁决）。
 *
 * 现状 = **点磁贴任意处进查看器**（resolveMobileNodeTapIntent pending 恒 viewer），
 * 但正文 5 行截断（NodePendingPrompt）⇒ 长提示词用户不知道能点开看全量。
 * 被动引导行（非按钮）：磁贴 tap 手势归页面级 resolveMobileNodeTapIntent 单一出处
 * （CanvasPage.gestureWiring.test.ts），磁贴内再挂按钮会分叉手势出处。
 *
 * 阈值：正文 5 行 ≈ 100+ 字可见（CJK≈1.14em），> 80 字大概率已截断。
 */
const PROMPT_HINT_THRESHOLD = 80
const showProposeViewHint = computed(() => {
  if (!showPropose.value) return false
  return String(props.data?.prompt ?? '').length > PROMPT_HINT_THRESHOLD
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

/* ── 走查①②（2026-10-27 规格 §6.2「磁贴属性行构成」；2026-10-28 四轮走查修订）──────
 * ① 全生命周期显示：头部从各内容分支抽出，根级恒渲染（空态/生成中/pending 也显示）。
 * ② 类型用图标示意（PC `neo-node-icon` 同款 SVG path），不再用「类型 ·」文字前缀。
 * ③ 头部/底部三要素外置：对齐 PC `neo-node-external-title/footer` 模式
 *    （absolute 浮于磁贴框外上下，不占节点内容空间 ⇒ 节点空间最大化）。
 */
/** PC `neo-node-icon` 同款类型图标（neoNodeMeta.icon 单一真源） */
const tileIcon = computed(() => getNeoNodeMeta(props.type).icon)

/**
 * 头部名字：名称兜底链与 PC `resolveNeoNodeTitle` 同源（label ?? title，都没有则类型名）。
 * ⭐ 2026-10-28 ②：类型语义由图标承载，文字只放名字（无自定义名时兜底显示类型名，
 * 与 PC resolveNeoNodeTitle 行为一致）。
 */
const tileHeaderText = computed(() => {
  const d = props.data as Record<string, unknown> | undefined
  const custom = [d?.label, d?.title].find((v) => typeof v === 'string' && v.trim()) as string | undefined
  const name = custom?.trim()
  return name || getNeoNodeMeta(props.type).label
})

/**
 * 媒体三类底部属性行（三轮走查修订：名称归头部，底部只放**媒体要素**）：
 * 图片 尺寸·比例·大小 / 视频 分辨率·比例·大小 / 音频 时长·格式·大小——
 * 判据单一真源 `mediaInfoLine`（PC MediaInfoSummary 同源），缺段不猜。
 * ⭐ 四轮走查③外置后补产物门控：属性行描述的是**产物**的媒体事实，
 *   空节点（无 url）即便脏数据带 mediaInfo 也不渲染（外置行脱离了
 *   原「有 url 才进媒体分支」的隐式门控，须显式补回）。
 */
const attributeLine = computed(() => {
  if (!hasProduct.value) return ''
  return mediaInfoText.value
})

/** 文本节点底部属性行：字数（名称归头部；空文本不渲染） */
const textAttrLine = computed(() => {
  const content = props.data?.content ?? ''
  if (!content) return ''
  return `${content.length} 字`
})

/**
 * 移动端 mediaInfo ensure（走查②根因修复）：复用 PC 同一 composable
 * （probe 单一真源 + 模块级 url 去重），有 patch 通道才生效（磁贴在
 * CanvasPage 树内 ⇒ CANVAS_NODE_PATCH_KEY 可注入；独立挂载（测试）安全 no-op）。
 */
const { applyDurationSec } = useNodeMediaInfoFooter({
  nodeId: props.id ?? '',
  url: () => props.data?.url,
  // text 无 url，ensureProbe 对空 url 直接短路；类型收窄仅为满足签名
  kind: () => props.type as 'image' | 'video' | 'audio',
  mediaInfo: () => props.data?.mediaInfo as NodeMediaInfoSummary | undefined,
})

/** 音频元数据就绪 ⇒ 时长落 mediaInfo（PC CanvasNodeAudio 同款路径） */
function onAudioMeta(e: Event) {
  const d = (e.target as HTMLAudioElement).duration
  if (Number.isFinite(d)) applyDurationSec(d)
}

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
const placeholderLabel = computed(() => getNeoNodeMeta(props.type).label)

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

/** 视频瓦片：无海报时主动取首帧（preload=metadata 已解码首帧），避免纯白框 */
const videoTileRef = ref<HTMLVideoElement | null>(null)
function onVideoMeta() {
  if (!props.data?.poster && videoTileRef.value) {
    try {
      // 跳到首帧附近强制绘制一帧（部分浏览器 metadata 阶段允许 seek）
      videoTileRef.value.currentTime = 0.1
    } catch {
      /* 个别浏览器在 metadata 阶段不允许 seek，忽略即可 */
    }
  }
}

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
   * - 'viewer'（pending / confirmed / 失败但有旧产物）⇒ 交 NodeRenderer 开查看器。
   * ⚠️ 2026-10-27（D2 修订，走查④）：音频不再特殊分流——有产物 tap = 波形查看器；
   *   磁贴内联播放保留（走播放按钮 `@click.stop="toggleAudio"`，非 tap）。
   */
  const intent = resolveMobileNodeTapIntent({
    type: props.type,
    data: props.data as Record<string, unknown>,
  })

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

/**
 * 文本节点 tap → 打开阅读器（规格 §6.2：≤120 字磁贴直显；>120 字全屏阅读器）。
 * 朗读不作为单击默认动作——阅读器内置「朗读 / 停止」按钮（§6.2「可朗读、可停」，
 * 退出即停），用户想听再点。早先「长文直接 TTS」与书面规格冲突，已移除。
 */
function handleTextTap() {
  emit('open-reader')
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
      四轮走查①②③（2026-10-28）：头部外置恒渲染——全生命周期（空/生成中/pending/有产物）
      都显示；类型用图标（PC neo-node-icon 同款），文字只放名字；absolute 浮于框外上方
      （PC neo-node-external-title 同模式），不占节点内容空间。
    -->
    <header class="mobile-node-tile-header" data-testid="mobile-node-tile-header">
      <svg
        v-if="tileIcon === 'image'"
        class="mobile-node-tile-header-icon"
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
        v-else-if="tileIcon === 'video'"
        class="mobile-node-tile-header-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      <svg
        v-else-if="tileIcon === 'audio'"
        class="mobile-node-tile-header-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
      <svg
        v-else
        class="mobile-node-tile-header-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="mobile-node-tile-header-name">{{ tileHeaderText }}</span>
    </header>

    <!--
      卡面（四轮走查③）：圆角/边框/裁切收进内层——根容器不再有卡面样式，
      头部与底部属性行浮于框外，节点内容空间最大化（PC neo-node 同构）。
    -->
    <div class="mobile-node-tile-card">
    <!--
      R3-T3 生成中轻态：骨架 + 不确定态进度环 + 计时。
      ⛔ 不显示任何百分比（全仓无生成进度字段，假造比不做更糟）。
      ⭐ G1（§4.7 表第 3 行，2026-10-27）：仅**首生成**（无旧产物）走骨架；
      改词/反馈重生成有旧产物 ⇒ isRegenerating（旧产物淡化 + 「重新生成中」角标
      + chips），落到下方媒体/文本分支渲染——不再「生成中不渲染旧媒体」闪空。
    -->
    <div v-if="state === 'generating' && !isRegenerating" class="mobile-node-generating">
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
      <!-- §16-④：长提示词的查看引导（被动行——tap 手势归页面级单一出处，磁贴内不挂按钮） -->
      <p
        v-if="showProposeViewHint"
        class="mobile-node-propose-hint"
        data-testid="mobile-node-propose-hint"
      >
        点按查看全文
      </p>
    </div>
    <div v-else-if="type === 'image' && data?.url" class="mobile-node-media-box">
      <img :src="data.url" class="mobile-node-media" alt="" />
    </div>
    <div v-else-if="type === 'video' && data?.url" class="mobile-node-media-box">
      <video
        ref="videoTileRef"
        :src="data?.url"
        :poster="data?.poster"
        preload="metadata"
        muted
        playsinline
        class="mobile-node-media"
        @loadedmetadata="onVideoMeta"
      />
      <!-- 播放态提示：无海报时也让用户识别"这是个可播放视频"，而非白框；
           pointer-events:none 不抢 tap（tap 仍由磁贴开查看器） -->
      <span class="mobile-node-video-play" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="8 5 19 12 8 19 8 5" fill="currentColor" stroke="none" />
        </svg>
      </span>
    </div>
    <!--
      ⭐ 2026-10-27 真机回归②修复：音频分支加 `data?.url` 门控（图片/视频同款）——
      此前空音频也渲染占位波形 + 播放键，用户无法区分「有产物 / 无产物」。
      空音频落到下方类型占位分支（音频图标 + 类型名），与空图 / 空视频同型。
    -->
    <div v-else-if="type === 'audio' && data?.url" class="mobile-node-media-box">
      <div class="mobile-audio-wave">
        <button class="mobile-audio-play" type="button" :aria-label="playing ? '暂停' : '播放'" @click.stop="toggleAudio">▶</button>
        <MobileNodeWaveform
          :peaks="waveformPeaks"
          :source="waveformSource"
          :loading="waveformLoading"
        />
      </div>
      <audio ref="audioEl" :src="data?.url" preload="metadata" @loadedmetadata="onAudioMeta" />
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
      <!-- 音频图标：path 复用 NeoBaseNode.vue 同款（回归②，空音频与空图/空视频同型） -->
      <svg
        v-else-if="type === 'audio'"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
      <span class="mobile-node-placeholder-label">{{ placeholderLabel }}</span>
      <!-- 走查③：空态主动作提示（tap 整卡 ⇒ 编辑 sheet，D-C empty 行） -->
      <span class="mobile-node-empty-cta">{{ emptyCtaLabel }}</span>
    </div>
    </div><!-- /.mobile-node-tile-card -->

    <!--
      四轮走查③④（2026-10-28）：底部三要素外置（PC neo-node-external-footer 同模式，
      absolute 浮于框外下方）——图片 尺寸·比例·大小 / 视频 分辨率·比例·大小 /
      音频 时长·格式·大小 / 文本 字数；判据单一真源 mediaInfoLine，缺段不猜。
      右侧 = G1 提示词 chips（④：挪出卡面，单击打开全文审核层 §4.7.1——
      来源：创建节点时 propose 写入的 data.prompt，有产物态可回看）。
    -->
    <footer
      v-if="attributeLine || textAttrLine || showPromptChip"
      class="mobile-node-tile-footer"
      data-testid="mobile-node-tile-footer"
    >
      <span v-if="attributeLine" class="mobile-node-media-info" data-testid="mobile-node-media-info">{{ attributeLine }}</span>
      <span v-if="textAttrLine" class="mobile-node-media-info" data-testid="mobile-node-text-info">{{ textAttrLine }}</span>
      <button
        v-if="showPromptChip"
        class="mobile-node-prompt-chip"
        type="button"
        data-testid="mobile-node-prompt-chip"
        @click.stop="emit('open-prompt-review')"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 5h16M4 5v14M20 5v14M4 19h16" stroke-linecap="round" />
        </svg>
        提示词
      </button>
    </footer>

    <!--
      轻提示（P1「单击 = 查看」）：空 / 生成中 / 失败无旧产物时 tap 的唯一反馈——
      就地告诉用户「改走长按」，1.5s 自动消失（不进任何全屏层）。
    -->
    <span v-if="hint" class="mobile-node-hint" data-testid="mobile-node-hint" role="status">
      {{ hint }}
    </span>

    <!--
      G1：「重新生成中」角标（改词重生成有旧产物时叠加在产物上方，保留视觉锚点）。
      ⭐ 独立 v-if 放在主渲染链**之后**——插进 v-if/v-else-if 链中间会断链
      （后续 v-else-if 会挂到本节点上，媒体分支被吞——本轮实测教训）。
    -->
    <span
      v-if="isRegenerating"
      class="mobile-node-regen-badge"
      data-testid="mobile-node-regen-badge"
    >
      <span class="mobile-node-spinner mobile-node-spinner--sm" aria-hidden="true" />
      重新生成中{{ elapsedText ? ` · ${elapsedText}` : '' }}
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
/* 磁贴根元素（四轮走查③ 2026-10-28）：透明定位容器——卡面（圆角/边框/裁切）
   收进内层 .mobile-node-tile-card，头部/底部属性行 absolute 浮于框外上下
   （PC neo-node-external-title/footer 同模式）⇒ 节点内容空间最大化。
   外框尺寸仍由 script 区 tileStyle 内联钉死（内联优先故此处不写宽高）。 */
.mobile-node-tile {
  position: relative;
  box-sizing: border-box;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.mobile-node-tile:active {
  transform: scale(0.98);
}

/* 卡面：圆角裁切 + 发丝线（原根元素样式下沉）。媒体 cover 撑满自然盖住卡面；
   空节点（无 url）也保持为一个可见的浅卡，不会是隐形框。 */
.mobile-node-tile-card {
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-base);
  box-sizing: border-box;
}

/* ── R3-T3 状态轻态（D-C generating / error 两行）──────────────────────── */

/* 失败态：红边（内容照常可见，用户能看见自己那张图 + 知道失败了）。
   ⭐ 边框在卡面层（四轮走查③ 卡面下沉后选择器随迁） */
.mobile-node-tile[data-state='error'] .mobile-node-tile-card {
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

/* 视频瓦片播放提示：浮于媒体之上同心圆，pointer-events:none 不抢 tap */
.mobile-node-video-play {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: inline-flex;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  border-radius: var(--lnk-radius-full);
  background: rgba(0, 0, 0, 0.42);
  color: #fff;
  pointer-events: none;
}

/* 属性行（尺寸 · 比例 · 大小）：PC MediaInfoSummary 的移动端对等物。
   四轮走查③：已外置到框外 footer——画布底色上直接排版（透明背景），
   ⛔ 不再带 surface-base 承载条（那是卡内时代贴卡的样式）。 */
.mobile-node-media-info {
  flex: none;
  margin: 0;
  padding: 0;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 四轮走查①②③：外置头部——类型图标 + 名字，浮于磁贴框外上方（-24px）。
   全生命周期恒渲染（空/生成中/pending/有产物）；颜色次级、不与卡面抢视觉。 */
.mobile-node-tile-header {
  position: absolute;
  top: -24px;
  left: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 20px;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.mobile-node-tile-header-icon {
  width: 13px;
  height: 13px;
  flex: none;
}

.mobile-node-tile-header-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 四轮走查③④：外置底部属性行——三要素居左 + 提示词 chips 居右，
   浮于磁贴框外下方（-22px），不占节点内容空间。 */
.mobile-node-tile-footer {
  position: absolute;
  bottom: -22px;
  left: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  min-height: 18px;
  pointer-events: none;
}

.mobile-node-tile-footer .mobile-node-media-info {
  flex: 1;
  min-width: 0;
}

/* ── G1（§4.7 / §4.7.1，2026-10-27 S1 批次；2026-10-28 ④ 外置到 footer 右侧）── */

/* 提示词 chips：有产物态的一行可点回看入口。外置 footer 上透明排版，
   accent 只做点睛（墨流纪律：品牌色不铺面）。
   ⛔ 令牌纪律：只用 L2 成对令牌，不引 hex / 不用 accent-text（签名面专用）。 */
.mobile-node-prompt-chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  margin: 0;
  margin-left: auto;
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
}

.mobile-node-prompt-chip:active {
  color: var(--lnk-text-primary);
}

/* 「重新生成中」角标：叠加在旧产物上方（右上），保留视觉锚点不闪空（§4.7 表第 3 行） */
.mobile-node-regen-badge {
  position: absolute;
  top: var(--lnk-space-2);
  right: var(--lnk-space-2);
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  box-shadow: 0 0 0 1px var(--lnk-border-subtle);
  pointer-events: none;
}

.mobile-node-spinner--sm {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}

/* 旧产物淡化（§4.7「旧产物淡化保留」）：首生成无媒体渲染，本组规则自然不命中 */
.mobile-node-tile[data-state='generating'] .mobile-node-media,
.mobile-node-tile[data-state='generating'] .mobile-audio-wave,
.mobile-node-tile[data-state='generating'] .mobile-node-text {
  opacity: 0.4;
  filter: grayscale(0.5);
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

/* 「查看全文」引导行（§16-④）：被动提示，tap 仍由页面级手势统一处理 */
.mobile-node-propose-hint {
  margin: 0;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
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
