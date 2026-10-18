<script setup lang="ts">
/** 移动端应用骨架 · 底部页签（2026-10-18 IA v3，抄 WorkBuddy 壳）。
 * 四页签：对话 / 画布 / 发现 / 我的。画布页签图标 = 传送门（章鱼+光环）——
 * 「门」的最终形态：固定坐在第二位，三态零跳变；旧浮动门/顶栏门由此退役。
 * 挂载时发布 --lnk-tabbar-h 供 composer / DockStudioToolbar / pick bar 避让。 */
import { onMounted, onUnmounted } from 'vue'

export type MobileAppTab = 'chat' | 'canvas' | 'discover' | 'mine'

const props = defineProps<{
  active: MobileAppTab
}>()

const emit = defineEmits<{
  change: [tab: MobileAppTab]
}>()

const TABS: Array<{ key: MobileAppTab; label: string }> = [
  { key: 'chat', label: '对话' },
  { key: 'canvas', label: '画布' },
  { key: 'discover', label: '发现' },
  { key: 'mine', label: '我的' },
]

onMounted(() => {
  document.documentElement.style.setProperty(
    '--lnk-tabbar-h',
    'calc(56px + env(safe-area-inset-bottom, 0px))',
  )
})

onUnmounted(() => {
  document.documentElement.style.removeProperty('--lnk-tabbar-h')
})
</script>

<template>
  <nav class="mobile-tab-bar" aria-label="主导航">
    <button
      v-for="tab in TABS"
      :key="tab.key"
      type="button"
      class="tab-item"
      :class="{ 'is-active': props.active === tab.key, 'is-door': tab.key === 'canvas' }"
      :aria-current="props.active === tab.key ? 'page' : undefined"
      @click="emit('change', tab.key)"
    >
      <span class="tab-icon" aria-hidden="true">
        <!-- 对话：气泡 -->
        <svg v-if="tab.key === 'chat'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h8M8 14h5" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4a8 8 0 0 1 8 8 8 8 0 0 1-8 8H5.6a1.1 1.1 0 0 1-.8-1.9l1.3-1.3A8 8 0 0 1 12 4Z" />
        </svg>
        <!-- 画布：传送门（外环光环 + 章鱼盘） -->
        <span v-else-if="tab.key === 'canvas'" class="door-halo">
          <span class="door-disc" />
        </span>
        <!-- 发现：罗盘 -->
        <svg v-else-if="tab.key === 'discover'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <circle cx="12" cy="12" r="8.5" />
          <path stroke-linecap="round" stroke-linejoin="round" d="m14.8 9.2-1.6 4-4 1.6 1.6-4 4-1.6Z" />
        </svg>
        <!-- 我的：人形 -->
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <circle cx="12" cy="8" r="3.4" />
          <path stroke-linecap="round" d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
        </svg>
      </span>
      <span class="tab-label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.mobile-tab-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 80;
  display: flex;
  align-items: stretch;
  height: calc(56px + env(safe-area-inset-bottom, 0px));
  padding: 0 8px env(safe-area-inset-bottom, 0px);
  background: var(--lnk-surface-overlay);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-top: 0.5px solid var(--lnk-border, rgba(128, 128, 128, 0.25));
}

.tab-item {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: var(--lnk-text-muted, #888);
  cursor: pointer;
  padding: 4px 0 2px;
}

.tab-item.is-active {
  color: var(--lnk-text, #1c1c22);
}

.tab-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
}

.tab-icon svg {
  width: 21px;
  height: 21px;
}

.tab-label {
  font-size: 10px;
  line-height: 1;
}

/* 传送门页签：外环光环 + 实心盘（品牌门视觉，is-active 时点亮） */
.door-halo {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid currentColor;
  opacity: 0.85;
}

.tab-item.is-active .door-halo {
  opacity: 1;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--lnk-text, #1c1c22) 12%, transparent);
}

.door-disc {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: currentColor;
}
</style>
