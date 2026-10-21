<script setup lang="ts">
/** 移动端画布「＋ FAB」（2026-10-19 D-2）：取代左侧竖轨的唯一新建入口。
 *  位置贴 dock/composer 之上（与 MobileMultiSelectBar 同一清位公式，
 *  复用运行时发布的 --lnk-agent-dock-h / --lnk-tabbar-h），不叠 z。
 *  空画布时呼吸微动效（设计 4.2）；48px 圆 + accent 渐变 + 白加号。 */
defineProps<{
  /** 空画布：呼吸微动效引导首建 */
  breathe?: boolean
}>()

const emit = defineEmits<{
  click: []
}>()
</script>

<template>
  <button
    type="button"
    class="mobile-create-fab"
    :class="{ 'is-breathing': breathe }"
    aria-label="新建节点"
    data-testid="mobile-create-fab"
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
     ＋FAB 直接不可见、空态文案「点左下 ＋」变成死指引。改为 fixed 与页签栏同坐标系，
     避让公式（dock-h + tabbar-h + safe-area）才真正成立。 */
  position: fixed;
  left: 12px;
  /* 2026-10-21 真机走查（定稿）：落位只锚页签栏 + 安全区，与 composer 裸条**同一基线**。
   *
   * 尺寸计算（为什么窗态「盖住」而不是「并排/位移微调」）：
   *   裸条 = composer-bare-bar，min-height 48px、左右各 12px（贴底容器 left/right:12）、
   *          bottom = safe-area + --lnk-tabbar-h；
   *   ＋FAB = 48×48、left 12px、bottom 同上基线。
   *   ⇒ 两者矩形**完全重合**（FAB ⊂ 裸条），横向无内缩余量、竖向余量为 0
   *      （48 = 48）。所以：
   *      · 向右位移只能盖住左侧 bleed、盖不住 FAB 自身 box-shadow 的上/左外扩；
   *      · 向上位移必然从裸条顶边探出（竖向余量为 0）；
   *      · 想靠位移"完全盖住且无阴影残留"，需裸条 ≥ 48 + 2×8 = 64px（多吃 16px 画布）。
   *   ⇒ 结论：几何上唯一自洽解 = 窗态（有 composer）下 ＋FAB 不渲染（由壳层 v-if 门控），
   *      纯画布态（composer 收起）才出现。视觉上正是「被 composer 盖住」，且零残留。
   *
   * 另：原公式含 --lnk-agent-dock-h（composer 高度）时该变量在画布视图发布的是
   * 「贴底容器」高度（不可靠，常为 0）⇒ 曾把 FAB 压到裸条上只剩一个月牙。 */
  bottom: calc(var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px));
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
