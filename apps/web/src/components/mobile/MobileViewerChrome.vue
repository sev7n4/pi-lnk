<script lang="ts">
/** chrome 动作项（viewer 侧映射：edit→pencil / annotate→marker / tts→speaker|stop） */
export interface MobileViewerChromeAction {
  key: string
  label: string
  icon: 'pencil' | 'marker' | 'speaker' | 'stop'
}
</script>

<script setup lang="ts">
/**
 * 查看 chrome（规格 v1.5 §4.12.4 / §4.12.5，拍板项 P · §9 #35）。
 *
 * 职责：渲染查看器的全部常驻 UI——右上 X + 底部**自隐迷你操作条**。
 * chrome 随「点按媒体」整体显隐（对标 iOS Photos）；隐藏态下滑/上滑关闭
 * 恒可用（P3 不依赖 chrome，手势在 viewer 根容器上）。
 *
 * 形态判据（§4.12.5，实施不得自由发挥）：
 *  - 条 = **半透明模糊材质**胶囊（`--lnk-surface-glass` + `--lnk-glass-blur`），
 *    ⛔ 禁实心大色块（旧通栏紫卡退役）；
 *  - 每项 = **图标 22×22 + 11pt 标签**纵向排布，命中区 ≥44×44px（G-18/G-24）；
 *  - 条总高 ≤56px（44px 项 + 2×4px padding）；
 *  - 淡入淡出 160–200ms（`--lnk-duration-base`），`prefers-reduced-motion` 直切；
 *  - 图标一律内联 SVG（24 网格 stroke-2，G-16）；
 *  - 模板为**双根 fragment**（X + 条）：条与 `.viewer-body` 同层（文档流兄弟，
 *    回归③④的结构契约不能丢）。
 */

withDefaults(
  defineProps<{
    /** chrome 可见性（viewer 持有状态，点按媒体翻转） */
    visible?: boolean
    actions?: MobileViewerChromeAction[]
  }>(),
  { visible: true, actions: () => [] },
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'action', key: string): void
}>()
</script>

<template>
  <!-- 右上角 X（唯一常驻图标，随 chrome 显隐；式样与编辑 sheet 同款） -->
  <button
    class="mv-chrome-close"
    :class="{ 'chrome-hidden': !visible }"
    type="button"
    aria-label="关闭"
    data-testid="mobile-viewer-close"
    @click="emit('close')"
  >
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
    </svg>
  </button>

  <!-- 底部迷你操作条（毛玻璃胶囊；两态同几何：查看态 / 编辑·标注任务态） -->
  <div
    v-if="actions.length"
    class="viewer-bottom-actions mv-chrome-bar"
    :class="{ 'chrome-hidden': !visible }"
    data-testid="mobile-viewer-chrome-bar"
  >
    <button
      v-for="a in actions"
      :key="a.key"
      type="button"
      class="mv-chrome-item"
      :data-action="a.key"
      :data-testid="`mobile-viewer-bottom-${a.key}`"
      @click="emit('action', a.key)"
    >
      <svg
        v-if="a.icon === 'pencil'"
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
      <svg
        v-else-if="a.icon === 'marker'"
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <ellipse cx="12" cy="14" rx="8" ry="5.5" />
        <path d="M18.5 3.5l2 2-6.5 6.5-2.8.8.8-2.8Z" />
      </svg>
      <svg
        v-else-if="a.icon === 'stop'"
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
      </svg>
      <svg
        v-else
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      </svg>
      <span class="mv-chrome-item-label">{{ a.label }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 右上 X：44px 触控热区；随 chrome 整体淡出（G-20） */
.mv-chrome-close {
  position: absolute;
  top: calc(env(safe-area-inset-top) + var(--lnk-space-2));
  right: var(--lnk-space-2);
  z-index: 4;
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mv-chrome-close:active {
  background: var(--lnk-pressed-overlay);
}

/* 迷你操作条：居中毛玻璃胶囊（§4.12.5）——⛔ 实心大色块退役 */
.viewer-bottom-actions {
  /* 文档流兄弟（回归③④契约）：column 容器默认 stretch ⇒ 收窄居中 */
  align-self: center;
  display: flex;
  gap: var(--lnk-space-5);
  padding: var(--lnk-space-1) var(--lnk-space-5)
    calc(var(--lnk-space-1) + env(safe-area-inset-bottom, 0px));
  border: 0.5px solid var(--lnk-glass-topline);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-glass);
  -webkit-backdrop-filter: blur(var(--lnk-glass-blur)) saturate(160%);
  backdrop-filter: blur(var(--lnk-glass-blur)) saturate(160%);
}

.mv-chrome-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: var(--lnk-touch-target);
  min-height: var(--lnk-touch-target);
  padding: 0 var(--lnk-space-1);
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mv-chrome-item:active {
  color: var(--lnk-text-secondary);
}

.mv-chrome-item svg {
  width: 22px;
  height: 22px;
}

.mv-chrome-item-label {
  white-space: nowrap;
}

/* 显隐动效：160–200ms ease-out；reduced-motion 直切（HIG Reduce Motion） */
.mv-chrome-close,
.viewer-bottom-actions {
  transition: opacity var(--lnk-duration-base) var(--lnk-ease-decelerate);
}

.chrome-hidden {
  opacity: 0;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .mv-chrome-close,
  .viewer-bottom-actions {
    transition: none;
  }
}
</style>
