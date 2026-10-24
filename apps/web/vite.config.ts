import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    vue(),
    // 2026-10-24 性能修复：element-plus 改为**按需引入**。
    //
    // 改造前：`main.ts` 里 `use(ElementPlus)` 全量注册 + `element-plus/dist/index.css`
    // 全量样式（357KB 原始）⇒ 品牌页（一个纯展示页）也要下载整个 UI 库。
    // 生产实测：入口 CSS gzip 94KB、入口 JS gzip 455KB，是首屏白屏的主因之一。
    //
    // 改造后：组件按 `<el-*>` 实际使用点自动引入（模板里用到的才进包），
    // 函数式 API（ElMessage / ElMessageBox）由 AutoImport 自动处理。
    // ⚠️ 主站链路（品牌页 / 画布页 / Agent 侧栏）**零 el-* 模板使用** ⇒
    //    这些页面不再为 element-plus 付任何首屏成本。
    Components({
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dts: false,
    }),
    // ElMessage / ElMessageBox：函数式调用，组件解析器管不到，需单独自动导入。
    // ⚠️ 保留 `main.ts` 里的 `import { ElMessage, ElMessageBox } from 'element-plus'`
    //    也无害（tree-shaking 会保留具名导出），但显式声明更清晰。
    AutoImport({
      imports: ['vue'],
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dts: false,
    }),
  ],
  // ⛔ **刻意不加** `build.rollupOptions.output.manualChunks` 把 element-plus 合成一个 chunk。
  //
  // 2026-10-24 实测过并否决了这条路（记录在此，避免有人再走一遍）：
  //   · 动机：按需引入把 element-plus 拆成按组件的小 chunk（el-select / el-tag / …），
  //     品牌页首屏会多出 11 个请求；在「6 连接」下担心拖长关键路径。
  //   · 实测：加了 manualChunks 之后，`element-plus` chunk 变成 **324.5KB(gzip)**，
  //     且含 `ElTree` / `ElUpload` / `ElCascader` / `ElDatePicker` 等**只被 admin 页用到**的组件
  //     ⇒ **tree-shaking 失效**（把 `element-plus/es/index.mjs` 这个聚合入口拉进了同一个 chunk，
  //     它的全部 re-export 都必须保留）⇒ 按需引入省下的 315KB **全数吐回**。
  //   · 结论：那 11 个小 chunk 合计仅 48.7KB(gzip)，与入口 **并行**下载，
  //     不在首屏关键路径上（关键路径是 535KB 的品牌 logo 与 140KB 的入口）⇒
  //     **不需要合并**。真正拖慢首屏的是「预加载抢连接」，已在上游修掉。
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  // @lnkpi/shared 通过 pnpm symlink 解析到 packages/shared/src（见其 package.json main 字段）。
  // Vite 6 默认 optimizeDeps 不包含 workspace TS src，selectionBatchGenerate 等模块
  // 会被 tree-shake 误删——生产 bundle 里 planSelectionGenerate 函数体丢失，
  // multiSelectPlan 调它时抛 'planSelectionGenerate is not a function'，被 Vue 静默
  // 吞掉 → runCount=0 → 按钮 disabled → 点击无反应。强制 include 让 esbuild 预构建保留 export。
  optimizeDeps: {
    include: ['@lnkpi/shared'],
  },
})
