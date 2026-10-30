<script setup lang="ts">
/** 移动端应用骨架 · 顶栏（2026-10-19 IA v3.2 对话驱动叙事；2026-10-23 IA v4）：
 * 【对话】页签 = [‹ 返回创作空间]（右簇空；⋯ 项目菜单 2026-10-30 整体移除，入口重规划）；
 * 【画布】页签 = [‹ 返回创作空间] [⤢ 适应画布]（右簇仅此一枚；⋯ 项目菜单同日移除）；
 * 【发现】【我的】= 透明占位（保持 --lnk-topbar-h 高度一致，不放任何入口）。
 * 2026-10-19 用户裁决：顶栏「未命名画布」标题输入整体移除——对话驱动叙事下
 * 顶栏不放画布名；项目重命名入口在抽屉项目卡片菜单。
 * IA v3.2（用户拍板「推荐方案」）：新建对话/历史对话从抽屉移出，升为对话页
 * 右上角常驻图标——抽屉=项目世界（容器层），右上角=当前项目的对话世界
 * （内容层），职责边界一眼可读。
 * IA v4（2026-10-23 用户裁决）：① 「新建对话」→「新对话」（线程级），与抽屉
 * 「新建项目」（项目级）拉开级差；② 品牌字标可点回 hero——壳层在项目页内，
 * 没有这条路就回不了前门；③ 「画布管理菜单」→「项目管理菜单」（项目语义收口）。
 * 2026-10-21 用户裁决：积分胶囊撤出顶栏（对话/画布双页）——积分是账户属性
 * 非任务上下文，「我的」页已有同一数字（信息重复）；余额在「我的-我的积分」
 * 与花销时刻（状态行预估/充值入口）展示。
 * 2026-10-28 真机走查四轮（规格 §13.5）：① 画布页签去封条（材质横带退役，
 * is-canvas-bare）；② 居中页题注「对话·「项目名称」」/「画布·「项目名称」」
 * （细体 12px 次级灰，取代左置 15px 项目名，§6.4 v2）；③ 对话页顶栏被
 * 对话面板（裸 z:70）反盖的回归在 AgentSideRail 侧修（面板降到 chrome 之下）。
 * 2026-10-30 用户裁决：⋯ 项目菜单（发布/导出/导入/任务，chat+canvas 共用）
 * 整体移除——项目级操作不属于对话/画布页签顶栏，入口后续统一重新规划
 * （三页顶栏重构规格 §6.2/§6.3/§6.8 v5）。 */
import { computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  tab: 'chat' | 'canvas' | 'discover' | 'mine'
  /** 当前项目名（规格 §6.4：次级灰、15px、超长截断、非交互） */
  projectName: string
}>()

const emit = defineEmits<{
  /** 规格 §6.2/§6.3：‹ 返回创作空间（chat + canvas 共用） */
  'go-gallery': []
  /** 规格 §6.3：⤢ 适应画布（canvas 分支，经壳层桥接到 VueFlow fitView） */
  'fit-view': []
}>()

const isGhost = computed(() => props.tab === 'discover' || props.tab === 'mine')

/** 画布页签去封条（2026-10-28 真机走查四轮）：材质横带在画布底色上是一根「封条」。
 *  对话页签保留材质——对话流 padding-top 16px < 栏高 44px，内容从栏下穿过，
 *  透明栏会让正文顶进题注区；画布页签无滚动内容依赖（节点平移本就穿栏，用户裁决去材质）。 */
const isCanvasBare = computed(() => props.tab === 'canvas')

/** 居中页题注（2026-10-28 真机走查四轮）：「对话·「项目名称」」/「画布·「项目名称」」。
 *  细体小字次级灰——上下文标签而非标题，不抢占内容视觉（iOS 导航栏 center 隐喻）。 */
const pageTitle = computed(() => {
  if (props.tab !== 'chat' && props.tab !== 'canvas') return ''
  const label = props.tab === 'canvas' ? '画布' : '对话'
  return `${label}·「${props.projectName}」`
})

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
    <header
      class="mobile-top-bar"
      :class="{ 'is-ghost': isGhost, 'is-canvas-bare': isCanvasBare }"
    >
      <!-- 返回创作空间（chat + canvas 共用；规格 §6.2/§6.3）：chevron(<) + 文案「创作空间」 -->
      <button
        v-if="props.tab === 'chat' || props.tab === 'canvas'"
        type="button"
        class="bar-back"
        data-testid="mobile-topbar-back"
        aria-label="返回创作空间"
        @click="emit('go-gallery')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 18l-6-6 6-6" />
        </svg>
        <span class="bar-back__label">创作空间</span>
      </button>

      <!-- 居中页题注（规格 §13.5）：「对话·「项目名称」」/「画布·「项目名称」」，
           细体小字、绝对居中、超长截断、非交互——取代原左置项目名（§6.4 v2） -->
      <span
        v-if="pageTitle"
        class="topbar-page-title"
        data-testid="mobile-topbar-project-name"
      >{{ pageTitle }}</span>

      <!-- 右侧工具簇 -->
      <div class="bar-actions">
        <!-- 画布：⤢ 适应画布（规格 §6.3，经壳层桥接 VueFlow fitView） -->
        <button
          v-if="props.tab === 'canvas'"
          type="button"
          class="bar-btn"
          data-testid="mobile-topbar-fit"
          aria-label="适应画布"
          @click="emit('fit-view')"
        >
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
          </svg>
        </button>
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
  z-index: var(--lnk-z-chrome);
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  height: calc(44px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) 10px 0;
  background: var(--lnk-surface-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  /* §13.1/A1：发丝线退役（封条感主源）；对话/画布内容穿栏（shell 对话流
     padding-top 16px < 栏高 44px）⇒ 材质底+blur 保留，is-ghost 机制不变 */
  transform: translateZ(0);
}

/* 发现/我的：透明占位——只撑高度，不放入口、不挡视觉 */
.mobile-top-bar.is-ghost {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  pointer-events: none;
}

/* 画布页签：去封条（§13.5）——材质横带在画布底色上是一根「封条」，整条退役。
   画布节点平移本就穿栏，透明栏与画布同底，无信息被遮。 */
.mobile-top-bar.is-canvas-bare {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
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

/* 返回创作空间簇（chevron + 文案「创作空间」）：栏内主操作，主色（规格 §6.2/§6.3） */
.bar-back {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  height: 34px;
  padding: 0 4px 0 2px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.bar-back::after {
  content: '';
  position: absolute;
  inset: -5px;
}
.bar-back svg {
  width: 20px;
  height: 20px;
}
.bar-back__label {
  font-size: 15px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

/* 居中页题注（§13.5）：细体小字、次级灰、绝对居中（不随左右簇宽度漂移）、
   超长截断、非交互。视觉权重全栏最低——上下文标签，不是标题。 */
.topbar-page-title {
  position: absolute;
  top: env(safe-area-inset-top, 0px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  height: 44px;
  max-width: min(52%, 240px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 300;
  color: var(--lnk-text-secondary);
  line-height: 1;
  pointer-events: none;
}

/* 品牌字标（IA v4 2026-10-23）：回工作台 hero 的常驻路。用字标不用墨鱼图标——
   作品带首卡同款克制（「不要太多墨鱼」），π 用品牌紫点睛。 */
.bar-brand {
  display: inline-flex;
  height: 28px;
  flex-shrink: 0;
  align-items: center;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.bar-brand__pi {
  margin-left: 1px;
  color: var(--lnk-accent-text);
}

/* 「新建对话」卡：create-card 家族的顶栏紧凑变体（抽屉「新建项目」同族，
 * AgentSideRail.vue 各自 scoped 定义）。胶囊承托文字 + accent 圆盘白加号，
 * 与🕘 图标按钮在 44px 顶栏内纵向居中对齐。 */
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

.bar-btn:active {
  background: color-mix(in srgb, var(--lnk-text-primary) 8%, transparent);
}

.bar-btn svg {
  width: 19px;
  height: 19px;
}
</style>
