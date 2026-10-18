<script setup lang="ts">
/** 移动端应用骨架 · 顶栏三区（2026-10-18 IA v3，抄 WorkBuddy）：
 * [≡ 会话抽屉] [会话标题·点按重命名] [⋯ 画布管理菜单]。
 * 头像位不抄（「我的」页签已覆盖）。挂载时发布 --lnk-topbar-h 供各面板避让。 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useClickOutside } from '@/composables/useClickOutside'

const props = defineProps<{
  title: string
}>()

const emit = defineEmits<{
  'update:title': [value: string]
  'open-drawer': []
  save: []
  storyboard: []
  publish: []
  'import-workflow': []
  'export-workflow': []
}>()

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

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
  <header class="mobile-top-bar">
    <button
      type="button"
      class="bar-btn"
      aria-label="会话抽屉"
      @click="emit('open-drawer')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
        <path stroke-linecap="round" d="M5 9h14M8 15h11" />
      </svg>
    </button>

    <input
      :value="props.title"
      class="bar-title"
      aria-label="会话标题"
      @input="emit('update:title', ($event.target as HTMLInputElement).value)"
    >

    <div ref="menuRef" class="relative">
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
  gap: 4px;
  height: calc(44px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) 10px 0;
  background: var(--lnk-surface-overlay);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-bottom: 0.5px solid var(--lnk-border, rgba(128, 128, 128, 0.25));
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
  color: var(--lnk-text, #1c1c22);
  cursor: pointer;
}

.bar-btn:active {
  background: color-mix(in srgb, var(--lnk-text, #1c1c22) 8%, transparent);
}

.bar-btn svg {
  width: 19px;
  height: 19px;
}

.bar-title {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--lnk-text, #1c1c22);
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  text-overflow: ellipsis;
}

.bar-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 10;
  min-width: 140px;
  padding: 4px 0;
  border-radius: 12px;
  background: var(--lnk-surface-raised, #fff);
  border: 0.5px solid var(--lnk-border, rgba(128, 128, 128, 0.25));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.bar-menu-item {
  display: block;
  width: 100%;
  padding: 8px 14px;
  border: none;
  background: transparent;
  color: var(--lnk-text, #1c1c22);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.bar-menu-item:active {
  background: color-mix(in srgb, var(--lnk-text, #1c1c22) 8%, transparent);
}
</style>
