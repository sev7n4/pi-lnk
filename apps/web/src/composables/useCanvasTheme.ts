import { ref, watch } from 'vue'

export type CanvasTheme = 'dark' | 'light'

const STORAGE_KEY = 'lnkpi-canvas-theme'

/**
 * 主题引导脚本（`index.html` 内联、首屏绘制前同步执行）已经把结果写到 `<html data-theme>`。
 * 这里**以 DOM 为准**读回来，避免两个真相源各自算一遍。
 *
 * ⛔ 本文件曾经在模块顶层直接 `applyTheme(theme.value)`（模块级副作用）。
 *    由于本模块只被 `CanvasPage.vue` import，而 17 条路由全部懒加载，
 *    结果是 16 条路由永远求值不到 ⇒ `data-theme` 从未落地 ⇒ 浅色模式在画布页以外不存在；
 *    且属性一旦设上就不再移除，页面外观取决于「用户有没有访问过画布」。
 *    主题是应用级关注点，**不属于任何页面模块**，请不要把副作用搬回来。
 */
function currentTheme(): CanvasTheme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function applyTheme(value: CanvasTheme) {
  document.documentElement.setAttribute('data-theme', value)
  // 同步 Element Plus 明暗主题（el-dialog / el-input 等跟随应用主题）
  document.documentElement.classList.toggle('dark', value === 'dark')
}

const theme = ref<CanvasTheme>(currentTheme())

watch(theme, (value) => {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // 隐私模式下 localStorage 不可写：本次会话内仍生效，只是不持久化
  }
  applyTheme(value)
})

export function useCanvasTheme() {
  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  return { theme, toggleTheme }
}
