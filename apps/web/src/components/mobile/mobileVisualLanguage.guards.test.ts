import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用（仓库既有约定：fileURLToPath(import.meta.url)）
const HERE = dirname(fileURLToPath(import.meta.url))
const MOBILE_DIR = HERE

function read(name: string) {
  return readFileSync(join(MOBILE_DIR, name), 'utf-8')
}

/** 剥离注释（JS 注释 + HTML 注释）—— 注释里提到字符/组件名是**规范说明**，不是引用 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 跨端视觉与组件哲学守卫（规格 §4.11 · 拍板项 N1）。
 *
 * ⭐ 这些守卫防的是「**风格退化**」——本轮改动让移动端第一次统一到
 *   iOS HIG / Material 3 的组件语义与视觉纪律；没有守卫，下一个人很容易
 *   又写回裸 fixed 浮层 / 字符图标 / 硬编码圆角。
 */
describe('跨端视觉与组件哲学守卫（§4.11）', () => {
  it('G-16 移动端模板不得用文本字符当功能图标（‹ × ⋯）', () => {
    const files = readdirSync(MOBILE_DIR).filter((f) => f.endsWith('.vue'))
    const offenders: string[] = []
    for (const f of files) {
      const src = stripComments(read(f))
      // 只查按钮内容里的裸字符图标
      if (/>\s*[‹×⋯]\s*</.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('G-15 长按浮层必须走 MobileSheet 基座（⛔ 禁第二套 sheet 皮肤）', () => {
    const src = stripComments(read('MobileNodeActionSheet.vue'))
    expect(src).toContain('MobileSheet')
    expect(src).not.toMatch(/position:\s*fixed/)
  })

  // ⭐ V-3 收紧（2026-10-26 对账）：原守卫**只点名** 2 个文件 ⇒
  //   `MobileNodeEditorSheet.vue` 的裸 `position:fixed` 全屏浮层**逃过守卫**
  //   （规格 V-3 原文要求「扫 `components/mobile/*.vue` **全目录**」）。
  //   ⇒ 改为**扫全目录** + 白名单**逐个显式列出并写明豁免理由**
  //     （⛔ 禁「只点名个别文件」—— 那正是让缺口逃过的原因）。
  it('V-3 全目录扫描：**全屏遮罩型**浮层不得用裸 position:fixed（白名单须显式 + 写明理由）', () => {
    // ⚠️ 判据**精确化**（2026-10-26 对账）：V-3 原文是「禁裸 `position:fixed`
    //   **全屏浮层**」—— ⛔ 不是禁**所有** fixed：FAB / 状态栏 / tab bar / 动作条
    //   用 fixed 是**正确**的（它们本就贴视口，不该跟着文档流）。
    //   ⇒ 判据 = `position:fixed` **且** `inset:0`（或等价四边铺满）= 全屏遮罩。
    //   ⭐ 修这条判据前，守卫**只点名 2 个文件** ⇒ 缺口全逃过；现在**扫全目录**。
    //
    // 白名单：文件名 → 豁免理由（新增豁免必须在此写清理由，否则守卫拒绝放行）
    const WHITELIST: Record<string, string> = {
      'MobileSheet.vue': '基座自身（scrim + 把手 + Teleport）—— 全屏遮罩的标准形态',
      // ⭐ 2026-10-27：§4.11.8 豁免类已显式化（全屏非选择型浮层），以下豁免**有据**：
      //   ① 全屏媒体查看器 / ② 全屏文本阅读面 / ③ 全屏表单 / ④ 既有全屏面板。
      //   豁免纪律 = P3（X + 手势可退）+ §4.11.5 内联 SVG + V-5 44px + reduce-motion。
      'MobileNodeViewer.vue': '全屏**媒体查看器**（灯箱/逐帧/全屏阅读）—— §4.11.8 豁免类①',
      'MobileReadingSurface.vue': '共享**全屏文本阅读面**（§4.8.1）—— §4.11.8 豁免类②',
      'MobileNodeEditorSheet.vue': '全屏**表单**（长提示词需整屏输入面；MobileSheet 是 62vh 选择型）—— §4.11.8 豁免类③',
      'MobileNodeTextEditorSheet.vue': '全屏**表单**（文本产物校正原生编辑器，需整屏输入面弹手机键盘；MobileSheet 是 62vh 选择型）—— §4.11.8 豁免类③（与 MobileNodeEditorSheet 同类，2026-10-30）',
      'ProfilePane.vue': '全屏**资料面板**（既有能力）—— §4.11.8 豁免类④',
      'DiscoverPane.vue': '全屏**发现面板**（既有能力）—— §4.11.8 豁免类④',
      'MobileCanvasShell.vue': '内含 `.mobile-account-pane` 全屏「我的」面板（既有能力）—— §4.11.8 豁免类④',
    }
    const files = readdirSync(MOBILE_DIR).filter((f) => f.endsWith('.vue'))
    const offenders: string[] = []
    for (const f of files) {
      if (f in WHITELIST) continue
      const src = stripComments(read(f))
      // 全屏遮罩 = fixed 且四边铺满（inset:0 或 top+bottom+left+right）
      // ⚠️ 四边判定必须**排除 padding-top / margin-left 之类**：
      //   `/top:\s*0/` 会误命中 `padding-top: 0` ⇒ 把底部 tab bar / 顶部 bar
      //   当成全屏（第一版就踩了 ⇒ 收紧为「属性名前不可有 `-`」）。
      const isFullScreenFixed =
        /position:\s*fixed/.test(src) &&
        (/inset:\s*0/.test(src) ||
          [/(?<![-\w])top:\s*0;/, /(?<![-\w])bottom:\s*0;/, /(?<![-\w])left:\s*0;/, /(?<![-\w])right:\s*0;/]
            .every((re) => re.test(src)))
      if (isFullScreenFixed) offenders.push(f)
    }
    expect(offenders, `这些文件用了裸全屏 position:fixed（须走 MobileSheet 或加白名单+理由）`).toEqual([])
    // 白名单本身也要有理由（防空名单放行）
    for (const [f, reason] of Object.entries(WHITELIST)) {
      expect(reason.trim().length, `白名单项 ${f} 必须写明豁免理由`).toBeGreaterThan(4)
    }
  })

  it('G-15b 标注浮层同样走 MobileSheet 基座', () => {
    const src = stripComments(read('MobileNodeAnnotateSheet.vue'))
    expect(src).toContain('MobileSheet')
    expect(src).not.toMatch(/position:\s*fixed/)
  })

  it('MobileSheet 有 reduce-motion 分支（§4.11.8 · HIG Reduce Motion）', () => {
    expect(read('MobileSheet.vue')).toMatch(/prefers-reduced-motion/)
  })

  it('MobileSheet 圆角与动效使用令牌（禁硬编码 20px / 0.25s）', () => {
    const src = read('MobileSheet.vue')
    expect(src).toContain('--lnk-radius-')
    expect(src).toContain('--lnk-duration-')
    expect(src).not.toMatch(/border-radius:\s*20px/)
    expect(src).not.toMatch(/transition:[^;]*0\.25s/)
  })

  it('G-18 命中区令牌被使用（44px 触控下限）', () => {
    const src = read('MobileSheet.vue')
    expect(src).toContain('--lnk-touch-target')
  })

  // ⭐ V-5 补齐（2026-10-26 对账）：V-5 原文要求「令牌守卫已覆盖
  //   `--lnk-touch-target`；**新增：图标按钮 `min-width/min-height` 断言**」
  //   —— 原实现只查了令牌**被使用**，**没有**断言图标按钮真的用它 ⇒ 缺口。
  //   ⇒ 断言「图标按钮」类必须同时具备 min-width 与 min-height，且值为
  //     var(--lnk-touch-target)（44px 触控下限，§4.11.6）。
  it('V-5 图标按钮命中区：min-width + min-height 均 ≥ --lnk-touch-target', () => {
    // 移动端的图标按钮（视觉 glyph 可小，但命中区必须 44px）
    const ICON_BUTTON_CLASSES = [
      'mv-chrome-close',   // 查看器右上 X（v1.5 P：MobileViewerChrome 自隐 chrome）
      // viewer-close / viewer-more 已退役（v1.5 O/P：⋯ 移除、旧 X 换 chrome 关闭钮）
      // viewer-annotate（圈选入口）已退役（2026-10-28 真机反馈①：浮动圆钮与底栏
      // 两套几何并存 ⇒ 入口统一进底部工具栏，为文本按钮非图标钮，V-5 不再适用）
      'mobile-account-close', // 「我的」面板关闭钮
    ]
    for (const cls of ICON_BUTTON_CLASSES) {
      const src =
        stripComments(read('MobileNodeViewer.vue')) +
        stripComments(read('MobileViewerChrome.vue')) +
        stripComments(read('MobileCanvasShell.vue'))
      const m = new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`).exec(src)
      expect(m, `找不到 .${cls} 的样式规则`).toBeTruthy()
      const rule = m![0]
      // ⭐ 判据是**实质**（命中区实际 ≥44px），不是字面（必须写 min-*）：
      //   固定 `width: 44px` 与 `min-width: 44px` **同样**满足命中区下限
      //   ⇒ 取「min-* 优先，否则 width/height」再判是否达到 44px。
      const sizeOf = (rule: string, kind: 'width' | 'height'): number | null => {
        const min = new RegExp(`min-${kind}:\\s*([^;]+)`).exec(rule)
        if (min) {
          const tok = min[1].trim()
          if (tok.includes('--lnk-touch-target')) return 44
          const n = parseFloat(tok)
          return Number.isFinite(n) ? n : null
        }
        const fixed = new RegExp(`(?:^|[;\\s])${kind}:\\s*([^;]+)`).exec(rule)
        if (fixed) {
          const tok = fixed[1].trim()
          if (tok.includes('--lnk-touch-target')) return 44
          const n = parseFloat(tok)
          return Number.isFinite(n) ? n : null
        }
        return null
      }
      const w = sizeOf(rule, 'width')
      const h = sizeOf(rule, 'height')
      expect(w, `.${cls} 未声明命中区宽度（需 min-width 或 width ≥ 44px）`).not.toBeNull()
      expect(h, `.${cls} 未声明命中区高度（需 min-height 或 height ≥ 44px）`).not.toBeNull()
      expect(w!, `.${cls} 命中区宽度 ${w}px < 44px`).toBeGreaterThanOrEqual(44)
      expect(h!, `.${cls} 命中区高度 ${h}px < 44px`).toBeGreaterThanOrEqual(44)
    }
  })

  it('⛔ 零 --neo-* 旧令牌（AGENTS.md 明令禁用；G-15）', () => {
    const files = readdirSync(MOBILE_DIR).filter((f) => f.endsWith('.vue'))
    const offenders = files.filter((f) => read(f).includes('--neo-'))
    expect(offenders).toEqual([])
  })

  it('⛔ 品牌锚用位图资产（⛔ 不用字符 / 不新造图标，G-7）', () => {
    const src = read('MobileNodeAnnotateSheet.vue')
    expect(src).toContain('anchor-locate.png')
  })
})
