<script setup lang="ts">
/** 移动端应用骨架 · 顶栏（2026-10-19 IA v3.2 对话驱动叙事）：
 * 【对话】页签 = [≡ 左上·项目抽屉] [积分] [+ 新对话] [🕘 历史对话]（右侧）；
 * 【画布】页签 = [积分] [⋯ 画布管理菜单（任务动态项：有任务才出现；PR4 起按频次重排，
 *   「保存画布」移除改自动保存状态行，导出带二级）]；
 * 【发现】【我的】= 透明占位（保持 --lnk-topbar-h 高度一致，不放任何入口）。
 * 2026-10-19 用户裁决：顶栏「未命名画布」标题输入整体移除——对话驱动叙事下
 * 顶栏不放画布名；项目重命名入口在抽屉项目卡片菜单。
 * IA v3.2（用户拍板「推荐方案」）：新建对话/历史对话从抽屉移出，升为对话页
 * 右上角常驻图标——抽屉=项目世界（容器层），右上角=当前项目的对话世界
 * （内容层），职责边界一眼可读；全局积分双页签（对话/画布）可见。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useClickOutside } from '@/composables/useClickOutside'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{
  tab: 'chat' | 'canvas' | 'discover' | 'mine'
  /** 画布页签：运行中/排队中的任务数（顶栏 ⋯ 动态项徽标） */
  taskActiveCount?: number
  /** 画布页签：是否存在任何任务记录（无任务时动态项不出现） */
  hasTaskHistory?: boolean
}>()

const emit = defineEmits<{
  'open-drawer': []
  'new-chat': []
  'open-history': []
  publish: []
  'import-workflow': []
  'export-workflow': []
  /** PR4：导出二级——轻量包（不含媒体） */
  'export-workflow-light': []
  'open-tasks': []
}>()

const auth = useAuthStore()

const menuOpen = ref(false)
const exportOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

const isGhost = computed(() => props.tab === 'discover' || props.tab === 'mine')

/** 任务动态项（D-2 入口收敛）：有任务才出现；运行中/排队带计数徽标 */
const showTaskItem = computed(() => props.tab === 'canvas' && props.hasTaskHistory === true)
const taskItemLabel = computed(() =>
  props.taskActiveCount && props.taskActiveCount > 0 ? `任务（${props.taskActiveCount}）` : '任务',
)

/** 全局积分：登录态才显示（对话页/画布页都要能看见余额） */
const pointsText = computed(() => (auth.user?.points ?? 0).toLocaleString('en-US'))
const showPoints = computed(() => auth.isLoggedIn)

function closeMenu() {
  menuOpen.value = false
  exportOpen.value = false
}

useClickOutside(menuRef, closeMenu)

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (!menuOpen.value) exportOpen.value = false
}

function onMenuItem(action: 'publish' | 'import' | 'export' | 'export-light' | 'task') {
  menuOpen.value = false
  exportOpen.value = false
  if (action === 'publish') emit('publish')
  else if (action === 'import') emit('import-workflow')
  else if (action === 'export') emit('export-workflow')
  else if (action === 'export-light') emit('export-workflow-light')
  else emit('open-tasks')
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
  <!-- ⭐ IA v3.1 修复：顶栏须 teleport 到 body，否则被 <MAIN class="relative z-10"> 创建的
       堆叠上下文困住（顶栏 z-85 实际低于 teleport 到 body 的会话面板 z-70），导致对话视图下
       面板不透明背景盖住 ≡、点击穿透到面板，抽屉打不开。与抽屉/面板同走 body 层保证
       z 序：抽屉(95) > 顶栏(85) > 面板(70)。 -->
  <Teleport to="body">
    <header class="mobile-top-bar" :class="{ 'is-ghost': isGhost, 'is-chat': props.tab === 'chat' }">
    <!-- 对话页签：左上 ≡ 会话抽屉（项目世界唯一入口） -->
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

    <!-- 右侧工具簇：积分（双页可见）→ 对话页 +/🕘 ｜ 画布页 ⋯ 菜单 -->
    <div class="bar-actions">
      <span
        v-if="showPoints"
        class="bar-points tabular-nums"
        :title="`我的积分 ${auth.user?.points ?? 0}`"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path stroke-linecap="round" d="M12 8v8M9.5 10.5h5M9.5 13.5h5" />
        </svg>
        {{ pointsText }}
      </span>

      <template v-if="props.tab === 'chat'">
        <!-- 「新建对话」卡（IA v3.3，2026-10-19 用户裁决）：与抽屉「新建项目」
             同族 create-card 的顶栏紧凑变体——胶囊承托 + 右侧小圆盘加号。 -->
        <button
          type="button"
          class="create-card create-card--bar"
          title="新建对话"
          @click="emit('new-chat')"
        >
          <span class="create-card__label">新建对话</span>
          <span class="create-card__disc" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" d="M12 5v14M5 12h14" />
            </svg>
          </span>
        </button>
        <button
          type="button"
          class="bar-btn"
          aria-label="对话历史"
          @click="emit('open-history')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <circle cx="12" cy="12" r="9" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3 2" />
          </svg>
        </button>
      </template>

      <!-- 画布页签：⋯ 画布管理菜单 -->
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
          <!-- 任务（D-2）：从竖轨移入的动态项，有任务才出现 -->
          <button
            v-if="showTaskItem"
            type="button"
            class="bar-menu-item"
            data-testid="bar-menu-task"
            @click="onMenuItem('task')"
          >
            {{ taskItemLabel }}
          </button>
          <!-- PR4（设计 §4.1）：按移动频次重排 ——发布 / 分镜 / 导出（默认完整包，
               轻量与媒体清单进二级）/ 导入；「保存画布」移除（移动端本就是自动保存，
               状态行 MobileSaveStatus 如实告知，点按仍可手动存）。 -->
          <button type="button" class="bar-menu-item" @click="onMenuItem('publish')">发布作品</button>
          <button
            type="button"
            class="bar-menu-item bar-menu-item--parent"
            data-testid="bar-menu-export"
            :aria-expanded="exportOpen"
            @click.stop="exportOpen = !exportOpen"
          >
            <span>导出工作流</span>
            <svg class="bar-menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div v-if="exportOpen" class="bar-menu-sub" data-testid="bar-menu-export-sub">
            <button type="button" class="bar-menu-item" @click="onMenuItem('export')">完整工作流包</button>
            <button type="button" class="bar-menu-item" @click="onMenuItem('export-light')">轻量包（不含媒体）</button>
          </div>
          <button type="button" class="bar-menu-item" @click="onMenuItem('import')">导入工作流</button>
        </div>
      </div>
    </div>
    </header>
  </Teleport>
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

/* 对话页：≡ 贴左上角（2026-10-19 用户裁决——抽屉自左滑出，触发器同侧）；
 * 画布页 ⋯ 菜单保持贴右。 */
.mobile-top-bar.is-chat {
  justify-content: flex-start;
}

.bar-btn {
  position: relative;
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

/* 34px 视觉钮 + 隐形 44px 热区（T-6，与 agent-hit-expand 同模式） */
.bar-btn::after {
  content: '';
  position: absolute;
  inset: -5px;
}

.bar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

/* 「新建对话」卡：create-card 家族的顶栏紧凑变体（抽屉「新建项目」同族，
 * AgentSideRail.vue 各自 scoped 定义）。胶囊承托文字 + accent 圆盘白加号，
 * 与积分胶囊、🕘 图标按钮在 44px 顶栏内纵向居中对齐。 */
.create-card--bar {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  flex-shrink: 0;
  padding: 0 4px 0 11px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 999px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.create-card--bar:active {
  background: var(--lnk-accent-subtle);
}

.create-card--bar .create-card__label {
  white-space: nowrap;
}

.create-card--bar .create-card__disc {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
}

.create-card--bar .create-card__disc svg {
  width: 11px;
  height: 11px;
}

/* 全局积分胶囊：对话/画布双页可见，登录态才渲染 */
.bar-points {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  margin-right: 2px;
  padding: 0 9px 0 7px;
  border-radius: 999px;
  border: 0.5px solid var(--lnk-border-subtle);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-secondary);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.bar-points svg {
  width: 13px;
  height: 13px;
  color: var(--lnk-accent-text);
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
  display: flex;
  width: 100%;
  min-height: var(--lnk-touch-target);
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  padding: 0 14px;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-xs, 12px);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

/* 导出二级：缩进 + 左侧细线，视觉上从属于父项（PR4） */
.bar-menu-sub {
  margin: 2px 0 2px 10px;
  padding-left: 6px;
  border-left: 1px solid var(--lnk-border-subtle);
}

.bar-menu-chevron {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--lnk-text-muted);
}

.bar-menu-item:active {
  background: color-mix(in srgb, var(--lnk-text-primary) 8%, transparent);
}
</style>
