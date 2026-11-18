<script setup lang="ts">
/**
 * P3 技能选择 sheet（UI 美化 §4.2 后为「纯内容」）：`+` →【技能】弹出。
 * 数据源由宿主传入 dockSkills（单一事实源，禁独立拉取/硬编码——规格 §4.5 N1 靶点）；
 * 选中语义 = toggle 胶囊（已选再点 = 移除）；底部固定【管理技能】入口（C6）。
 * 「自动」项 = 清空全部胶囊（平台路由，等价旧 activeSkillId=null）。
 * ⚠️ 标题/遮罩/关闭由宿主提供：移动端 MobileSheet，PC 锚定 popover 的 head；本组件不再自带。
 */
import { computed } from 'vue'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'

export interface PickSkillItem {
  id: string
  label: string
  desc?: string
}

const props = withDefaults(
  defineProps<{
    skills: PickSkillItem[]
    selectedIds: string[]
    /** 二轮 R2（2026-11-18）：宿主为 MobileSheet 时置 true——内层滚动降级为内容流，
     *  单一滚动容器（m-sheet-body 独担），消灭触摸滑动死区（嵌套滚动 + overscroll contain）。 */
    embedded?: boolean
  }>(),
  { embedded: false },
)

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
  <div class="skill-pick-sheet" :class="{ embedded: props.embedded }" role="dialog" aria-modal="true" aria-label="选择技能" data-testid="skill-pick-sheet">
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
        <span v-if="!hasSelection" class="pick-check" aria-hidden="true">✓</span>
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
        <BrandPatternAvatar :seed="skill.id" :name="skill.label" size="sm" />
        <span class="pick-text">
          <span class="pick-name">{{ skill.label }}</span>
          <span v-if="skill.desc" class="pick-desc" :title="skill.desc">{{ skill.desc }}</span>
        </span>
        <span v-if="selectedIds.includes(skill.id)" class="pick-check" data-testid="pick-checked" aria-hidden="true">✓</span>
      </button>
    </div>
    <div class="sheet-foot">
      <button type="button" class="manage-btn" data-testid="manage-skills-btn" @click="emit('manage')">
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>管理技能</span>
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 manage-arrow" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.skill-pick-sheet { display: flex; flex-direction: column; width: 100%; min-width: 0; min-height: 0; gap: var(--lnk-space-1); } /* min-width:0：三次修复 R2，禁 min-content 传导撑爆 PC 锚定卡；min-height:0：作为 max-h 卡片的 flex 子项允许收缩，否则内容溢出、管理入口被顶出视口（#950 生产复测） */
.sheet-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; } /* min-height:0：flex 子项默认 min-height:auto 不收缩，滚动区失效 */
/* 二轮 R2（2026-11-18）：MobileSheet 宿主时内层降级为纯内容流——嵌套滚动容器 + overscroll:contain
   会吞掉触摸手势（外层收不到 ⇒ 移动端滑动死区，实测两次真手势 scrollTop 恒 0）；滚动权移交 m-sheet-body。 */
.skill-pick-sheet.embedded .sheet-body { overflow-y: visible; overscroll-behavior: auto; }
.pick-item { display: flex; width: 100%; min-width: 0; min-height: var(--lnk-touch-target); align-items: center; gap: var(--lnk-space-3); text-align: left; padding: var(--lnk-space-2) var(--lnk-space-3); border: 0; background: transparent; cursor: pointer; font: inherit; border-radius: var(--lnk-radius-md); color: var(--lnk-text-primary); } /* min-width:0：二轮 R1 约束链，禁 min-content 撑爆宿主卡宽 */
.pick-item:hover { background: var(--lnk-surface-canvas); }
/* 主题稳定的强调淡底——⛔ 不用 --lnk-hi-bg/hi-text（随主题翻转，深主题变黑底） */
.pick-item.is-active { background: var(--lnk-accent-subtle); color: var(--lnk-accent-text); }
.pick-icon { display: flex; height: 32px; width: 32px; flex-shrink: 0; align-items: center; justify-content: center; border-radius: var(--lnk-radius-md); background: var(--lnk-surface-canvas); font-size: var(--lnk-text-xs); font-weight: var(--lnk-weight-semibold); color: var(--lnk-text-secondary); }
.pick-icon-auto { color: var(--lnk-accent-text); }
.pick-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.pick-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--lnk-text-sm); font-weight: var(--lnk-weight-medium); }
.pick-desc { font-size: var(--lnk-text-2xs); color: var(--lnk-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-check { display: flex; width: 20px; height: 20px; flex: none; align-items: center; justify-content: center; border-radius: var(--lnk-radius-full); background: var(--lnk-accent); color: var(--lnk-surface-raised); font-size: var(--lnk-text-2xs); }
.sheet-foot { border-top: 1px solid var(--lnk-border-subtle); padding-top: var(--lnk-space-2); }
.manage-btn { display: flex; width: 100%; min-height: var(--lnk-touch-target); align-items: center; justify-content: center; gap: var(--lnk-space-2); appearance: none; border: 1px solid var(--lnk-accent-border); background: var(--lnk-accent-subtle); color: var(--lnk-accent-text); font: inherit; font-size: var(--lnk-text-sm); font-weight: var(--lnk-weight-medium); cursor: pointer; padding: var(--lnk-space-2) var(--lnk-space-3); border-radius: var(--lnk-radius-md); }
.manage-btn:active { background: var(--lnk-pressed-overlay); }
.manage-arrow { margin-left: auto; }
</style>
