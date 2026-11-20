<script setup lang="ts">
/** 移动端圆形「＋ FAB」：画布新建节点 / 创作空间新建项目共用同一枚视觉。
 *  2026-11-20 位置收敛：从锚页签栏的左下角改为**右下角并上移 12px**；
 *  创作空间页没有页签栏，anchor='safe' 只留安全区 + 12px（视觉仍贴右下）。
 *  空画布时呼吸微动效（设计 4.2）；48px 圆 + accent 渐变 + 白加号。 */
withDefaults(defineProps<{
  /** 空画布：呼吸微动效引导首建 */
  breathe?: boolean
  /** 无障碍标签（画布=新建节点 / 创作空间=新建项目） */
  label?: string
  /** 落位基准：tabbar=页签栏之上（画布），safe=仅安全区（创作空间） */
  anchor?: 'tabbar' | 'safe'
  /** 测试锚点（不同页面用不同 testid，便于走查定位） */
  testId?: string
}>(), {
  breathe: false,
  label: '新建节点',
  anchor: 'tabbar',
  testId: 'mobile-create-fab',
})

const emit = defineEmits<{
  click: []
}>()
</script>

<template>
  <button
    type="button"
    class="mobile-create-fab"
    :class="{ 'is-breathing': breathe, 'is-safe-anchored': anchor === 'safe' }"
    :aria-label="label"
    :data-testid="testId"
    @click="emit('click')"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <path stroke-linecap="round" d="M12 5v14M5 12h14" />
    </svg>
  </button>
</template>

<style scoped>
.mobile-create-fab {
  /* ⚠️ fixed（**不是** absolute）：页签栏 / 顶栏都是 fixed 贴**可见视口**，而 absolute 会贴
     100vh 根容器底边——移动浏览器带地址栏 + 底部工具条时 100vh 比可见视口高约 105px
     （真机实测：100vh 804px / 可见 699px）⇒ 锚底的 absolute 元素整颗掉出可见区，
     ＋FAB 直接不可见、空态文案「点右下 ＋」变成死指引。改为 fixed 与页签栏同坐标系，
     避让公式（dock-h + tabbar-h + safe-area）才真正成立。 */
  position: fixed;
  right: 12px;
  /* 2026-11-20 用户拍板：从原来的 left:12px 平移到右下角，并整体上移 12px
     （离页签栏/安全区多留一指间距，避免贴边误触）。anchor='safe' 时只留安全区。 */
  /* 窗态（composer 输入条展开）下本钮由壳层 v-if 门控不渲染：裸条 min-height 48px、
   * 左右各 12px 且贴同基线，FAB 无论左右都会压住输入条右侧的发送区（上移 12px 也只
   * 探出 12px，仍重叠 36px）。纯画布态才出现，零遮挡。
   * 另：落位不再消费 --lnk-agent-dock-h（画布视图里它是"贴底容器"高度，实测不可靠）。 */
  bottom: calc(var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 60;
  display: flex;
  width: 48px;
  height: 48px;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
  box-shadow: var(--lnk-shadow-md);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

/* 创作空间页没有页签栏（--lnk-tabbar-h 未发布）：只让开安全区 + 同一 12px 上移量。 */
.mobile-create-fab.is-safe-anchored {
  bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
}

.mobile-create-fab:active {
  transform: scale(0.92);
}

.mobile-create-fab svg {
  width: 22px;
  height: 22px;
}

/* 空画布呼吸：2.4s 一轮，尊重系统减弱动效偏好 */
.mobile-create-fab.is-breathing {
  animation: fab-breathe 2.4s ease-in-out infinite;
}

@keyframes fab-breathe {
  0%,
  100% {
    box-shadow: var(--lnk-shadow-md), 0 0 0 0 color-mix(in srgb, var(--lnk-accent) 34%, transparent);
  }
  50% {
    box-shadow: var(--lnk-shadow-md), 0 0 0 8px color-mix(in srgb, var(--lnk-accent) 0%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mobile-create-fab.is-breathing {
    animation: none;
  }
}
</style>
