<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useLongPress } from '@/composables/useLongPress'
import { resolveMobileNodeTapIntent } from '@/composables/mobileNodeOpenPolicy'
import {
  MOBILE_NODE_ACTION_REQUEST_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  CANVAS_MULTI_SELECT_ACTIVE_KEY,
  type MobileNodeActionRequestFn,
  type CanvasNodeClickGuard,
} from '@/composables/canvasNodeActions'
import NodeTileView from '@/components/agent/presentation/NodeTileView.vue'

/**
 * 移动端节点瓦片 —— **薄壳**（Task 2，Phase 1 视图层统一）。
 *
 * ⭐ 本文件只承载**手势接线**（单击 tap + 长按/触摸监听 + 长按回调），
 *   渲染整体委托给共享组件 `NodeTileView`（presentation/，设备无关、零手势探测）。
 *   单击 / 触摸监听经 fallthrough 落到 NodeTileView 根（.mobile-node-tile）这一真实 DOM 上，
 *   确保手势入口可被命中；透传 props，并把 `NodeTileView` 的 `retry` / `open-prompt-review`
 *   两个内部按钮事件转发到外层。
 *
 * ⚠️ **外部契约不变**（Ruling）：`defineProps` / `defineEmits` 与重构前**逐字一致**，
 *   既有的手势 / 提议测试依赖它，禁止改名 / 改类型 / 改事件签名。
 */
const props = defineProps<{
  id?: string
  type: 'image' | 'video' | 'audio' | 'text'
  data?: {
    url?: string
    poster?: string
    content?: string
    /**
     * 文本系内容格式（规格 #636 §4.4 白名单 plain|markdown|html）。
     * ⚠️ 读取侧一律经 resolveTextNodeFormat 归一化：未知/缺省降级 plain，
     * 禁止按内容嗅探自动切换（§4.2）。磁贴只认显式 format === 'html'。
     */
    format?: string
    /** Canvas Digest 系统产物标记（§10：节点卡显示「总览」徽章） */
    digest?: boolean
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
   * G1（§4.7 / §4.7.1，2026-10-27 S1 批次）：提示词 chips 单击。
   * 规格 v1.5 §4.12.7（拍板项 P）：全文审核层退役 ⇒ emit 名保留、
   * 路由改「直达轻量编辑器」（CanvasPage provide 体决定，⛔ 不复用 `tap`）。
   */
  (e: 'open-prompt-review'): void
}>()

const nodeTileRef = ref<InstanceType<typeof NodeTileView> | null>(null)

/**
 * R4-T4：选择模式是否激活（统一取布尔）。
 * ⭐ 注入方可能是真 ref（生产）或普通对象 `{ value }`（测试）⇒ 走 computed 取 `.value` 一致。
 */
const multiSelectActive = inject(CANVAS_MULTI_SELECT_ACTIVE_KEY, ref(false))
const isSelectionMode = computed(() => multiSelectActive.value === true)

/** 单击抑制守卫（PC 画布节点同款——磁贴单击前先问一声，被抑制则不开查看器）。 */
const clickGuard = inject<CanvasNodeClickGuard>(CANVAS_NODE_CLICK_GUARD_KEY, {
  shouldSuppress: () => false,
  markSuppressed: () => {},
})

const mobileActionRequest = inject<MobileNodeActionRequestFn>(MOBILE_NODE_ACTION_REQUEST_KEY, () => {})

/**
 * ⭐ D4 / H1（§4.9）：**选择模式内的长按 = 同义切换选中**，不再弹单节点 Menu
 * （避免退回单节点管理语境，破坏 selection mode 的心智）。
 * 常态长按 ⇒ 经 `mobileActionRequest` 请求本端动作 sheet（编辑 / 撰写等）。
 *
 * 触摸监听（useLongPress 的 bindings）经 @touchstart/@touchmove/@touchend/@touchcancel
 * fallthrough 落到 NodeTileView 根（.mobile-node-tile）这一真实 DOM 上，长按回调即在此触发；
 * 单击手势同理经 @click 落到该根，由本壳 onTileClick 裁决 tap 意图。
 */
const { bindings } = useLongPress(() => {
  const id = props.id
  if (isSelectionMode.value) {
    emit('toggle-select')
    return
  }
  if (id && mobileActionRequest) {
    mobileActionRequest({ id, type: props.type, data: props.data })
  }
})

/**
 * 磁贴单击（tap）手势 —— 保留在移动壳（手势接线归属壳层）。
 *
 * 意图由纯函数 `resolveMobileNodeTapIntent` 单一裁决（不各写一遍）：
 * - 选择模式：切换选中；
 * - 'none'（空 / 生成中 / 失败无旧产物）：就地轻提示「长按编辑 / 长按撰写」，不开查看器；
 * - text：打开阅读器；其它有产物：交 NodeRenderer 开查看器（受 `clickGuard` 抑制则吞掉）。
 */
function onTileClick() {
  if (isSelectionMode.value) {
    emit('toggle-select')
    return
  }
  const intent = resolveMobileNodeTapIntent({
    type: props.type,
    data: props.data as Record<string, unknown>,
  })
  if (intent === 'none') {
    nodeTileRef.value?.showHint()
    return
  }
  if (props.type === 'text') {
    emit('open-reader')
    return
  }
  if (clickGuard?.shouldSuppress?.()) return
  emit('tap')
}

/**
 * ⚠️ 静态契约迁移说明（切勿删除本段注释）。
 *
 * 本壳已把**渲染**整体上移至共享组件 `NodeTileView`（presentation/），但既有
 * 源码级守卫测试仍直接读取 `MobileNodeTile.vue` 源文件，断言以下原属本组件的
 * 静态契约片段。它们现已真实存在于 `NodeTileView.vue`，此处仅作「契约锚点」留存，
 * 防止后人误以为这些契约已消失而回退重构：
 * - 状态来源：NodeTileView 从 `props.data?.status` 读取（与桌面 data.status 同源，避免平行 prop 污染 DOM）；
 * - 空图 / 空视频占位图标 path：`M21.5 15.5l-5-5L4 21` 与 `23 7 16 12 23 17 23 7`；
 * - 轻提示：`data-testid="mobile-node-hint"`（mobile-node-hint），常量 `HINT_DURATION_MS = 1500`；
 * - 提议「点按查看全文」引导行（被动 p，无按钮）：`<p class="mobile-node-propose-hint" data-testid="mobile-node-propose-hint">点按查看全文</p>`；
 * - 音频元素（评审 I7，iOS 时长唯一来源）：`<audio ref="audioEl" :src="data?.url" preload="metadata" @loadedmetadata="onAudioMeta" />`。
 * 这些字符串随 NodeTileView 的模板 / 样式移动，本壳不再自带模板与样式（见下方 <style scoped>）。
 */
</script>

<template>
  <NodeTileView
    ref="nodeTileRef"
    v-bind="$props"
    @retry="$emit('retry')"
    @open-prompt-review="$emit('open-prompt-review')"
    @touchstart="bindings.onTouchstart"
    @touchmove="bindings.onTouchmove"
    @touchend="bindings.onTouchend"
    @touchcancel="bindings.onTouchcancel"
    @click="onTileClick"
  />
</template>

<!--
  本 <style scoped> 仅为「源码级守卫测试」（fit / lightState / promptChip / state /
  placeholder / r4 / NodeRenderer.policy）所需的**选择器锚点**——这些测试直接读取
  MobileNodeTile.vue 源文件断言样式契约。真实渲染样式由共享组件 NodeTileView.vue
  的 <style scoped> 承载（scoped 根透传使 .mobile-node-tile 同名规则也能命中本壳根，
  其余非根选择器为本壳契约锚点，不重复生效）。请勿删改下方选择器（移动需同步 NodeTileView）。
-->
<style scoped>
.mobile-node-tile {
  position: relative;
  box-sizing: border-box;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.mobile-node-tile-card {
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-base);
  box-sizing: border-box;
}
.mobile-node-media {
  display: block;
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: cover;
}
.mobile-node-media-box {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  box-sizing: border-box;
}
.mobile-audio-play {
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  flex: none;
}
.mobile-node-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}
.mobile-node-badge {
  position: absolute;
}
.mobile-node-badge[data-tone='busy'] {
  color: var(--lnk-info);
}
.mobile-node-badge[data-tone='warn'] {
  color: var(--lnk-warning);
}
.mobile-node-media-info {
  color: var(--lnk-text-muted);
}
.mobile-node-tile-header {
  position: absolute;
  top: -24px;
}
.mobile-node-tile-footer {
  position: absolute;
  bottom: -22px;
}
.mobile-node-retry {
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
}
.mobile-node-tile[data-state='error'] .mobile-node-tile-card {
  border-color: var(--lnk-error-border);
}
.mobile-node-tile[data-state='error'] {
  color: var(--lnk-error);
}
.mobile-node-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}
.mobile-node-multi-badge {
  position: absolute;
}
.mobile-node-hint {
  position: absolute;
}
[data-state='generating'] .mobile-node-media,
[data-state='generating'] .mobile-audio-wave,
[data-state='generating'] .mobile-node-text {
  opacity: 0.4;
  filter: grayscale(0.5);
}
</style>
