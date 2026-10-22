<script setup lang="ts">
/**
 * 移动端节点交互范式反转的一次性引导（2026-10-22 R1-T7）：
 * 「点按播放 · 长按编辑」——首进画布显示一次，关闭后写 localStorage 标记。
 *
 * 为什么 setup 期同步读（而非 onMounted）： SSR/hydration 无关场景下，
 * onMounted 前会先渲染一帧引导 ⇒ 已看过用户也会看到闪一下。同步读零闪。
 */
import { ref } from 'vue'

const KEY = 'mobile-node-coach-seen'

function hasSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    // 隐私模式等 localStorage 不可用：当作没看过（每次显示，宁可烦一分不漏引导）
    return false
  }
}

const seen = ref(hasSeen())

function dismiss() {
  seen.value = true
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* 写不进去也照样收起（内存态已生效） */
  }
}
</script>

<template>
  <div v-if="!seen" class="coach-mark" role="status">
    <p class="coach-text">点按播放 · 长按编辑</p>
    <button class="coach-close" type="button" aria-label="知道了" @click="dismiss">知道了</button>
  </div>
</template>

<style scoped>
.coach-mark {
  position: fixed;
  left: 50%;
  bottom: calc(var(--lnk-space-6) + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 70;
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2) var(--lnk-space-3);
  border-radius: var(--lnk-radius-full, 999px);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  box-shadow: var(--lnk-shadow-float, 0 4px 16px rgb(0 0 0 / 0.18));
  box-sizing: border-box;
}

.coach-text {
  margin: 0;
  font-size: var(--lnk-text-sm);
  line-height: 1.4;
}

.coach-close {
  min-height: var(--lnk-touch-target);
  padding: 0 var(--lnk-space-2);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-accent);
  color: var(--lnk-on-accent, #fff);
  font-size: var(--lnk-text-sm);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
</style>
