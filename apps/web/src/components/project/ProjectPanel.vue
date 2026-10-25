<script setup lang="ts">
/**
 * ProjectPanel · 项目抽屉（断点中立，PC 与移动端共用；2026-10-25 从 AgentSideRail 抽出）
 *
 * 形态契约：Teleport 到 body 的 sheet（移动端左侧抽屉 / PC 可复用同一形态），内含
 * 「新建项目」卡 + 项目卡片列表（打开 / 重命名 / 删除）+ 预览折叠（默认 8 条）+ 加载 /
 * 失败 / 空态。
 *
 * ⚠️ 为什么整段（含 Teleport + Transition + 容器 + 样式）一起抽：抽屉的
 * `flex-shrink:0` 防护（防 2026-10-19「项目卡被压成 1px 细线」事故）与 `.project-card`
 * 样式是**作用在本组件自己元素上**的 scoped 样式；若只抽模板而把容器/样式留在
 * AgentSideRail，scoped 边界会让这些规则够不到本组件的元素 ⇒ 防护静默失效。
 * ⇒ 本组件自带全部相关 scoped 样式（与 AgentSideRail 不再共享）。
 */
import { computed, ref } from 'vue'
import type { ProjectCard } from '@/composables/useProjectWorkspace'
import { formatSessionTime } from '@/utils/formatSessionTime'

const props = withDefaults(
  defineProps<{
    open: boolean
    projects: ProjectCard[]
    currentId: string
    loading: boolean
    error: boolean
    /**
     * 是否为**底部页签**预留空间。
     *
     * ⚠️ 56px 兜底是**移动端专属**的安全网：`--lnk-tabbar-h` 由 MobileTabBar 发布，
     *    变量未发布时也**不得回落成盖住页签**（2026-10-19「页签失灵」事故）。
     *    但 PC 根本没有页签 ⇒ 沿用兜底会：① 遮罩底部留 56px 空条（点不到 = 关不掉
     *    面板）；② 抽屉比视口矮 56px。⇒ PC 传 false 走整屏。
     */
    reserveTabbar?: boolean
  }>(),
  { reserveTabbar: true },
)

const emit = defineEmits<{
  close: []
  create: []
  open: [id: string]
  rename: [project: ProjectCard]
  remove: [project: ProjectCard]
  retry: []
}>()

/** 项目预览条数（2026-10-19 用户裁决）：默认只露最近 8 个，其余收进「展开更多」。 */
const PROJECTS_PREVIEW_COUNT = 8
const projectsExpanded = ref(false)
const visibleProjects = computed(() =>
  projectsExpanded.value ? props.projects : props.projects.slice(0, PROJECTS_PREVIEW_COUNT),
)
function toggleProjectsExpanded() {
  projectsExpanded.value = !projectsExpanded.value
}
function onOpen(id: string) {
  emit('open', id)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="session-drawer">
      <div
        v-if="open"
        class="session-drawer-layer"
        :class="{ 'is-full-bleed': !reserveTabbar }"
        data-test="project-panel"
        @click.self="emit('close')"
      >
        <div class="session-drawer" role="dialog" aria-label="项目列表">
          <!-- 「新建项目」卡（IA v3.3，2026-10-19 用户裁决）：文字左 + 圆盘加号右。 -->
          <button type="button" class="create-card" @click="emit('create')">
            <span class="create-card__label">新建项目</span>
            <span class="create-card__disc" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
                <path stroke-linecap="round" d="M12 5v14M5 12h14" />
              </svg>
            </span>
          </button>
          <p class="session-drawer__caption">项目</p>
          <div
            v-for="project in visibleProjects"
            :key="project.id"
            class="project-card"
            :class="{ 'is-current': project.id === currentId }"
          >
            <button type="button" class="project-card__main" @click="onOpen(project.id)">
              <span class="block truncate text-xs font-medium">{{ project.title || '未命名项目' }}</span>
              <span class="block text-[10px] opacity-60">{{ formatSessionTime(project.updatedAt) }}</span>
            </button>
            <button
              type="button"
              class="project-card__more"
              aria-label="重命名项目"
              @click.stop="emit('rename', project)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
                <path stroke-linecap="round" stroke-linejoin="round" d="m14.5 5.5 4 4L8 20H4v-4L14.5 5.5Z" />
              </svg>
            </button>
            <button
              type="button"
              class="project-card__more is-danger"
              aria-label="删除项目"
              @click.stop="emit('remove', project)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7m3 0-.7 12a2 2 0 0 1-2 1.9H9.2a2 2 0 0 1-2-1.9L6.5 7" />
              </svg>
            </button>
          </div>
          <!-- 「展开更多 / 收起」（2026-10-19 用户裁决）：默认预览最近 8 条，按钮与第 8 条
               同屏不折叠；剩余计数随列表长度实时变化。加载中/失败态不显示。 -->
          <button
            v-if="!loading && !error && projects.length > PROJECTS_PREVIEW_COUNT"
            type="button"
            class="session-drawer__expand"
            @click="toggleProjectsExpanded"
          >
            {{ projectsExpanded ? '收起' : `展开更多（还有 ${projects.length - PROJECTS_PREVIEW_COUNT} 个）` }}
          </button>
          <p v-if="loading" class="session-drawer__empty">项目加载中…</p>
          <p v-else-if="error" class="session-drawer__empty">
            项目加载失败
            <button type="button" class="session-drawer__retry" @click="emit('retry')">重试</button>
          </p>
          <p v-else-if="!projects.length" class="session-drawer__empty">暂无项目</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.session-drawer-layer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: var(--lnk-tabbar-h, 56px);
  z-index: 95;
  background: rgba(0, 0, 0, 0.35);
}

/* PC 形态（reserveTabbar=false）：无底部页签 ⇒ 遮罩整屏。
 * ⛔ 不用这条的话底部会留 56px 空条（--lnk-tabbar-h 未发布时的兜底值）：
 *    那条空条既点不到（关不掉面板）、抽屉又比视口矮一截。 */
.session-drawer-layer.is-full-bleed {
  bottom: 0;
}

.session-drawer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(78vw, 320px);
  padding: calc(env(safe-area-inset-top, 0px) + 14px) 12px calc(env(safe-area-inset-bottom, 0px) + 14px);
  background: var(--lnk-surface-canvas);
  overflow-y: auto;
}

/* ⛔ 2026-10-19 真机事故（移动端抽屉「项目清单看不到」）：抽屉是**定高** flex 列容器，
 * 项目卡又带 overflow:hidden ⇒ flex 规范 §4.5「自动最小尺寸」对 overflow≠visible
 * 的项归零 ⇒ flex-shrink 合法地把卡片压到 0。
 * ⇒ 抽屉直接子项一律不许收缩；溢出交给抽屉自身的 overflow-y:auto 滚动。 */
.session-drawer > * {
  flex-shrink: 0;
}

.session-drawer__caption {
  padding: 6px 4px 0;
  font-size: var(--lnk-text-xs, 12px);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lnk-text-muted);
}

/* 「新建」卡（IA v3.3，2026-10-19 用户裁决）：文字左 + 圆盘加号右。 */
.create-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 12px 12px 12px 14px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 12px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm, 13px);
  font-weight: 500;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.create-card:active {
  background: var(--lnk-accent-subtle);
}

.create-card__disc {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
}

.create-card__disc svg {
  width: 15px;
  height: 15px;
}

/* 项目卡片（IA v3.1）：主区点击=打开项目，右侧笔形=重命名，再右=删除 */
.project-card {
  display: flex;
  align-items: stretch;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 12px;
  background: var(--lnk-surface-raised);
  overflow: hidden;
}

.project-card.is-current {
  border-color: var(--lnk-accent-border);
}

.project-card__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 4px 10px 12px;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.project-card__main:active {
  background: var(--lnk-accent-subtle);
}

.project-card__more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--lnk-text-muted);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.project-card__more:active {
  background: color-mix(in srgb, var(--lnk-text-primary) 8%, transparent);
}

.project-card__more svg {
  width: 15px;
  height: 15px;
}

.project-card__more.is-danger {
  color: var(--lnk-error);
}

.session-drawer__retry {
  margin-left: 6px;
  padding: 2px 10px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 999px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-accent-text);
  font-size: var(--lnk-text-xs, 12px);
  cursor: pointer;
}

.session-drawer__empty {
  padding: 18px 4px;
  font-size: var(--lnk-text-xs, 12px);
  text-align: center;
  color: var(--lnk-text-muted);
}

/* 「展开更多 / 收起」（2026-10-19 用户裁决）：项目预览的折叠控制——轻量文字按钮。 */
.session-drawer__expand {
  display: block;
  width: 100%;
  padding: 10px 4px;
  border: none;
  background: transparent;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-xs, 12px);
  text-align: center;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.session-drawer__expand:active {
  color: var(--lnk-accent-text);
}

.session-drawer-enter-active,
.session-drawer-leave-active {
  transition: opacity 0.2s ease;
}

.session-drawer-enter-active .session-drawer,
.session-drawer-leave-active .session-drawer {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}

.session-drawer-enter-from,
.session-drawer-leave-to {
  opacity: 0;
}

.session-drawer-enter-from .session-drawer,
.session-drawer-leave-to .session-drawer {
  transform: translateX(-100%);
}
</style>
