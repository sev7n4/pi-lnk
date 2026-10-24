// element-plus 按需引入的守卫契约（2026-10-24 性能修复）。
//
// ## 背景
//
// 改造前：`main.ts` 里 `use(ElementPlus)` 全量注册 + `element-plus/dist/index.css`
// 全量样式（357KB 原始）⇒ 品牌页（纯展示页）也要下载整个 UI 库。
// 生产实测：入口 CSS gzip 94KB、入口 JS gzip 455KB，是首屏白屏主因之一。
//
// 改造后：`<el-*>` 由 unplugin-vue-components 在使用点自动引入（含各自样式）。
//
// ## ⛔ 踩过的坑（本文件存在的原因）
//
// element-plus 的**主入口不注入任何 CSS**（样式全靠 `dist/index.css` 全量引入）。
// 改按需后，那 32 处 `import { ElMessage } from 'element-plus'` 依然可用
// （tree-shaking 只留 ElMessage 本身，JS 侧无回归），
// **但 `el-message` / `el-message-box` 的样式会完全消失** ——
//
// 实测：改造后全产物 CSS 里 `el-message` **0 命中**
// ⇒ 所有 `ElMessage.success(...)` 变成无样式裸文本、确认框没有皮
// ⇒ 这是**功能回归**，不是优化。
//
// 所以这两份样式必须**显式**引入，且必须有守卫钉住。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')
/** vite.config.ts 在 apps/web/ 根，不在 src/ 下 ⇒ 单独一个读取器。 */
const readWebRoot = (p: string) => readFileSync(join(here, '..', '..', p), 'utf8')

/**
 * 剥注释后再断言。
 *
 * ⚠️ 本仓规范：迁移/改造说明写进注释（这正是「为什么这么改」的沉淀处）。
 *    而 `main.ts` 的注释里**必然提到** `use(ElementPlus)` 与
 *    `element-plus/theme-chalk/dark/css-vars.css`（说明「改造前是什么、为什么删」）
 *    ⇒ 不剥注释的话 `not.toContain` 必然命中注释文本 ⇒ 假红。
 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

describe('element-plus 按需引入：配置与样式兜底', () => {
  // ⚠️ 断言前必须剥注释：main.ts 的注释里必然提到被删掉的那几行
  //    （说明「改造前是什么、为什么删」），不剥会假红。
  const main = stripComments(read('../main.ts'))
  const mainRaw = read('../main.ts')
  const vite = readWebRoot('vite.config.ts')

  it('⛔ 函数式 API 的样式必须显式引入（否则弹窗无皮）', () => {
    // ⛔ 这三条 import 一旦被删，全站 31 个文件里的 ElMessage/ElMessageBox
    //    都会变成无样式裸文本 —— 而且**不会报错**，只会在生产上肉眼可见地坏掉。
    // ⚠️ 用**原文**（不剥注释）断言：注释里也会出现这些路径，但注释里出现的是
    //    「为什么要引它」的说明，import 语句本身才是判据 ——
    //    剥注释后剩下的 import 行是唯一真源。
    expect(mainRaw, '必须显式引入 el-message 样式').toMatch(
      /^\s*import\s+'element-plus\/theme-chalk\/el-message\.css'\s*$/m,
    )
    expect(mainRaw, '必须显式引入 el-message-box 样式').toMatch(
      /^\s*import\s+'element-plus\/theme-chalk\/el-message-box\.css'\s*$/m,
    )
    expect(mainRaw, '必须引入 element-plus base.css（组件样式的变量底座）').toMatch(
      /^\s*import\s+'element-plus\/theme-chalk\/base\.css'\s*$/m,
    )
  })

  it('⛔ 不得再全量注册（全量注册 = 这次改造白做）', () => {
    expect(main, '不得 use(ElementPlus)').not.toContain('use(ElementPlus)')
    // 全量 CSS 一旦被引回来，入口 CSS 立刻涨回 357KB 原始 / ~94KB gzip
    expect(main, '不得引入 element-plus 全量 CSS').not.toContain(
      "import 'element-plus/dist/index.css'",
    )
  })

  it('⛔ 不得引入 element-plus 暗色变量表（本项目用自己的 data-theme）', () => {
    // 本项目主题机制 = 自己的 :root[data-theme='dark']（design-tokens.css），
    // 不用 element-plus 的 html.dark ⇒ 那份变量表从未生效，纯负担。
    expect(main, '不得引入 element-plus 暗色变量表').not.toContain(
      'element-plus/theme-chalk/dark/css-vars.css',
    )
  })

  it('vite 配置：组件解析器按需 + 自动导入函数式 API', () => {
    expect(vite, '必须配置 unplugin-vue-components').toContain('unplugin-vue-components/vite')
    expect(vite, '必须配置 ElementPlusResolver').toContain('ElementPlusResolver')
    // importStyle 必须是 css/sass（不写则不带样式 ⇒ 组件裸奔）
    expect(vite, '必须指定 importStyle').toMatch(/importStyle:\s*'(css|sass)'/)
  })

  it('样式与 JS 的归属一致：函数式 API 的 JS 在主入口，样式也在主入口', () => {
    // ElMessage 的 JS 由那 32 处显式 import 引入（tree-shaking 后落在主入口），
    // 样式也放主入口 ⇒ 两边生命周期一致，不会出现「样式在分包、JS 在入口」的错配。
    const jsImports = read('../composables/useMySessions.ts')
    expect(jsImports, '函数式 API 仍走 element-plus 主入口（tree-shaking 已验证有效）').toContain(
      "from 'element-plus'",
    )
  })
})
