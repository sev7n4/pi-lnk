import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 移动端软键盘高度检测（2026-11-09 兜底修复）。
 *
 * 背景：`.agent-panel-shell`（移动端对话态）是 `position: fixed; bottom: …`。
 * 在 Edge/Android 上软键盘默认 **overlay / pan** 模式，而非 resize —— 即 `bottom:0`
 * 锚的是「完整视口底边」（被键盘盖住），浏览器再把可视视口 pan 回来一点，于是
 * composer 裸条与键盘之间留下约 60px 错位空白。单纯把 `bottom` 设 0 解决不了，
 * 因为键盘高度根本没被计入定位。
 *
 * 解法：用 `window.visualViewport` 实测键盘高度，写成全局 CSS 变量
 * `--mobile-kb-inset`（px）。面板 `bottom` 用 `max(--lnk-tabbar-h, --mobile-kb-inset)`
 * 即可在 resize / overlay / pan 三种模式下都精确贴键盘上沿。
 *
 * 公式 `inset = innerHeight - vv.height - vv.offsetTop`（取非负）：
 *   - resize（视口被键盘压缩）：vv.height 已缩小、offsetTop=0 ⇒ inset≈0，`bottom:0` 本身正确；
 *   - pan（视口不缩、内容上移）：vv.height 不变、offsetTop=键盘高 ⇒ inset 为负 ⇒ 取 0，
 *     此时浏览器 pan 已把 fixed 元素抬起，无需额外偏移；
 *   - overlay / adjustNothing（视口不缩、也不 pan）：vv.height 不变、offsetTop=0 ⇒
 *     inset=键盘高，我们主动把面板抬起键盘高 ⇒ 这正是当前产生空白的工况，由此根治。
 */
const keyboardInset = ref(0)
const isKeyboardOpen = ref(false)

let rafId = 0
let attached = 0
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
    isKeyboardOpen.value = inset > 8
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--mobile-kb-inset', `${inset}px`)
    }
  })
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
