import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { enableViaQuery } from './composables/useFeatureFlag'
import './styles/main.css'

// 2026-10-24 性能修复：element-plus 从**全量注册**改为**按需引入**。
//
// 改造前：`use(ElementPlus)` + `element-plus/dist/index.css`（357KB 原始）
// ⇒ 品牌页（一个纯展示页）也要下载整个 UI 库的 JS + 样式。
// 生产实测：入口 CSS gzip 94KB、入口 JS gzip 455KB —— 是首屏白屏的主因之一。
//
// 改造后：
// - `<el-*>` 组件由 `unplugin-vue-components` 在**实际使用点**自动引入
//   （含各自样式）—— admin 页等用到的地方照常工作，主站链路零成本；
// - `ElMessage` / `ElMessageBox` 等函数式 API 由 `unplugin-auto-import` 处理。
//
// ⚠️ 为什么不用 `element-plus/theme-chalk/dark/css-vars.css`：
//    本项目的主题机制是**自己的** `data-theme`（见 design-tokens.css 的
//    `:root[data-theme='dark']`），**不使用** element-plus 的 `html.dark`
//    ⇒ 那份暗色变量表在本项目从未生效（生产产物里也查不到 `html.dark` 用法），
//    属于纯负担，删掉。

/**
 * ⛔ 函数式 API（ElMessage / ElMessageBox）的样式**必须显式引入**。
 *
 * 原因：element-plus 的**主入口不注入任何 CSS**（样式全靠 `dist/index.css`
 * 全量引入提供）。改成按需后，那 32 处 `import { ElMessage } from 'element-plus'`
 * 依然可用（tree-shaking 只保留 ElMessage 本身，JS 侧无回归），
 * **但 `el-message` / `el-message-box` 的样式会完全消失** ⇒
 * 所有 `ElMessage.success(...)` 变成无样式裸文本、确认框没有皮。
 *
 * 实测判据：改造后全产物 CSS 里 `el-message` 0 命中 ⇒ 确认为功能回归。
 *
 * 为什么放进入口而不是各使用方就近引入：
 *   这两个 API 在全站 31 个文件里被使用（几乎每个页面都可能弹提示），
 *   而三个 CSS 合计仅 **3.8KB(gzip)** —— 放进入口是最简做法，
 *   且与「ElMessage 的 JS 本身就在主入口」保持一致。
 */
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-message-box.css'

// 在创建 app 之前扫描 URL query 启用调试 flag
// 例：`?feature=selection_batch_generate` 启用本特性灰度
enableViaQuery()

createApp(App).use(createPinia()).use(router).mount('#app')
