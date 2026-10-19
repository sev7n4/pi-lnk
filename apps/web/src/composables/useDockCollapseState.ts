import { computed, ref, type Ref } from 'vue'

/**
 * studio dock 的收缩态状态机（2026-10-20 PR3 / D-7）。
 *
 * PC：收缩态靠悬停展开、划走收回（2026-09-25 用户拍板，行为逐字保留）。
 * 移动端：触屏没有 hover ⇒ 底部把手指条 tap 切换折叠/展开（同 iOS 抽屉把手），
 *     展开态底部给一条对称的收起把手。
 *
 * 两条展开通道互斥（按断点二选一），避免桌面端残留的合成 mouseenter 把移动端
 * 的 tap 展开顶掉。生成中/锁定态一律不收缩（宿主语义，`generating` 优先）。
 */
export function useDockCollapseState(opts: {
  /** 宿主要求收缩（节点编辑浮层激活等） */
  collapsed: Ref<boolean>
  /** 生成中/锁定：不许收缩 */
  generating: Ref<boolean>
  /** ≤767px 走 tap 通道 */
  isMobile: Ref<boolean>
}) {
  const hoverOpen = ref(false)
  const tapOpen = ref(false)

  const collapsedNow = computed(
    () =>
      opts.collapsed.value &&
      !opts.generating.value &&
      !(opts.isMobile.value ? tapOpen.value : hoverOpen.value),
  )

  /** 收缩态把手点按：移动端切换 tap 展开，PC 走悬停（点按亦展开，无害） */
  function onCollapsedHit() {
    if (opts.isMobile.value) tapOpen.value = !tapOpen.value
    else hoverOpen.value = true
  }

  /** 移动端展开态的收起把手 */
  function collapseByTap() {
    tapOpen.value = false
  }

  return { hoverOpen, tapOpen, collapsedNow, onCollapsedHit, collapseByTap }
}