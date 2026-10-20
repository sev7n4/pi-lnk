<script setup lang="ts">
import { computed } from 'vue'
import type { Session } from '@lnkpi/shared'
import { resolveMediaUrl } from '@/services/api-base'
import { formatSessionTime } from '@/utils/formatSessionTime'
import { extractSessionCover } from '@/utils/sessionCover'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'

const props = defineProps<{
  session: Session
  manageMode?: boolean
  selected?: boolean
  menuOpen?: boolean
}>()

const emit = defineEmits<{
  open: []
  toggleMenu: []
  rename: []
  duplicate: []
  delete: []
  toggleSelect: []
}>()

const cover = computed(() => extractSessionCover(props.session))
const coverUrl = computed(() => (cover.value ? resolveMediaUrl(cover.value.url) : ''))
</script>

<template>
  <div
    class="session-card group relative flex aspect-[4/3] flex-col overflow-hidden rounded-2xl border text-left transition"
    :class="selected ? 'session-card-selected' : ''"
  >
    <label
      v-if="manageMode"
      class="absolute left-2 top-2 z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-overlay/20 bg-dim/50"
      @click.stop
    >
      <input
        type="checkbox"
        class="h-3.5 w-3.5 accent-[var(--lnk-accent)]"
        :checked="selected"
        @change="emit('toggleSelect')"
      >
    </label>

    <div
      class="session-card-menu-anchor absolute right-2 top-2 z-10"
      @click.stop
    >
      <button
        v-if="!manageMode"
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-lg bg-dim/50 text-fg-2 opacity-0 transition hover:bg-dim/70 hover:text-fg group-hover:opacity-100"
        :class="{ 'opacity-100': menuOpen }"
        title="更多操作"
        @click="emit('toggleMenu')"
      >
        <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      <div
        v-if="menuOpen"
        class="absolute right-0 top-full mt-1 min-w-[120px] overflow-hidden rounded-xl border border-line-subtle py-1 shadow-lg"
        style="background: var(--lnk-surface-overlay)"
      >
        <button
          type="button"
          class="flex w-full px-3 py-2 text-left text-xs text-fg-2 transition hover:bg-hover hover:text-fg"
          @click="emit('rename')"
        >
          重命名
        </button>
        <button
          type="button"
          class="flex w-full px-3 py-2 text-left text-xs text-fg-2 transition hover:bg-hover hover:text-fg"
          @click="emit('duplicate')"
        >
          复制副本
        </button>
        <button
          type="button"
          class="flex w-full px-3 py-2 text-left text-xs text-danger transition hover:bg-hover"
          @click="emit('delete')"
        >
          删除
        </button>
      </div>
    </div>

    <button
      type="button"
      class="session-card-body flex h-full w-full flex-col"
      @click="manageMode ? emit('toggleSelect') : emit('open')"
    >
      <div class="relative min-h-0 flex-1 overflow-hidden bg-surface-sunken">
        <img
          v-if="cover?.kind === 'image' && coverUrl"
          :src="coverUrl"
          alt=""
          loading="lazy"
          class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
        >
        <video
          v-else-if="cover?.kind === 'video' && coverUrl"
          :src="coverUrl"
          muted
          preload="metadata"
          class="h-full w-full object-cover"
        />
        <!-- 无封面兜底：品牌纹样（P1：原为 32px 灰 SVG 占位块，视觉上像加载失败） -->
        <div v-else class="flex h-full w-full items-center justify-center">
          <BrandPatternAvatar :seed="session.id" :name="session.title || '画布'" size="lg" />
        </div>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-dim/70 to-transparent" />
      </div>
      <div class="relative z-[1] -mt-6 px-3 pb-2.5 pt-0">
        <p class="truncate text-[13px] font-medium text-fg group-hover:text-fg">
          {{ session.title || '未命名画布' }}
        </p>
        <p class="mt-0.5 text-[10px] text-fg-3">{{ formatSessionTime(session.updatedAt) }}</p>
      </div>
    </button>
  </div>
</template>

<style scoped>
.session-card {
  border-color: var(--lnk-border-subtle);
  background: var(--lnk-surface-base);
}

.session-card:hover {
  border-color: color-mix(in srgb, var(--lnk-accent) 28%, var(--lnk-border-subtle));
  box-shadow: var(--lnk-shadow-md);
}

.session-card-selected {
  border-color: var(--lnk-accent);
  background: color-mix(in srgb, var(--lnk-accent-subtle) 60%, var(--lnk-surface-base));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--lnk-accent) 40%, transparent);
}
</style>
