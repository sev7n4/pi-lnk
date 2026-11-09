/**
 * PC 视觉回归 fixture 页的本地 Vite 配置。
 *
 * 只用仓库既有依赖（apps/web 的 vite / @vitejs/plugin-vue / vue），不新增 npm 包。
 * root 固定在 scripts/fixtures，使 fixture 页与产品源码目录隔离；
 * alias 把 `vue` 与 `@/` 指回 apps/web，保证挂载的是**真实** presentation 组件。
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const WEB = resolve(REPO, 'apps/web')
const requireFromWeb = createRequire(resolve(WEB, 'package.json'))
const vuePlugin = requireFromWeb('@vitejs/plugin-vue').default

export default {
  root: HERE,
  plugins: [vuePlugin()],
  resolve: {
    alias: [
      { find: /^vue$/, replacement: resolve(WEB, 'node_modules/vue') },
      { find: /^@\//, replacement: resolve(WEB, 'src') + '/' },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    fs: { allow: [REPO] },
  },
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'warn',
}
