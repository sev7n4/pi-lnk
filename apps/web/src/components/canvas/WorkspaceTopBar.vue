<script setup lang="ts">
/**
 * WEB 工作台统一顶栏（规格 §6.8）：画布路由顶部整页栏，替代原 CanvasFloatingChrome
 * （可编辑 title + 返回）与右上漂浮簇（ThemeToggle + AccountChrome）。
 * 职责：左 ‹ 返回创作空间；居中页题注「画布·「项目名称」」（§13.5 v2：细体小字、
 * 次级灰、截断）；右簇 发现/主题/账号（v3 §13.4：「我的」撤除，头像下拉全权承载个人枢纽）。
 * 项目名是上下文而非操作（§13.5 起居中题注语义），与移动端 MobileTopBar 同构。
 * §13.5（2026-10-28 真机走查四轮）：材质横带（封条）彻底退役，栏体透明。
 * 2026-10-30 用户裁决：右上「...」项目操作菜单（保存画布/发布作品/导入导出工作流，
 * 含轻量包二级）整体移除——项目级操作不属于常驻顶栏，入口后续统一重新规划
 * （三页顶栏重构规格 §6.8 v5）。
 */
import { RouterLink } from 'vue-router'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import AccountChrome from '@/components/account/AccountChrome.vue'

defineProps<{
  /** 当前项目名（规格 §6.4） */
  projectName: string
}>()

const emit = defineEmits<{
  /** ‹ 返回创作空间（/canvases） */
  'go-gallery': []
}>()
</script>

<template>
  <header class="workspace-top-bar">
    <!-- 左：‹ 返回创作空间 -->
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
    </div>

    <!-- 居中页题注（规格 §13.5）：「画布·「项目名称」」，细体小字、绝对居中、
         超长截断、非交互——取代原左置项目名（§6.4 v2）。 -->
    <span
      class="wkb-page-title"
      data-testid="workspace-project-name"
    >画布·「{{ projectName }}」</span>

    <!-- 右簇：发现/主题/账号（§13.4/D1：「我的」撤除——与头像下拉（我的主页）重复；
         ⋯ 项目菜单 2026-10-30 整体移除，入口重规划） -->
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
  /* §13.5（2026-10-28 真机走查四轮）：封条彻底退役——材质底+blur 一并去掉。
     画布节点平移穿栏时透明栏与画布同底（用户裁决：视觉不抢占），
     此前顶栏迭代 v3 保留的材质横带即用户所指「封条」。 */
  background: transparent;
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

/* 居中页题注（§13.5）：细体小字、次级灰、绝对居中（不随左右簇宽度漂移）、
   超长截断、非交互。视觉权重全栏最低——上下文标签，不是标题。 */
.wkb-page-title {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  height: 52px;
  max-width: min(48%, 360px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 300;
  color: var(--lnk-text-secondary);
  line-height: 1;
  pointer-events: none;
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
</style>
