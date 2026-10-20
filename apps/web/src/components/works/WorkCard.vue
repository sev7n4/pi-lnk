<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Work } from '@lnkpi/shared'
import { resolveMediaUrl } from '@/services/api-base'

const props = defineProps<{
  work: Work
}>()

defineEmits<{
  viewWork: [workId: string]
  viewWatch: [workId: string]
  viewProcess: [workId: string]
  viewAuthor: [authorId: string]
  viewShare: [workId: string]
}>()

const videoRef = ref<HTMLVideoElement | null>(null)

const isVideoPlayback = computed(
  () => props.work.playbackKind === 'video' && !!(props.work.playbackUrl || props.work.coverUrl),
)

const mediaSrc = computed(() =>
  resolveMediaUrl(props.work.playbackUrl || props.work.coverUrl || ''),
)

async function onHoverEnter() {
  const el = videoRef.value
  if (!el) return
  try {
    el.currentTime = 0
    await el.play()
  } catch {
    /* autoplay may be blocked */
  }
}

function onHoverLeave() {
  const el = videoRef.value
  if (!el) return
  el.pause()
  try {
    el.currentTime = 0
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <article
    class="group cursor-pointer overflow-hidden rounded-2xl border border-overlay/[0.08] bg-surface-base transition hover:border-accent hover:shadow-lg hover:shadow-glow"
    @click="$emit('viewWork', work.id)"
    @mouseenter="onHoverEnter"
    @mouseleave="onHoverLeave"
  >
    <div class="relative aspect-video overflow-hidden bg-surface-elevated">
      <video
        v-if="isVideoPlayback"
        ref="videoRef"
        :src="mediaSrc"
        muted
        playsinline
        loop
        preload="metadata"
        class="h-full w-full object-cover transition duration-500 group-hover:scale-105"
      />
      <img
        v-else
        :src="resolveMediaUrl(work.coverUrl)"
        :alt="work.title"
        class="h-full w-full object-cover transition duration-500 group-hover:scale-105"
      />
      <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />

      <div class="absolute left-3 top-3 flex gap-2">
        <span class="rounded-md bg-black/50 px-2 py-0.5 text-xs backdrop-blur-sm">
          {{ work.type === 'canvas' ? '画布' : '短片' }}
        </span>
      </div>

      <!-- hover / focus-within 才显现：opacity 过渡，不用 v-if、不用 invisible（保住键盘可达） -->
      <div
        data-testid="work-cover-actions"
        class="absolute inset-0 flex items-center justify-center gap-3 bg-dim/40 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <button
          data-testid="work-cover-primary"
          type="button"
          class="btn-primary"
          @click.stop="$emit('viewWatch', work.id)"
        >
          观看
        </button>
        <button
          type="button"
          class="btn-ghost border border-overlay/12"
          aria-label="分享"
          @click.stop="$emit('viewShare', work.id)"
        >
          <!-- 24 网格 / 1.5px / currentColor（仓库无全局图标组件，本期唯一内联 SVG） -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="h-5 w-5" aria-hidden="true">
            <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" stroke-linecap="round" />
            <path d="M12 15V4m0 0L8 8m4-4 4 4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <div class="p-4">
      <div class="mb-2 flex items-center gap-2">
        <button
          class="flex h-6 w-6 items-center justify-center rounded-full bg-accent-subtle text-[10px]"
          @click.stop="$emit('viewAuthor', work.authorId)"
        >
          {{ work.authorName[0] }}
        </button>
        <button class="text-xs text-fg-3 hover:text-fg-accent" @click.stop="$emit('viewAuthor', work.authorId)">
          @{{ work.authorName }}
        </button>
      </div>
      <h3 class="line-clamp-2 text-sm font-medium leading-snug">{{ work.title }}</h3>
      <div class="mt-3 flex items-center gap-4 text-xs text-fg-3">
        <span>{{ work.likes }} 赞</span>
        <span>{{ work.views }} 浏览</span>
      </div>
    </div>
  </article>
</template>
