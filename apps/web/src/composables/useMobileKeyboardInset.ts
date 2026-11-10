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
 * 最终修正（键盘间隙 + 跨模式可靠触发，2026-11-10 复盘）：
 *   - **聚焦即开、失焦即收（跨模式可靠）**：`isKeyboardOpen` 由「可编辑元素获焦」直接驱动，
 *     而非由 `inset > 1` 推导——因为 `interactive-widget=resizes-content` 下布局视口直接收缩、
 *     键盘不叠层，`inset` 恒为 0，靠 inset>1 判定会让 `.is-keyboard-open` 永远不挂、间隙规则成死代码
 *     （用户实测 8px/12px 毫无区别的根因）。
 *   - **逐帧跟随**：聚焦/失焦后开启约 500ms 的 rAF 采样窗口，每帧读取 visualViewport 实时写入
 *     `--mobile-kb-inset`，使 pan/resizes-visual 模式下 composer 与键盘 **同帧**升降，消除割裂感。
 *   - 配套 CSS：面板壳 `transition: bottom 0.1s ease` 收尾平滑；键盘开启 `bottom`
 *     取 `calc(var(--mobile-kb-inset) + 12px)`，与键盘上沿留 12px 视觉空隙
 *     （resizes-content 下 inset=0 ⇒ 即 12px 固定间隙；pan 下 inset=键盘高 ⇒ 键盘上沿+12px）。
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

// 键盘开/合动画期内逐帧采样 visualViewport：pan/resizes-visual 模式下 composer 与键盘同帧升降。
// 开：已由 focusInHandler 在获焦瞬间置 isKeyboardOpen=true（跨模式可靠，不依赖 inset）；
// 关：由 focusOutHandler 进入 closing，待 inset≤1（键盘动画结束 / 视口收缩完成）才置 false。
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
    // 兜底：pan/resizes-visual 模式下若已检测到键盘高度，确保开启（聚焦已先行开启）。
    isKeyboardOpen.value = true
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
  // 聚焦即判定键盘将开（跨模式可靠）：resizes-content 下视口收缩、inset 恒为 0，
  // 不能靠 inset>1 判定，否则 .is-keyboard-open 永远不挂、间隙规则成死代码。
  isKeyboardOpen.value = true
  // 开启逐帧采样：pan/resizes-visual 模式下 inset 随键盘升降，composer 同帧跟随。
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
