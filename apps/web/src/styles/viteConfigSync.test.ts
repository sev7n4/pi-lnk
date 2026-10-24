// vite 配置**双份文件**的一致性守卫（2026-10-24 生产事故防线）。
//
// ## 背景：为什么需要这个守卫
//
// `apps/web` 里有**两份** vite 配置：
//   · `vite.config.ts` —— 人写的源
//   · `vite.config.js` —— `vue-tsc -b` 的 emit 产物，**且被 git 跟踪**
//     （历史上被误提交进仓，`git log` 可见它来自 #81 那次提交）
//
// ⛔⛔ **Vite 的配置查找顺序是 `.js` 优先**（vite 6 源码 `constants.js`）：
// ```
//   DEFAULT_CONFIG_FILES = [
//     "vite.config.js", "vite.config.mjs", "vite.config.ts",
//     "vite.config.cjs", "vite.config.mts", "vite.config.cts",
//   ]
// ```
// ⇒ **构建实际用的是 `vite.config.js`，不是 `.ts`**。
//
// ⇒ 改了 `.ts` 却没重新生成 `.js` ⇒ **改动完全不生效，且没有任何报错**。
//    这在 2026-10-24 真的发生过：加了 `build.rollupOptions.output.manualChunks`
//    后本地 `vite build` 产物里找不到那个 chunk，排查了很久才发现是配置没同步。
//
// ## CI 为什么没出事
//
// `apps/web` 的 `build` 脚本 = `vue-tsc -b && vite build` ⇒ **先跑 tsc**
// （`tsconfig.json` 的 `references` 指向 `tsconfig.node.json`，它 include 了
// `vite.config.ts` 且 `composite: true` ⇒ tsc 会重新 emit `vite.config.js`）
// ⇒ CI 每次构建前都自动同步了 `.js`。
//
// ⛔ 但**本地**只跑 `vite build`（不跑 tsc）就会拿到旧配置 ⇒ 本地验证会骗人。
//
// ## 本守卫做什么
//
// 直接比对两份文件的关键配置项是否一致 —— 不同步就红。
// 比对的是**规范化后的文本**（去空白、去注释差异），避免格式抖动假红。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..', '..')

function readRoot(p: string): string {
  return readFileSync(join(webRoot, p), 'utf8')
}

/**
 * 规范化：去注释、去所有空白、去分号。
 *
 * ⚠️ `.js` 是 tsc 的 emit 产物：它保留 `.ts` 的注释，但
 *    ① 缩进不同、② **ESM 输出会给每条 import 结尾加分号**（源文件没有）
 *    ⇒ 只能比「语义内容」，不能比原文。
 */
function normalize(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/['"`]/g, '"')
    .replace(/;/g, '')
    .replace(/\s+/g, '')
}

/**
 * 关键配置项：两边都必须出现。
 *
 * ⚠️ 只放**规范化后仍存在**的标识符：normalize 会去掉注释，
 *    而 `element-plus`（小写）只出现在注释里（否决 manualChunks 的那段说明），
 *    代码里是 `ElementPlusResolver`（大写 P）⇒ 判小写会误报「缺少」。
 */
const KEYS = [
  'unplugin-vue-components/vite',
  'unplugin-auto-import/vite',
  'ElementPlusResolver',
  'optimizeDeps',
  '@lnkpi/shared',
]

describe('vite 配置双份文件必须同步（.js 优先被 Vite 加载）', () => {
  const ts = readRoot('vite.config.ts')
  const js = readRoot('vite.config.js')
  const nts = normalize(ts)
  const njs = normalize(js)

  it('⛔ `vite.config.js` 存在（Vite 优先加载它）', () => {
    // 若哪天把它从 git 里删了，本守卫要提醒同步改判定逻辑
    //（那时 Vite 会开始用 `.ts`，但 `vue-tsc -b` 仍会生成 `.js` 到工作区）。
    expect(js.length, 'vite.config.js 不存在 —— 判定逻辑需同步更新').toBeGreaterThan(0)
  })

  it('⛔ 关键配置项在 .ts 与 .js 中必须都存在且一致', () => {
    for (const k of KEYS) {
      expect(nts, `vite.config.ts 缺少 ${k}`).toContain(k)
      expect(
        njs,
        `⛔ vite.config.js 缺少 ${k} —— 两份配置已不同步！\n` +
          `   Vite 优先加载 .js ⇒ 改了 .ts 不会生效（且无报错）。\n` +
          `   修法：跑 \`pnpm --filter @lnkpi/web exec vue-tsc -b\` 重新生成 .js 后一起提交。`,
      ).toContain(k)
    }
  })

  it('⛔ 规范化后两份配置必须完全一致（防止只同步了一半）', () => {
    expect(
      njs,
      '⛔ vite.config.js 与 .ts 语义不一致 ⇒ 生产构建用的配置与仓库源不符。\n' +
        '   修法：跑 `vue-tsc -b` 重新生成 .js 后一起提交。',
    ).toBe(nts)
  })
})
