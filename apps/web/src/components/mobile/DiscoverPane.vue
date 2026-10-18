<script setup lang="ts">
/** 移动端应用骨架 · 发现页签（2026-10-18 IA v3，整页照抄 WorkBuddy 截图3）：
 * 资料库 / 专家(置灰) / 技能(置灰) / 连接器(置灰) / 项目(=工作台列表)。
 * PR1 仅落地骨架与可行入口；专家/技能/连接器待后续开发置灰。 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const emit = defineEmits<{
  /** 资料库 → 切回画布页签（资产库面板在画布侧，PR2 打开直连） */
  'goto-canvas': []
}>()

const router = useRouter()

const rows = [
  { key: 'assets', label: '资料库', icon: 'book', enabled: true },
  { key: 'experts', label: '专家', icon: 'experts', enabled: false },
  { key: 'skills', label: '技能', icon: 'skills', enabled: false },
  { key: 'connectors', label: '连接器', icon: 'connectors', enabled: false },
  { key: 'projects', label: '项目', icon: 'projects', enabled: true },
] as const

const activeKey = ref<string | null>(null)

function onRow(key: (typeof rows)[number]['key']) {
  activeKey.value = key
  if (key === 'assets') {
    emit('goto-canvas')
    return
  }
  if (key === 'projects') {
    void router.push('/workflow')
  }
}
</script>

<template>
  <div class="discover-pane">
    <div class="row-group">
      <button
        v-for="row in rows"
        :key="row.key"
        type="button"
        class="row-item"
        :class="{ 'is-disabled': !row.enabled }"
        :disabled="!row.enabled"
        @click="onRow(row.key)"
      >
        <span class="row-icon" aria-hidden="true">
          <!-- 资料库：书 -->
          <svg v-if="row.icon === 'book'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.6H5.5A1.5 1.5 0 0 1 4 15.9V5.5Z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.6h4.9A1.5 1.5 0 0 0 20 15.9V5.5Z" />
          </svg>
          <!-- 专家：星徽 -->
          <svg v-else-if="row.icon === 'experts'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <circle cx="12" cy="12" r="8.5" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 7.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1L12 14.6l-2.8 1.5.6-3.1-2.3-2.2 3.1-.4L12 7.5Z" />
          </svg>
          <!-- 技能：扳手 -->
          <svg v-else-if="row.icon === 'skills'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M14.5 6.5a3.5 3.5 0 0 0-4.6 4.4L5 15.8a1.8 1.8 0 1 0 2.5 2.5l4.9-4.9a3.5 3.5 0 0 0 4.4-4.6l-2.2 2.2-2.1-.4-.4-2.1 2.4-2Z" />
          </svg>
          <!-- 连接器：链环 -->
          <svg v-else-if="row.icon === 'connectors'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 14a4 4 0 0 1 0-5.6l2.4-2.4a4 4 0 0 1 5.6 5.6l-1.4 1.4" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M14 10a4 4 0 0 1 0 5.6l-2.4 2.4a4 4 0 0 1-5.6-5.6l1.4-1.4" />
          </svg>
          <!-- 项目：工作台 -->
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <rect x="4" y="4" width="7" height="7" rx="1.5" />
            <rect x="13" y="4" width="7" height="7" rx="1.5" />
            <rect x="4" y="13" width="7" height="7" rx="1.5" />
            <rect x="13" y="13" width="7" height="7" rx="1.5" />
          </svg>
        </span>
        <span class="row-label">{{ row.label }}</span>
        <svg v-if="row.enabled" class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.discover-pane {
  position: fixed;
  inset: 0;
  z-index: 75;
  padding: calc(var(--lnk-topbar-h, 44px) + 12px) 12px calc(var(--lnk-tabbar-h, 56px) + 12px);
  background: var(--lnk-surface-canvas);
  overflow-y: auto;
}

.row-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 14px;
  border: 0.5px solid var(--lnk-border, rgba(128, 128, 128, 0.25));
  border-radius: 14px;
  background: var(--lnk-surface-raised, #fff);
  color: var(--lnk-text, #1c1c22);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.row-item.is-disabled {
  opacity: 0.4;
  cursor: default;
}

.row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}

.row-icon svg {
  width: 20px;
  height: 20px;
}

.row-label {
  flex: 1 1 auto;
}

.row-chevron {
  width: 16px;
  height: 16px;
  opacity: 0.4;
}
</style>
