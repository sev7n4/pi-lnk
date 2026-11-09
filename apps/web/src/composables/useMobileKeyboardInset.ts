import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 移动端软键盘检测（2026-11-09 二次修正）。
 *
 * 背景：`.agent-panel-shell`（移动端对话态）是 `position: fixed; bottom: …`。
 * composer 这类贴底输入框获焦时，浏览器会把可视视口 **pan** 上来把输入框露出——
 * 此时 `vv.offsetTop ≈ 键盘高`，旧公式 `innerHeight - vv.height - vv.offsetTop`
 * 算出 inset ≈ 0，而面板 `bottom: max(--lnk-tabbar-h, inset)` 回落成页签高度，
 * 于是 composer 与键盘之间留出「页签高度」的空白（用户真机复现）。
 *
 * 二次修正：
 *   1. 键盘「开/关」改由 **focus 事件驱动**——输入框获焦 = 开，失焦（离开可编辑）= 关，
 *      不再由 inset 是否 > 0 推导（pan 模式下 inset 恒为 0，会误判键盘未开）。
 *   2. 面板 CSS 在键盘开启时 `bottom` 直接取 `var(--mobile-kb-inset)`（pan / resizes-content
 *      下为 0，键盘贴边由 pan 或布局收缩承担；resizes-visual 无 pan 下为真实键盘高），
 *      关闭时回落 `var(--lnk-tabbar-h)`。去掉 `max()` 即可消除留白。
 *   3. `index.html` 加 `interactive-widget=resizes-content`，键盘弹起时把布局视口确定性收缩，
 *      使 resizes-content 模式下 `bottom:0` 即精确贴键盘上沿，彻底消除各模式歧义。
 *
 * inset 公式 `max(0, innerHeight - vv.height - vv.offsetTop)`：
 *   - resize（视口被键盘压缩）：vv.height 已缩小、offsetTop=0 ⇒ inset≈0（布局收缩已承担贴边）；
 *   - pan（视口不缩、内容上移）：vv.height 不变、offsetTop≈键盘高 ⇒ inset≈0（pan 已承担贴边）；
 *   - resizes-visual 无 pan（输入框已在可视区）：vv.height 缩小、offsetTop=0 ⇒ inset=键盘高。
 * 三种工况下 inset 都是「固定元素还需手动抬升的距离」，键盘开启时直接作 bottom 即可。
 */
const keyboardInset = ref(0)
const isKeyboardOpen = ref(false)

let rafId = 0
let attached = 0
let focusDelayId = 0
let vvHandler: (() => void) | null = null
let winHandler: (() => void) | null = null

function scheduleCompute() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const innerH = typeof window !== 'undefined' ? window.innerHeight : 0
    let inset = 0
    if (vv) {
      // 取整，避免亚像素抖动触发过渡
      inset = Math.max(0, Math.round(innerH - vv.height - vv.offsetTop))
    }
    keyboardInset.value = inset
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--mobile-kb-inset', `${inset}px`)
    }
  })
}

// 键盘「开/关」由 focus 驱动：可编辑元素获焦即视为键盘将开，失焦（离开可编辑）即视为将收。
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable
}

function focusInHandler(e: FocusEvent) {
  if (!isEditableTarget(e.target)) return
  isKeyboardOpen.value = true
  // 等键盘动画落定再算 inset，避免取到中间态高度（此时 inset 可能仍为 0）
  if (focusDelayId) clearTimeout(focusDelayId)
  focusDelayId = window.setTimeout(scheduleCompute, 280)
}

function focusOutHandler(e: FocusEvent) {
  // 仅当焦点真的离开可编辑元素（而非在可编辑之间切换）才收键盘
  if (!isEditableTarget(e.target) || isEditableTarget(e.relatedTarget)) return
  // 延迟关闭，避免焦点在可编辑间切换抖动；也等键盘收起动画后再把 inset 归零
  if (focusDelayId) clearTimeout(focusDelayId)
  focusDelayId = window.setTimeout(() => {
    isKeyboardOpen.value = false
    scheduleCompute()
  }, 200)
}

export function useMobileKeyboardInset() {
  onMounted(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return
    attached += 1
    if (attached === 1) {
      vvHandler = scheduleCompute
      winHandler = scheduleCompute
      window.visualViewport.addEventListener('resize', vvHandler)
      window.visualViewport.addEventListener('scroll', vvHandler)
      window.addEventListener('resize', winHandler)
      document.addEventListener('focusin', focusInHandler)
      document.addEventListener('focusout', focusOutHandler)
      scheduleCompute()
    }
  })

  onBeforeUnmount(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return
    attached = Math.max(0, attached - 1)
    if (attached === 0 && vvHandler && winHandler) {
      window.visualViewport.removeEventListener('resize', vvHandler)
      window.visualViewport.removeEventListener('scroll', vvHandler)
      window.removeEventListener('resize', winHandler)
      document.removeEventListener('focusin', focusInHandler)
      document.removeEventListener('focusout', focusOutHandler)
      if (focusDelayId) clearTimeout(focusDelayId)
      vvHandler = null
      winHandler = null
      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--mobile-kb-inset', '0px')
      }
      keyboardInset.value = 0
      isKeyboardOpen.value = false
    }
  })

  return { keyboardInset, isKeyboardOpen }
}
