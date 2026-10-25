<script setup lang="ts">
// 被删历史（2026-10-20）：菜单项「分镜板」曾在此并 emit('storyboard')；
// #494 下线分镜节点并删除 StoryboardDialog 后 CanvasPage 已无该监听 ⇒ 死入口移除。
import { ref } from 'vue'
import { useRouter } from 'vue-router'
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
  /**
   * 2026-10-25 PR-2：点「项目名 ▾」⇒ 请求打开项目列表（ProjectPanel），用于切换项目。
   * ⛔ 只发事件、不自己实现面板：面板形态由 ProjectPanel 独占（PC 与移动端同一份）。
   */
  'project-click': []
}>()

const router = useRouter()
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
      title="返回画布列表"
      @click="router.push('/workflow')"
    >
      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
    </button>

    <div class="neo-chrome pointer-events-auto flex items-center gap-1.5 rounded-xl px-2 py-1">
      <!-- 2026-10-25 PR-2：项目入口（点开项目列表以切换项目）。
           沿用现有 chrome 容器与间距，不新增 hex；新代码走 --lnk-* 令牌
           （旧 --neo-* 体系只减不增，见 text-token-guard）。 -->
      <button
        type="button"
        class="chrome-project-btn flex h-7 max-w-[140px] items-center gap-1 rounded-lg px-1.5 text-xs transition"
        title="项目列表"
        @click.stop="emit('project-click')"
      >
        <svg
          class="h-3.5 w-3.5 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
          />
        </svg>
        <span class="truncate">{{ title || '未命名项目' }}</span>
        <svg class="h-3 w-3 shrink-0" fill="currentColor" viewBox="0 0 24 24">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>

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

/* 2026-10-25 PR-2：项目入口按钮。刻意与标题输入框区分——输入框是「改名」，
   本按钮是「换项目」；颜色取次级文本色以免抢输入框的主位。 */
.chrome-project-btn {
  color: var(--lnk-text-secondary);
}

.chrome-project-btn:hover {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-primary);
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
