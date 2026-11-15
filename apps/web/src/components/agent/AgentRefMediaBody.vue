<script setup lang="ts">
/**
 * 侧栏素材的**唯一**内容渲染器（T/I/V/A 四类型）。
 *
 * 2026-11-15 上线后反馈：先前 AgentRefHoverPreview / DockRefPreview 各自复制了一份
 * 四媒体分支，且卡片底色写死深色 + 主题文字色 ⇒ 浅色主题下正文「渲染了但看不见」。
 * 本组件把内容分支收成一份，由 PC hover 卡（AgentRefHoverPreview）与移动端 sheet
 * （AgentRefDetailSheet）两个外壳共同委托，避免第三份实现再次漂移。
 *
 * ⚠️ 颜色只用语义类（text-fg / text-fg-2 / text-fg-3 / border-line-*），
 *    外壳负责面（bg-surface-overlay / MobileSheet 的 surface-raised）。
 *    ⛔ 禁止在这里写深色或浅色专用字面量。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { NodeRef } from '@/composables/useNodeRefs'
import { resolveMediaUrl } from '@/services/api-base'

const props = withDefaults(
  defineProps<{
    refItem: NodeRef
    /** compact = 速览（hover 卡）；expanded = 全文/大图/可播放（pinned 卡 / 移动 sheet） */
    expanded?: boolean
  }>(),
  { expanded: false },
)

const emit = defineEmits<{
  /** 用户在速览态点「展开全文 / 查看大图 / 播放」——外壳据此把自己钉住，别再 80ms 自动关 */
  expand: []
}>()

/** 速览文本窗口：给个能判断「这是什么文档」的量，不把 6000+ 字塞进 340px 卡。 */
const PREVIEW_CHARS = 600

const isText = computed(() => props.refItem.mediaType === 'text')
const textContent = computed(() => {
  if (!isText.value) return ''
  return props.refItem.payload.text || props.refItem.preview || ''
})
const charCount = computed(() => [...textContent.value].length)
const shownText = computed(() =>
  props.expanded || charCount.value <= PREVIEW_CHARS
    ? textContent.value
    : `${textContent.value.slice(0, PREVIEW_CHARS)}…`,
)
const needsExpand = computed(() => !props.expanded && charCount.value > PREVIEW_CHARS)

const mediaUrl = computed(() => {
  if (isText.value) return ''
  const raw = props.refItem.payload.url || props.refItem.preview || ''
  return raw ? resolveMediaUrl(raw) : ''
})

/** 展开后自动起播（用户刚点过「播放」，是有效手势）；jsdom 无 play 时静默降级。 */
const mediaEl = ref<HTMLVideoElement | HTMLAudioElement | null>(null)
watch(
  () => props.expanded,
  async (on) => {
    if (!on) return
    await nextTick()
    const el = mediaEl.value
    if (el && typeof el.play === 'function') void el.play().catch(() => {})
  },
  { flush: 'post' },
)

/** 退出即停：外壳卸载（X / Esc / 点遮罩 / 下滑关闭）时媒体不许在后台继续播。 */
onBeforeUnmount(() => {
  const el = mediaEl.value
  if (el && typeof el.pause === 'function') el.pause()
})

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})

async function copyText() {
  try {
    await navigator.clipboard?.writeText(textContent.value)
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // 非安全上下文 / 权限拒绝：不假装成功，也不打断阅读
  }
}
</script>

<template>
  <div class="agent-ref-media-body" data-testid="ref-media-body">
    <template v-if="isText">
      <p v-if="!textContent" class="text-xs text-fg-3" data-testid="ref-media-empty">（空文本）</p>
      <template v-else>
        <p class="mb-1.5 text-[11px] text-fg-3" data-testid="ref-media-meta">
          {{ charCount }} 字<span v-if="needsExpand"> · 预览前 {{ PREVIEW_CHARS }} 字</span>
        </p>
        <p
          class="overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-fg"
          :class="expanded ? 'max-h-[min(60vh,520px)]' : 'max-h-[280px]'"
          data-testid="ref-media-text"
        >{{ shownText }}</p>
        <div class="mt-2 flex items-center gap-2">
          <button
            v-if="needsExpand"
            type="button"
            class="rounded-md border border-line px-2 py-1 text-[11px] text-fg-2 hover:bg-overlay/10 hover:text-fg"
            data-testid="ref-media-expand"
            @click="emit('expand')"
          >展开全文</button>
          <button
            v-if="expanded"
            type="button"
            class="rounded-md border border-line px-2 py-1 text-[11px] text-fg-2 hover:bg-overlay/10 hover:text-fg"
            data-testid="ref-media-copy"
            @click="copyText"
          >{{ copied ? '已复制' : '复制全文' }}</button>
        </div>
      </template>
    </template>

    <template v-else-if="refItem.mediaType === 'image' && mediaUrl">
      <img
        :src="mediaUrl"
        alt=""
        class="w-full rounded-lg object-contain"
        :class="expanded ? 'max-h-[70vh]' : 'max-h-[300px]'"
        data-testid="ref-media-image"
      >
      <button
        v-if="!expanded"
        type="button"
        class="mt-2 rounded-md border border-line px-2 py-1 text-[11px] text-fg-2 hover:bg-overlay/10 hover:text-fg"
        data-testid="ref-media-expand"
        @click="emit('expand')"
      >查看大图</button>
    </template>

    <template v-else-if="refItem.mediaType === 'video' && mediaUrl">
      <video
        v-if="expanded"
        ref="mediaEl"
        :src="mediaUrl"
        controls
        playsinline
        class="max-h-[70vh] w-full rounded-lg"
        data-testid="ref-media-video"
      />
      <template v-else>
        <video
          :src="mediaUrl"
          muted
          playsinline
          preload="metadata"
          class="max-h-[180px] w-full rounded-lg"
          data-testid="ref-media-video-poster"
        />
        <button
          type="button"
          class="mt-2 rounded-md border border-line px-2 py-1 text-[11px] text-fg-2 hover:bg-overlay/10 hover:text-fg"
          data-testid="ref-media-expand"
          @click="emit('expand')"
        >播放视频</button>
      </template>
    </template>

    <template v-else-if="refItem.mediaType === 'audio' && mediaUrl">
      <audio
        v-if="expanded"
        ref="mediaEl"
        :src="mediaUrl"
        controls
        class="w-full"
        data-testid="ref-media-audio"
      />
      <button
        v-else
        type="button"
        class="w-full rounded-md border border-line px-2 py-2 text-xs text-fg-2 hover:bg-overlay/10 hover:text-fg"
        data-testid="ref-media-expand"
        @click="emit('expand')"
      >播放音频 · {{ refItem.label }}</button>
    </template>

    <p v-else class="text-xs text-fg-3" data-testid="ref-media-empty">暂无可预览内容</p>
  </div>
</template>
