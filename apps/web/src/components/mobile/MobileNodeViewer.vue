<script setup lang="ts">
import NodeViewerView from '@/components/agent/presentation/NodeViewerView.vue'

/**
 * 移动端全屏查看器 —— **薄壳**（Task 3，Phase 1 视图层统一）。
 *
 * 渲染主体（媒体区 / 标注 / 双指缩放容器 / 审核内容层 / chrome）及与之强耦合的
 * 手势 / 退出 / 缩放探测逻辑，整体委托给共享组件 `NodeViewerView`
 * （presentation/，设备无关、零 isMobileLayout），供移动壳与（Phase 3）PC 查看器复用。
 *
 * ⭐ 本壳仅保留**外部契约**：`defineProps` / `defineEmits` 与重构前**逐字一致**
 * （既有的手势 / 退出 / 缩放 / 标注测试经壳层委托落到 NodeViewerView，禁止改名 /
 * 改类型 / 改事件签名）。事件经 `v-on` 原样上抛，未转为回调 prop。
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
      /** 受信级 CSP 分流判据（§5.2）：仅系统 digest 管道写入 'system-digest'。 */
      source?: string
    }
    /**
     * 底部主栏动作（§4.11.6 可达性：高频操作放下方拇指区，顶部只放低频退出类）。
     * ⭐ 如 confirmed 态的「编辑」—— ⛔ 不放右上角（那是低频区）。
     * `icon` 走苹果风内联 SVG（24 网格 + stroke 2 + 圆头），与全站图标纪律一致。
     */
    bottomActions?: Array<{
      key: string
      label: string
      variant?: 'primary' | 'danger'
      icon?: 'pencil' | 'speaker' | 'stop'
    }>
    /**
     * 规格 v1.5 §4.12.2（拍板项 O）：长按唤起的 Menu 是否打开中。
     * 打开时轻暂停媒体；关闭时恢复此前播放态（仅在播才恢复）。
     */
    menuOpen?: boolean
  }>(),
  { bottomActions: () => [], menuOpen: false },
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
  /** 问题③ v2：confirmed 文本节点就地编辑保存 ⇒ 壳层 patchNodeData({content})（本地校正产物，不绕 agent） */
  (e: 'content-save', content: string): void
  /** 右上「⋯」= 操作全集（打开与长按同一个 Menu，§4.6 同源同容器） */
  (e: 'more'): void
  /** 底部主栏动作被点击（key 透传；音频 edit 携带 mediaTime——v1.5 Q at mm:ss 链路起点） */
  (e: 'bottom-action', key: string, meta?: { mediaTime?: number }): void
}>()
</script>

<template>
  <!--
    薄壳：渲染主体委托 NodeViewerView（共享层）。props 原样下透；
    6 个事件原样上抛（未转回调 prop）。手势 / 退出 / 双指缩放探测随渲染
    留在 NodeViewerView（与 NodeTile 同型：手势入口即共享视图根）。
  -->
  <NodeViewerView
    v-bind="props"
    @close="emit('close')"
    @annotate="(p) => emit('annotate', p)"
    @edit-save="(p) => emit('edit-save', p)"
    @content-save="(p) => emit('content-save', p)"
    @more="emit('more')"
    @bottom-action="(k, m) => emit('bottom-action', k, m)"
  />
</template>
