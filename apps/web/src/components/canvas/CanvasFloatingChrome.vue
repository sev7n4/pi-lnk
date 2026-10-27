<script setup lang="ts">
// 被删历史（2026-10-20）：菜单项「分镜板」曾在此并 emit('storyboard')；
// #494 下线分镜节点并删除 StoryboardDialog 后 CanvasPage 已无该监听 ⇒ 死入口移除。
// 2026-10-26 规格收敛 v2（D7 纯微信式）：「项目名 ▾」下拉退场——切换项目 =
// 返回创作首页（CanvasPage 接 back）；「‹」返回钮的导航决定权上交 CanvasPage。
import { ref } from 'vue'
import { useClickOutside } from '@/composables/useClickOutside'

defineProps<{
  title: string
  saving?: boolean
}>()

const emit = defineEmits<{
  'update:title': [value: string]
  save: []
  publish: []
  importWorkflow: []
  exportWorkflow: []
  /** 2026-10-26（D7）：点「‹」⇒ 请求返回创作首页（CanvasPage 决定导航目标）。 */
  back: []
}>()

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

function closeMenu() {
  menuOpen.value = false
}

useClickOutside(menuRef, closeMenu)
</script>

<template>
  <!-- left-3：工具竖排面板已下移到标题栏下方，返回按钮回到左上角原点不再被遮挡 -->
  <div class="canvas-floating-chrome pointer-events-none absolute left-3 top-3 z-[50] flex items-start gap-2">
    <button
      type="button"
      class="neo-chrome pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl transition"
      title="返回创作首页"
      @click="emit('back')"
    >
      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
    </button>

    <div class="neo-chrome pointer-events-auto flex items-center gap-1.5 rounded-xl px-2 py-1">
      <input
        :value="title"
        class="chrome-title-input w-[110px] truncate bg-transparent px-1 py-1 text-sm font-medium outline-none transition-all duration-200 focus:w-[200px]"
        placeholder="未命名项目"
        @input="emit('update:title', ($event.target as HTMLInputElement).value)"
      >
      <div ref="menuRef" class="relative">
        <button
          type="button"
          class="chrome-more-btn flex h-7 w-7 items-center justify-center rounded-lg transition"
          title="更多操作"
          @click.stop="menuOpen = !menuOpen"
        >
          <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
        <div
          v-if="menuOpen"
          class="neo-popover absolute left-0 top-full z-10 mt-1.5 min-w-[140px] rounded-xl py-1"
          @click.stop
        >
          <button
            type="button"
            class="neo-popover-item flex w-full px-3 py-2 text-left text-xs"
            @click="emit('save'); closeMenu()"
          >
            {{ saving ? '保存中...' : '保存画布' }}
          </button>
          <button
            type="button"
            class="neo-popover-item flex w-full px-3 py-2 text-left text-xs"
            @click="emit('publish'); closeMenu()"
          >
            发布作品
          </button>
          <!-- 2026-10-12 迁入：导入/导出是非高频操作，从右上角常驻按钮收敛到
               「...」菜单，画布常驻 chrome 只留主题与账号 -->
          <button
            type="button"
            class="neo-popover-item flex w-full px-3 py-2 text-left text-xs"
            @click="emit('importWorkflow'); closeMenu()"
          >
            导入工作流
          </button>
          <button
            type="button"
            class="neo-popover-item flex w-full px-3 py-2 text-left text-xs"
            @click="emit('exportWorkflow'); closeMenu()"
          >
            导出工作流
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chrome-title-input {
  color: var(--neo-text-primary);
}

.chrome-title-input::placeholder {
  color: var(--neo-text-muted);
}

.chrome-more-btn {
  color: var(--neo-text-muted);
}

.chrome-more-btn:hover {
  background: var(--neo-hover-bg);
  color: var(--neo-text-secondary);
}
</style>
