<script setup lang="ts">
/**
 * 创作空间 · 移动行卡列表（规格 §13.3/C2：自 CanvasesPage 抽出）。
 * 微信式单行卡（Task 5 形态）：[选择框][封面 40px][名称][相对时间][⋯]。
 * 交互契约：长按进入多选、`session-card-menu-anchor` 锚点、封面 `relative`
 * 包裹（CanvasCoverFallback absolute inset-0 兜底，缺它会把页面盖成黑屏，
 * 2026-10-27 生产实证）——本组件是从页面原样搬迁，任何一条不得删。
 * PC（≥768px）由 ProjectGrid 承载；二者共享同一数据源与 mgr 状态机。
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
  /** 打开项目（管理模式下父级仍按选择语义分流） */
  open: [p: ProjectRowVM]
  'press-start': [id: string]
  'press-cancel': []
}>()
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-for="p in rows"
      :key="p.id"
      class="session-card-menu-anchor flex items-center gap-3 rounded-xl border border-line bg-surface-base px-3 py-2 transition hover:bg-hover"
      @pointerdown="$emit('press-start', p.id)"
      @pointerup="$emit('press-cancel')"
      @pointerleave="$emit('press-cancel')"
      @pointercancel="$emit('press-cancel')"
    >
      <!-- 管理模式：选择框占据行首 -->
      <button
        v-if="mgr.manageMode.value"
        data-testid="canvases-row-select"
        type="button"
        class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs transition"
        :class="
          mgr.selectedIds.value.includes(p.id)
            ? 'border-transparent bg-accent-subtle text-fg-accent'
            : 'border-line text-transparent hover:bg-hover'
        "
        :aria-pressed="mgr.selectedIds.value.includes(p.id)"
        @click="mgr.toggleSelect(p.id)"
      >
        ✓
      </button>
      <!-- 封面 40px：coverUrl 三态（image / CanvasCoverFallback 兜底）。
           ⛔ `relative` 不是装饰：CanvasCoverFallback 根元素是 `absolute inset-0`，
           缺它时兜底层会锚定到 App 壳的 main.relative ⇒ 被拉成全屏墨点纸，
           把整个创作首页盖成黑屏（2026-10-27 生产取证实证，v2.4 修复）。 -->
      <button
        type="button"
        class="relative flex h-10 w-10 shrink-0 items-center overflow-hidden rounded-lg bg-surface-sunken"
        @click="mgr.manageMode.value ? mgr.toggleSelect(p.id) : $emit('open', p)"
      >
        <img
          v-if="p.cover.type === 'image'"
          :src="p.cover.value"
          class="h-full w-full object-cover"
          alt=""
        />
        <CanvasCoverFallback v-else :seed="p.id" />
      </button>
      <!-- 名称 -->
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left text-sm text-fg"
        @click="mgr.manageMode.value ? mgr.toggleSelect(p.id) : $emit('open', p)"
      >
        {{ displayCanvasTitle(p.title) }}
      </button>
      <!-- 相对时间 -->
      <span class="shrink-0 text-xs text-fg-3">{{ relativeTime(p.updatedAt) }}</span>
      <!-- 行内菜单（管理模式下隐藏，选择语义优先） -->
      <div v-if="!mgr.manageMode.value" class="relative">
        <button
          data-testid="canvases-row-menu"
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-fg-3 transition hover:bg-hover hover:text-fg"
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
</template>
