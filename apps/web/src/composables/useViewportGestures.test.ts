import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useViewportGestures } from './useViewportGestures'

/** P0-1 手势断点分流契约：移动端单指平移+双指缩放；PC 逐字保持重构前配置。 */
describe('useViewportGestures (P0-1)', () => {
  it('PC 未锁定：保持 [1,2] 中右键平移 + 左键框选 + 滚轮平移（重构前逐字一致）', () => {
    const g = useViewportGestures(ref(false), ref(false)).value
    expect(g).toEqual({
      panOnDrag: [1, 2],
      selectionKeyCode: true,
      zoomOnPinch: true,
      panOnScroll: true,
    })
  })

  it('移动端：panOnDrag=true（触屏 touchstart 不过 d3 filter 的数组分支）+ 双指缩放', () => {
    const g = useViewportGestures(ref(true), ref(false)).value
    expect(g.panOnDrag).toBe(true)
    expect(g.zoomOnPinch).toBe(true)
    // 框选关闭：拖拽框选与单指平移互斥，多选走应用层选择模式
    expect(g.selectionKeyCode).toBeNull()
    expect(g.panOnScroll).toBe(false)
  })

  it('锁定态：全端禁平移/框选/滚轮', () => {
    for (const mobile of [false, true]) {
      const g = useViewportGestures(ref(mobile), ref(true)).value
      expect(g.panOnDrag).toBe(false)
      expect(g.selectionKeyCode).toBeNull()
      expect(g.panOnScroll).toBe(false)
    }
  })

  it('响应式：断点/锁定翻转时产出跟随更新', () => {
    const isMobileLayout = ref(false)
    const viewLocked = ref(false)
    const gestures = useViewportGestures(isMobileLayout, viewLocked)
    expect(gestures.value.panOnDrag).toEqual([1, 2])
    isMobileLayout.value = true
    expect(gestures.value.panOnDrag).toBe(true)
    viewLocked.value = true
    expect(gestures.value.panOnDrag).toBe(false)
  })
})
