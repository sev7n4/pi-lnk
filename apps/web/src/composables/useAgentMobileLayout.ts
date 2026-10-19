import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 与 Tailwind `md` 断点对齐：768px 以下为移动端 Agent 全屏 sheet */
export const AGENT_MOBILE_MAX_WIDTH_PX = 767

export function useAgentMobileLayout() {
  const query = `(max-width: ${AGENT_MOBILE_MAX_WIDTH_PX}px)`

  // 非浏览器 / 无 matchMedia 的宿主（如 jsdom 单测、部分 SSR 预渲染）按桌面处理。
  // ⚠️ 这里必须判函数存在而非只判 window：DockStudioToolbar（2026-10-20 PR3 起）
  // 在 setup 里调本 composable，而它的单测环境没装 matchMedia —— 只判 window
  // 会在 `window.matchMedia(query)` 直接 TypeError，整文件挂掉。
  const canMatchMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'

  const isMobileLayout = ref(canMatchMedia ? window.matchMedia(query).matches : false)

  let mediaQuery: MediaQueryList | null = null

  function sync() {
    isMobileLayout.value = mediaQuery?.matches ?? false
  }

  onMounted(() => {
    if (!canMatchMedia) return
    mediaQuery = window.matchMedia(query)
    sync()
    mediaQuery.addEventListener('change', sync)
  })

  onBeforeUnmount(() => {
    mediaQuery?.removeEventListener('change', sync)
  })

  return { isMobileLayout }
}
