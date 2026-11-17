<script setup lang="ts">
/**
 * P3 技能选择 sheet：`+` →【技能】弹出（替代 inline 子菜单单选）。
 * 数据源由宿主传入 dockSkills（单一事实源，禁独立拉取/硬编码——规格 §4.5 N1 靶点）；
 * 选中语义 = toggle 胶囊（已选再点 = 移除）；底部固定【管理技能】入口（C6）。
 * 「自动」项 = 清空全部胶囊（平台路由，等价旧 activeSkillId=null）。
 */
import { computed } from 'vue'

export interface PickSkillItem {
  id: string
  label: string
  desc?: string
}

const props = defineProps<{
  skills: PickSkillItem[]
  selectedIds: string[]
}>()

const emit = defineEmits<{
  toggle: [id: string]
  clear: []
  close: []
  manage: []
}>()

const hasSelection = computed(() => props.selectedIds.length > 0)

function onPick(id: string) {
  emit('toggle', id)
}
</script>

<template>
  <div class="skill-pick-sheet" role="dialog" aria-modal="true" aria-label="选择技能" data-testid="skill-pick-sheet">
    <div class="sheet-head">
      <span class="sheet-title">选择技能</span>
      <button type="button" class="sheet-close" aria-label="关闭" data-testid="sheet-close" @click="emit('close')">
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
    <div class="sheet-body" data-testid="skill-pick-list">
      <button
        type="button"
        class="pick-item"
        data-testid="pick-auto"
        :class="{ 'is-active': !hasSelection }"
        @click="emit('clear')"
      >
        <span class="pick-icon pick-icon-auto">
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
          </svg>
        </span>
        <span class="pick-text">
          <span class="pick-name">自动</span>
          <span class="pick-desc">平台路由，单张/图生图优先</span>
        </span>
        <span v-if="!hasSelection" class="pick-check">✓</span>
      </button>
      <button
        v-for="skill in skills"
        :key="skill.id"
        type="button"
        class="pick-item"
        data-testid="pick-skill"
        :class="{ 'is-active': selectedIds.includes(skill.id) }"
        @click="onPick(skill.id)"
      >
        <span class="pick-icon">{{ skill.label.slice(0, 1) }}</span>
        <span class="pick-text">
          <span class="pick-name">{{ skill.label }}</span>
          <span v-if="skill.desc" class="pick-desc">{{ skill.desc }}</span>
        </span>
        <span v-if="selectedIds.includes(skill.id)" class="pick-check" data-testid="pick-checked">✓</span>
      </button>
    </div>
    <div class="sheet-foot">
      <button type="button" class="manage-btn" data-testid="manage-skills-btn" @click="emit('manage')">
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        管理技能
      </button>
    </div>
  </div>
</template>

<style scoped>
.skill-pick-sheet { display: flex; flex-direction: column; width: 272px; max-height: 360px; }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: var(--lnk-space-2) var(--lnk-space-3); border-bottom: 1px solid var(--lnk-border-subtle); }
.sheet-title { font-size: var(--lnk-text-sm); font-weight: 600; color: var(--lnk-text-primary); }
.sheet-close { appearance: none; border: 0; background: transparent; cursor: pointer; color: var(--lnk-text-muted); padding: var(--lnk-space-1); border-radius: var(--lnk-radius-sm); }
.sheet-body { flex: 1; overflow-y: auto; padding: var(--lnk-space-1) var(--lnk-space-2); }
.pick-item { display: flex; width: 100%; align-items: flex-start; gap: var(--lnk-space-2); text-align: left; padding: var(--lnk-space-2) var(--lnk-space-3); border: 0; background: transparent; cursor: pointer; font: inherit; border-radius: var(--lnk-radius-md); color: var(--lnk-text-primary); }
.pick-item:hover { background: var(--lnk-surface-canvas); }
.pick-item.is-active { background: var(--lnk-hi-bg); color: var(--lnk-hi-text); }
.pick-icon { display: flex; height: 24px; width: 24px; flex-shrink: 0; align-items: center; justify-content: center; border-radius: var(--lnk-radius-sm); background: var(--lnk-surface-canvas); font-size: var(--lnk-text-xs); font-weight: 600; color: var(--lnk-text-secondary); }
.pick-icon-auto { color: var(--lnk-accent); }
.pick-text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.pick-name { font-size: var(--lnk-text-xs); font-weight: 500; }
.pick-desc { font-size: var(--lnk-text-xs); opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-check { font-size: var(--lnk-text-xs); color: var(--lnk-accent); }
.sheet-foot { border-top: 1px solid var(--lnk-border-subtle); padding: var(--lnk-space-2) var(--lnk-space-3); }
.manage-btn { display: flex; width: 100%; align-items: center; justify-content: center; gap: var(--lnk-space-2); appearance: none; border: 1px solid var(--lnk-border-subtle); background: var(--lnk-surface-raised); color: var(--lnk-text-primary); font: inherit; font-size: var(--lnk-text-xs); cursor: pointer; padding: var(--lnk-space-2) var(--lnk-space-3); border-radius: var(--lnk-radius-md); }
.manage-btn:hover { border-color: var(--lnk-accent); color: var(--lnk-accent); }
</style>
