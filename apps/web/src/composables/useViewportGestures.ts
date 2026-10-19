import { computed, type Ref } from 'vue'

/**
 * VueFlow 视口手势配置的单一出处（2026-10-19 移动端画布重构 D-3）。
 *
 * 背景（P0-1，代码级实证 @vue-flow/core 1.48.2 vue-flow-core.mjs）：
 *   L8571 d3-zoom filter —— `Array.isArray(panOnDrag) && !panOnDrag.includes(eventButton)
 *   && (mousedown || touchstart) ⇒ return false`。PC 配置 `panOnDrag=[1,2]`（中/右键平移）
 *   是数组，而 TouchEvent 没有 `button` 字段（`eventButton` 为 undefined）⇒ 触屏
 *   touchstart 全部被 filter 拒绝 ⇒ d3-zoom 不挂手势 ⇒ **单指拖空白不能平移、
 *   双指捏合不能缩放**，移动端画布导航只剩缩放胶囊。
 *
 * 修法：按断点分流 —— 移动端 `panOnDrag=true`（布尔，不过 L8571 的数组分支），
 * 单指拖空白 = 平移（拖节点仍走 useDrag 的 nopan class 互斥，见 core L9571），
 * 双指捏合 = 缩放（zoomOnPinch 默认 true）；框选（selectionKeyCode）在移动端
 * 关闭，多选改由应用层「选择模式」驱动（长按节点 → 多选 → 点选切换）。
 *
 * ⚠️ PC 分支逐字保持现状（`[1,2]` + `selectionKeyCode=true` + `panOnScroll`），
 * 任何 PC 行为变更都不允许走这里。
 */
export interface ViewportGestureProps {
  panOnDrag: boolean | number[]
  selectionKeyCode: string | boolean | null
  zoomOnPinch: boolean
  panOnScroll: boolean
}

export function useViewportGestures(
  isMobileLayout: Ref<boolean>,
  viewLocked: Ref<boolean>,
): Ref<ViewportGestureProps> {
  return computed<ViewportGestureProps>(() => {
    // 锁定态：全端一致——禁平移/框选/滚轮缩放（pinch 保留是 d3 默认，锁定只锁交互入口）
    if (viewLocked.value) {
      return { panOnDrag: false, selectionKeyCode: null, zoomOnPinch: true, panOnScroll: false }
    }
    if (isMobileLayout.value) {
      // 移动端：单指=平移、双指=缩放；放弃拖拽框选（与平移互斥，且移动端无 Shift 键）
      return { panOnDrag: true, selectionKeyCode: null, zoomOnPinch: true, panOnScroll: false }
    }
    // PC：左键框选 / 中右键平移 / Space 平移 / 滚轮缩放+平移 —— 与重构前逐字一致
    return { panOnDrag: [1, 2], selectionKeyCode: true, zoomOnPinch: true, panOnScroll: true }
  })
}
