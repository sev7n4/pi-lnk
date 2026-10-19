<script setup lang="ts">
/** 移动端应用骨架 · 顶栏（2026-10-19 IA v3.1 对话驱动叙事）：
 * 【对话】页签 = [≡ 会话抽屉]（抽屉唯一入口，含项目卡片）；
 * 【画布】页签 = [⋯ 画布管理菜单]（保存/分镜板/发布/导入/导出）；
 * 【发现】【我的】= 透明占位（保持 --lnk-topbar-h 高度一致，不放任何入口）。
 * 2026-10-19 用户裁决：顶栏「未命名画布」标题输入整体移除——对话驱动叙事下
 * 顶栏不放画布名；项目重命名入口在抽屉项目卡片菜单。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useClickOutside } from '@/composables/useClickOutside'

const props = defineProps<{
  tab: 'chat' | 'canvas' | 'discover' | 'mine'
}>()

const emit = defineEmits<{
  'open-drawer': []
  save: []
  storyboard: []
  publish: []
  'import-workflow': []
  'export-workflow': []
}>()

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

const isGhost = computed(() => props.tab === 'discover' || props.tab === 'mine')

function closeMenu() {
  menuOpen.value = false
}

useClickOutside(menuRef, closeMenu)

function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

function onMenuItem(action: 'save' | 'storyboard' | 'publish' | 'import' | 'export') {
  menuOpen.value = false
  if (action === 'save') emit('save')
  else if (action === 'storyboard') emit('storyboard')
  else if (action === 'publish') emit('publish')
  else if (action === 'import') emit('import-workflow')
  else emit('export-workflow')
}

onMounted(() => {
  document.documentElement.style.setProperty(
    '--lnk-topbar-h',
    'calc(44px + env(safe-area-inset-top, 0px))',
  )
})

onUnmounted(() => {
  document.documentElement.style.removeProperty('--lnk-topbar-h')
})
</script>

<template>
  <header class="mobile-top-bar" :class="{ 'is-ghost': isGhost }">
    <!-- 对话页签：≡ 会话抽屉（唯一入口） -->
    <button
      v-if="props.tab === 'chat'"
      type="button"
      class="bar-btn"
      aria-label="会话与项目"
      @click="emit('open-drawer')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
        <path stroke-linecap="round" d="M5 9h14M8 15h11" />
      </svg>
    </button>

    <!-- 画布页签：右端 ⋯ 画布管理菜单 -->
    <div v-if="props.tab === 'canvas'" ref="menuRef" class="menu-anchor">
      <button
        type="button"
        class="bar-btn"
        aria-label="画布管理菜单"
        @click.stop="toggleMenu"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <circle cx="6" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="18" cy="12" r="1.8" />
        </svg>
      </button>
      <div v-if="menuOpen" class="bar-menu" @click.stop>
        <button type="button" class="bar-menu-item" @click="onMenuItem('save')">保存画布</button>
        <button type="button" class="bar-menu-item" @click="onMenuItem('storyboard')">分镜板</button>
        <button type="button" class="bar-menu-item" @click="onMenuItem('publish')">发布作品</button>
        <button type="button" class="bar-menu-item" @click="onMenuItem('import')">导入工作流</button>
        <button type="button" class="bar-menu-item" @click="onMenuItem('export')">导出工作流</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.mobile-top-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 85;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: calc(44px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) 10px 0;
  background: var(--lnk-surface-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 0.5px solid var(--lnk-border-subtle);
  transform: translateZ(0);
}

/* 发现/我的：透明占位——只撑高度，不放入口、不挡视觉 */
.mobile-top-bar.is-ghost {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-bottom-color: transparent;
  pointer-events: none;
}

.bar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--lnk-text-primary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.bar-btn:active {
  background: color-mix(in srgb, var(--lnk-text-primary) 8%, transparent);
}

.bar-btn svg {
  width: 19px;
  height: 19px;
}

.menu-anchor {
  position: relative;
}

.bar-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 10;
  min-width: 140px;
  padding: 4px 0;
  border-radius: 12px;
  background: var(--lnk-surface-raised);
  border: 0.5px solid var(--lnk-border-subtle);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.bar-menu-item {
  display: block;
  width: 100%;
  padding: 8px 14px;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-xs, 12px);
  text-align: left;
  cursor: pointer;
}

.bar-menu-item:active {
  background: color-mix(in srgb, var(--lnk-text-primary) 8%, transparent);
}
</style>
