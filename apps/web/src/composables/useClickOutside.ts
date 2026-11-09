import { onBeforeUnmount, onMounted, type Ref } from 'vue'

/**
 * 点击目标元素外部时触发回调（capture 阶段监听，避免被画布 stopPropagation 拦截）。
 * 用于各类弹出卡片点击空白自动收起。
 */
export function useClickOutside(
  target: Ref<HTMLElement | null>,
  handler: () => void,
  extraTargets: Ref<HTMLElement | null>[] = [],
) {
  function onPointerDown(event: PointerEvent) {
    const node = event.target as Node | null
    if (!node) return
    // 2026-11-09 真机修复 #1：附件卡 / 遮罩经 Teleport 移到 body（脱离面板堆叠上下文，
    // 才能以 z-90/85 在根上下文高于页签 z-80 完整弹出）。Teleport 后卡不再是 target 的 DOM 后代，
    // 故把卡 ref 也纳入「内部」判定，否则点卡内会误判为外部而关闭。
    const els = [target.value, ...extraTargets.map((t) => t.value)]
    if (els.some((el) => el && el.contains(node))) return
    handler()
  }

  onMounted(() => document.addEventListener('pointerdown', onPointerDown, true))
  onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown, true))
}
