<script setup lang="ts">
/**
 * 创作空间 · PC 网格卡墙（规格 §13.3/C1，≥768px）。
 * 形态：Finder 图库式竖版卡——大封面（上）+ 名称/时间（下），
 * `repeat(auto-fill, minmax(220px, 1fr))` 随容器宽度自适应列数，
 * 替代原「单列全宽长条」在 PC 上的低信息密度形态。
 * 交互契约与 ProjectList 完全一致：长按进入多选、`session-card-menu-anchor`、
 * 封面 `relative` 包裹（CanvasCoverFallback absolute inset-0 兜底，⛔ 缺它黑屏）、
 * 菜单弹层共享 ProjectCardMenu——两视图只许形态分叉，不许行为分叉。
 */
import CanvasCoverFallback from '@/components/workflow/CanvasCoverFallback.vue'
import { displayCanvasTitle } from '@/utils/displayCanvasTitle'
import ProjectCardMenu from './ProjectCardMenu.vue'
import { relativeTime } from './relativeTime'
import type { ProjectManagerApi, ProjectRowVM } from './types'

defineProps<{
  rows: ProjectRowVM[]
  mgr: ProjectManagerApi
}>()

defineEmits<{
  open: [p: ProjectRowVM]
  'press-start': [id: string]
  'press-cancel': []
}>()
</script>

<template>
  <div class="project-grid">
    <div
      v-for="p in rows"
      :key="p.id"
      class="session-card-menu-anchor group overflow-hidden rounded-2xl border border-line bg-surface-base transition hover:bg-hover"
      @pointerdown="$emit('press-start', p.id)"
      @pointerup="$emit('press-cancel')"
      @pointerleave="$emit('press-cancel')"
      @pointercancel="$emit('press-cancel')"
    >
      <!-- 管理模式：选择框浮在封面左上 -->
      <button
        v-if="mgr.manageMode.value"
        data-testid="canvases-row-select"
        type="button"
        class="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded border text-xs transition"
        :class="
          mgr.selectedIds.value.includes(p.id)
            ? 'border-transparent bg-accent-subtle text-fg-accent'
            : 'border-line bg-surface-base text-transparent hover:bg-hover'
        "
        :aria-pressed="mgr.selectedIds.value.includes(p.id)"
        @click="mgr.toggleSelect(p.id)"
      >
        ✓
      </button>

      <!-- 封面：coverUrl 三态。⛔ `relative` 不是装饰（同 ProjectList，黑屏教训） -->
      <button
        type="button"
        class="relative block aspect-[4/3] w-full overflow-hidden bg-surface-sunken"
        @click="mgr.manageMode.value ? mgr.toggleSelect(p.id) : $emit('open', p)"
      >
        <img
          v-if="p.cover.type === 'image'"
          :src="p.cover.value"
          class="h-full w-full object-cover transition group-hover:scale-[1.02]"
          alt=""
        />
        <CanvasCoverFallback v-else :seed="p.id" />
      </button>

      <!-- 名称 + 时间 + ⋯ -->
      <div class="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left text-sm text-fg"
          @click="mgr.manageMode.value ? mgr.toggleSelect(p.id) : $emit('open', p)"
        >
          {{ displayCanvasTitle(p.title) }}
        </button>
        <span class="shrink-0 text-xs text-fg-3">{{ relativeTime(p.updatedAt) }}</span>
        <div v-if="!mgr.manageMode.value" class="relative">
          <button
            data-testid="canvases-row-menu"
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-fg-3 opacity-0 transition hover:bg-hover hover:text-fg group-hover:opacity-100"
            :class="{ 'opacity-100': mgr.openMenuId.value === p.id }"
            aria-label="项目操作"
            @click.stop="mgr.toggleMenu(p.id)"
          >
            ⋯
          </button>
          <ProjectCardMenu
            v-if="mgr.openMenuId.value === p.id"
            @rename="mgr.renameProject(p)"
            @duplicate="mgr.duplicateProject(p.id)"
            @remove="mgr.removeProject(p)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* PC 卡墙：容器自适应列数（规格 §13.3/C1）。不用视口断点写死列数，
   侧栏开合 / 窗口半屏等容器宽度变化天然重排。 */
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--lnk-space-4);
}
.project-grid > * {
  position: relative;
}
</style>
