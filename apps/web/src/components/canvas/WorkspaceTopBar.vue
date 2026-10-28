<script setup lang="ts">
/**
 * WEB 工作台统一顶栏（规格 §6.8）：画布路由顶部整页栏，替代原 CanvasFloatingChrome
 * （可编辑 title + 返回 + 保存/发布/导入/导出）与右上漂浮簇（ThemeToggle + AccountChrome）。
 * 职责：左 ‹ 返回创作空间 + 项目名（§6.4 次级灰、15px、截断）；右簇 发现/主题/账号/⋯
 * （v3 §13.4：「我的」撤除，头像下拉全权承载个人枢纽）。
 * 项目名是上下文而非操作（次级静默、非交互），与移动端 MobileTopBar 共用 §6.4 语义。
 */
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import AccountChrome from '@/components/account/AccountChrome.vue'
import { useClickOutside } from '@/composables/useClickOutside'

defineProps<{
  /** 当前项目名（规格 §6.4） */
  projectName: string
}>()

const emit = defineEmits<{
  /** ‹ 返回创作空间（/canvases） */
  'go-gallery': []
  /** 手动保存画布（桌面无自动保存入口时的兜底） */
  save: []
  publish: []
  'import-workflow': []
  'export-workflow': []
  /** 导出二级——轻量包（不含媒体） */
  'export-workflow-light': []
}>()

const menuOpen = ref(false)
const exportOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

useClickOutside(menuRef, () => {
  menuOpen.value = false
  exportOpen.value = false
})

function closeMenu() {
  menuOpen.value = false
  exportOpen.value = false
}

function onMenuItem(
  action: 'save' | 'publish' | 'import' | 'export' | 'export-light',
) {
  closeMenu()
  if (action === 'save') emit('save')
  else if (action === 'publish') emit('publish')
  else if (action === 'import') emit('import-workflow')
  else if (action === 'export') emit('export-workflow')
  else emit('export-workflow-light')
}
</script>

<template>
  <header class="workspace-top-bar">
    <!-- 左：‹ 返回创作空间 + 项目名 -->
    <div class="wkb-left">
      <button
        type="button"
        class="wkb-back"
        data-testid="workspace-back"
        aria-label="返回创作空间"
        @click="emit('go-gallery')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 18l-6-6 6-6" />
        </svg>
        <span class="wkb-back__label">创作空间</span>
      </button>
      <span
        class="wkb-project-name"
        data-testid="workspace-project-name"
      >{{ projectName }}</span>
    </div>

    <!-- 右簇：发现/主题/账号/⋯（§13.4/D1：「我的」撤除——与头像下拉（我的主页）重复） -->
    <div class="wkb-right">
      <RouterLink
        to="/community"
        class="wkb-nav"
        data-testid="workspace-discover"
      >
        发现
      </RouterLink>
      <ThemeToggle class="wkb-icon" />
      <AccountChrome />
      <div ref="menuRef" class="wkb-menu-anchor">
        <button
          type="button"
          class="wkb-icon"
          data-testid="workspace-menu"
          aria-label="项目菜单"
          @click.stop="menuOpen = !menuOpen"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="6" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="18" cy="12" r="1.8" />
          </svg>
        </button>
        <div v-if="menuOpen" class="wkb-menu" @click.stop>
          <button type="button" class="wkb-menu-item" @click="onMenuItem('save')">
            保存画布
          </button>
          <button type="button" class="wkb-menu-item" @click="onMenuItem('publish')">
            发布作品
          </button>
          <button
            type="button"
            class="wkb-menu-item wkb-menu-parent"
            data-testid="wkb-export"
            :aria-expanded="exportOpen"
            @click.stop="exportOpen = !exportOpen"
          >
            <span>导出工作流</span>
            <svg class="wkb-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div v-if="exportOpen" class="wkb-menu-sub" data-testid="wkb-export-sub">
            <button type="button" class="wkb-menu-item" @click="onMenuItem('export')">
              完整工作流包
            </button>
            <button type="button" class="wkb-menu-item" @click="onMenuItem('export-light')">
              轻量包（不含媒体）
            </button>
          </div>
          <button type="button" class="wkb-menu-item" @click="onMenuItem('import')">
            导入工作流
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.workspace-top-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--lnk-z-chrome);
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 12px;
  background: var(--lnk-surface);
  /* §13.1/A1：发丝线退役（封条感主源）；画布节点平移穿栏 ⇒ 材质底+blur 保留 */
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.wkb-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.wkb-back {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  height: 34px;
  padding: 0 6px 0 2px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.wkb-back svg {
  width: 20px;
  height: 20px;
}

.wkb-back__label {
  font-size: 15px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

/* 项目名（规格 §6.4：次级灰、15px、超长截断、非交互） */
.wkb-project-name {
  flex: 1 1 auto;
  min-width: 0;
  max-width: calc(100% - 160px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 500;
  color: var(--lnk-text-secondary);
  line-height: 1;
}

.wkb-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.wkb-nav {
  font-size: 14px;
  color: var(--lnk-text-secondary);
  text-decoration: none;
  padding: 6px 8px;
  border-radius: 8px;
  white-space: nowrap;
}

.wkb-nav:hover {
  background: var(--lnk-hover, rgba(0, 0, 0, 0.05));
  color: var(--lnk-text-primary);
}

.wkb-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.wkb-icon svg {
  width: 18px;
  height: 18px;
}

.wkb-menu-anchor {
  position: relative;
}

.wkb-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 10;
  min-width: 150px;
  padding: 4px 0;
  border-radius: 12px;
  background: var(--lnk-surface-raised);
  border: 0.5px solid var(--lnk-border-subtle, rgba(0,0,0,0.1));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.wkb-menu-item {
  display: block;
  width: 100%;
  min-height: 40px;
  padding: 0 14px;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.wkb-menu-item:hover {
  background: var(--lnk-hover, rgba(0, 0, 0, 0.05));
}

.wkb-menu-parent {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wkb-menu-sub {
  margin: 2px 0 2px 10px;
  padding-left: 6px;
  border-left: 1px solid var(--lnk-border-subtle, rgba(0,0,0,0.1));
}

.wkb-chevron {
  width: 14px;
  height:14px;
  flex: none;
  color: var(--lnk-text-muted);
}
</style>
