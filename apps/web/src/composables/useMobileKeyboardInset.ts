import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 移动端软键盘检测（2026-11-09 三次修正：丝滑贴边 + 留隙）。
 *
 * 背景：`.agent-panel-shell`（移动端对话态）是 `position: fixed; bottom: …`。
 * composer 这类贴底输入框获焦时，浏览器会把可视视口 **pan** 上来把输入框露出——
 * 此时 `vv.offsetTop ≈ 键盘高`，旧公式 `innerHeight - vv.height - vv.offsetTop`
 * 算出 inset ≈ 0，而面板 `bottom: max(--lnk-tabbar-h, inset)` 回落成页签高度，
 * 于是 composer 与键盘之间留出「页签高度」的空白（用户真机复现，已修）。
 *
 * 二次修正（#803）：
 *   1. 键盘「开/关」改由 **focus 事件驱动**——输入框获焦 = 开，失焦（离开可编辑）= 关，
 *      不再由 inset 是否 > 0 推导（pan 模式下 inset 恒为 0，会误判键盘未开）。
 *   2. 面板 CSS 在键盘开启时 `bottom` 直接取 `var(--mobile-kb-inset)`，关闭时回落 `var(--lnk-tabbar-h)`。
 *   3. `index.html` 加 `interactive-widget=resizes-content`，键盘弹起时把布局视口确定性收缩。
 *
 * 三次修正（本版，2026-11-09 用户复测反馈「贴太紧 + 上顶与键盘不同步有割裂感」）：
 *   - **逐帧跟随**：聚焦/失焦后开启一个约 500ms 的 rAF 采样窗口，每帧读取 visualViewport
 *     实时写入 `--mobile-kb-inset`，使 composer 与键盘 **同帧**升降，而非「等 280ms 再跳」。
 *   - **状态随键盘真值翻转**：`isKeyboardOpen` 不再在聚焦瞬间硬切，而是键盘真正开始移动
 *     （inset > 1）时才开、收起归零（inset ≤ 1）时才关——消除聚焦瞬间 composer 先坠到底的突兀。
 *   - 配套 CSS：面板壳加 `transition: bottom 0.1s ease` 做收尾平滑；键盘开启 `bottom`
 *     取 `calc(var(--mobile-kb-inset) + 8px)`，与键盘上沿留 8px 视觉空隙。
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
let trackRaf = 0
let trackUntil = 0
let closing = false
let vvHandler: (() => void) | null = null
let winHandler: (() => void) | null = null

function computeInset(): number {
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
  return inset
}

function scheduleCompute() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    rafId = 0
    computeInset()
  })
}

// 键盘开/合动画期内逐帧采样 visualViewport：composer 与键盘同帧升降，消除「割裂感」。
// 开：键盘真正开始移动（inset>1）才置 isKeyboardOpen=true；
// 关：收起归零（inset≤1）才置 isKeyboardOpen=false，避免聚焦/失焦瞬间突兀跳变。
function trackLoop() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const inset = computeInset()
  if (closing) {
    if (inset <= 1) {
      isKeyboardOpen.value = false
      closing = false
      trackRaf = 0
      return
    }
  } else if (inset > 1) {
    isKeyboardOpen.value = true
  } else if (now >= trackUntil) {
    // 窗口结束仍未检测到键盘（如外接键盘/无软键盘）→ 维持关闭
    isKeyboardOpen.value = false
  }
  if (now < trackUntil) {
    trackRaf = requestAnimationFrame(trackLoop)
  } else {
    trackRaf = 0
  }
}

function startTracking(durationMs: number) {
  trackUntil =
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) + durationMs
  if (!trackRaf) trackRaf = requestAnimationFrame(trackLoop)
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
  closing = false
  // 立即开启逐帧采样：键盘一动 inset 即 >0，composer 同步上顶（不再等 280ms 后跳）
  startTracking(500)
}

function focusOutHandler(e: FocusEvent) {
  // 仅当焦点真的离开可编辑元素（而非在可编辑之间切换）才收键盘
  if (!isEditableTarget(e.target) || isEditableTarget(e.relatedTarget)) return
  // 逐帧采样键盘收起过程，inset 归零后自动关 isKeyboardOpen，composer 随键盘同步下沉
  closing = true
  startTracking(500)
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
    if (attached === 0) {
      if (vvHandler && winHandler) {
        window.visualViewport!.removeEventListener('resize', vvHandler)
        window.visualViewport!.removeEventListener('scroll', vvHandler)
        window.removeEventListener('resize', winHandler)
      }
      document.removeEventListener('focusin', focusInHandler)
      document.removeEventListener('focusout', focusOutHandler)
      if (rafId) cancelAnimationFrame(rafId)
      if (trackRaf) cancelAnimationFrame(trackRaf)
      closing = false
      trackRaf = 0
      rafId = 0
      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--mobile-kb-inset', '0px')
      }
      keyboardInset.value = 0
      isKeyboardOpen.value = false
    }
  })

  return { keyboardInset, isKeyboardOpen }
}
