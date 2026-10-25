// 品牌页性能修复的守卫契约（2026-10-24）。
//
// 背景：生产实测「品牌页加载慢 + 点创作迟迟进不了项目」，实测基线：
//   · 入口 JS 384KB(gzip) / 入口 CSS 68KB(gzip) → 品牌页首屏 463KB
//   · 点锚后才第一次下载画布页 843KB(gzip)（含 19 个同步依赖）
//   · 服务器出网仅 ~290-410KB/s ⇒ 每次都要白等 2~3 秒
//
// 本文件钉住三条**行为级**不变式（不是「某字符串存在」那种弱断言）：
//   ① 路由预加载：画布页分包必须在**用户点击之前**就被预热；
//   ② 移动端不用 location.assign：整页刷新会让移动端传输量翻倍；
//   ③ 加载态可见：点击后必须有反馈，否则用户感知为「点了没反应」。
//
// ⚠️ 守卫必须能在**回归时变红**。每条断言都指向一次真实的退化：
//   删掉 preloadCanvasChunk 调用 → ①红；把 replace 改回 assign → ②红；
//   去掉 creating 透传 → ③红。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')
/** vite.config.ts 在 apps/web/ 根，不在 src/ 下 ⇒ 单独一个读取器。 */
const readWebRoot = (p: string) => readFileSync(join(here, '..', '..', p), 'utf8')

/** 剥注释后再定位调用位置——注释里出现函数名会让断言命中叙述文本而非代码
 *  （迁移说明写进注释是本仓规范，全文扫描断言必假红）。 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

describe('品牌页性能修复：路由预加载', () => {
  const preload = stripComments(read('../composables/useRoutePreload.ts'))
  const workflowPage = stripComments(read('./WorkflowPage.vue'))
  const app = stripComments(read('../App.vue'))
  const hero = stripComments(read('../components/workflow/SignatureHero.vue'))

  it('预热用的是**字面量**动态 import（Vite 靠字面量识别懒加载边界）', () => {
    // ⛔ 若改成变量路径（const p = '@/pages/CanvasPage.vue'; import(p)），
    //    Vite 会失去分包能力，或更糟——把它变成 entry chunk 的静态依赖，
    //    画布页被拉回首屏，首屏**更慢**。
    expect(preload, '必须用字面量 import() 保留独立 chunk').toContain(
      "import('@/pages/CanvasPage.vue')",
    )
  })

  it('⛔ 品牌页挂载时**不得**预热（首屏期预热 = 生产事故元凶）', () => {
    // ⛔⛔ 这条是 2026-10-24 生产事故的直接防线。
    // 实测：品牌页 onMounted 立即预热 ⇒ 4166ms 拉起画布页整棵依赖树
    //（338KB + 24 个 chunk）⇒ 与首屏资源抢同域 6 个 HTTP/1.1 连接
    // ⇒ 535KB 的品牌 logo 从 2.1 秒被拖到 13 秒、API 排队
    // ⇒ 用户报「品牌页出不来 + 连登录都出问题」。
    const m = workflowPage.match(/onMounted\([\s\S]{0,800}?\n\}\)/)
    expect(m, '找不到 WorkflowPage 的 onMounted 块').not.toBeNull()
    expect(
      m![0],
      '⛔ 品牌页 onMounted 里不得预热：首屏期预热会抢连接、拖垮首屏与 API',
    ).not.toContain('preloadCanvasChunk()')
  })

  it('⛔⛔ App.vue 不得有**任何**全局预热（三次事故后的最终结论）', () => {
    // ⛔⛔ 这条是 2026-10-24 **三次**生产事故的最终防线。
    //
    // 演进：
    //   ① 挂载即空闲预热 ⇒ 与首屏抢连接 ⇒ logo 2.1s→13s、API 排队（#581 删）
    //   ② 等 `load` 事件 ⇒ `load` 不等懒加载 chunk ⇒ 仍在抢（#582 改 load+3s）
    //   ③ load+3s 仍不够 —— **对话页实测**：连点历史项目 1/2/3/4，
    //      每次建一条 SSE 长连接（`/api/agent/runs/events`），
    //      同域 HTTP/1.1 只有 6 个连接，旧 SSE 未释放时新 SSE 又建
    //      ⇒ 连接占满 ⇒ threads/events 排队 **55 秒**（Network 一片红）。
    //      全局预热此时又拉 CanvasPage 338KB + 26 chunk ⇒ **再抢一轮**。
    //
    // ⭐ **结论：全局预热在任何页面都有害** —— 它不知道用户接下来要去哪，
    //    却必定付出「与当前页面的 SSE / API 抢连接」的代价。
    expect(app, '⛔ App.vue 不得 import 预热模块').not.toContain('useRoutePreload')
    expect(app, '⛔ App.vue 不得调用任何预热（全局预热 = 抢连接）').not.toContain('Preload')
  })

  it('✅ 预热只能来自用户意图（SignatureHero 的 preloadOnIntent）', () => {
    // 唯一被允许的预热时机：指针移到锚 / 焦点进入 / 触摸滑条
    // ⇒ 意图明确，且此刻首屏早已就绪 ⇒ 不抢任何连接。
    const hero = stripComments(read('../components/workflow/SignatureHero.vue'))
    expect(hero, 'SignatureHero 必须挂意图触发').toContain('preloadOnIntent(')
    expect(preload, '必须提供意图触发入口').toContain('preloadOnIntent')
  })

  it('意图触发预热：挂在锚与滑条上（移动端无 hover，靠 touchstart）', () => {
    expect(hero, 'SignatureHero 必须挂意图触发').toContain('preloadOnIntent(')
    expect(hero, '必须挂到创作锚上').toContain('ink-anchor')
    expect(hero, '必须挂到滑条上（移动端主路径）').toContain('slide-to-create')
    // 三个事件：桌面 hover / 键盘 focus / 移动触摸
    expect(preload, '必须支持 pointerenter（桌面）').toContain('pointerenter')
    expect(preload, '必须支持 focusin（键盘可达）').toContain('focusin')
    expect(preload, '必须支持 touchstart（移动端）').toContain('touchstart')
  })

  it('预热失败不阻断主流程（预热是优化，不是功能依赖）', () => {
    // 预热必须吞掉失败：离线/弱网下失败时仍要能走正常点击路径。
    // ⚠️ 注意：动态 import 的 rejection **不会被外层 try/catch 捕获**
    //    （try/catch 只管同步抛错）⇒ 必须显式 .catch()。
    expect(preload, '动态 import 必须显式 .catch 兜底').toMatch(
      /import\('@\/pages\/CanvasPage\.vue'\)\.catch\(/,
    )
  })
})

describe('品牌页首屏不得拉入画布链（请求数）', () => {
  const workflowPage = stripComments(read('./WorkflowPage.vue'))

  it('⛔ 发布弹窗必须异步加载（它拖进整条画布链）', () => {
    // ⛔ 2026-10-24 第二轮事故取证：品牌页首屏 **51 个同域请求 / 1.3MB**，
    //    其中 20+ 个是画布页 chunk：
    //      PublishNeoTVDialog → stores/canvasEditor → services/studio-api
    //                                        → components/canvas/refine/*
    //                          → CanvasLocateButton → AgentTurnTimeline → UniversalModelSelector → …
    //    而它在模板里的位置是 `hidden lg:block` 容器内 ⇒ 窄屏（主场景）根本用不到。
    //    ⇒ 6 个连接被占满 9 轮往返 ⇒ 535KB 的 logo 拖到 8 秒、API 排到 10.3 秒。
    expect(
      workflowPage,
      '⛔ PublishNeoTVDialog 不得静态 import（会把画布链拖进品牌页首屏）',
    ).not.toMatch(/^import\s+PublishNeoTVDialog\s+from/m)
    expect(workflowPage, 'PublishNeoTVDialog 必须用 defineAsyncComponent').toMatch(
      /defineAsyncComponent\(\(\)\s*=>\s*import\(['"]@\/components\/works\/PublishNeoTVDialog\.vue['"]\)\)/,
    )
    // ⛔⛔ `v-if` 是**必需**的，不是保险：
    //    `defineAsyncComponent` 在组件**被渲染时**就发起 chunk 加载，与内部是否可见无关。
    //    父容器是 `hidden lg:block` ⇒ 组件照样渲染 ⇒ 照样加载
    //    ⇒ 实测首屏在 5213ms 又来一批（PublishNeoTVDialog + 11 个 element-plus chunk）。
    const tag = workflowPage.match(/<PublishNeoTVDialog[\s\S]{0,400}?\/>/)?.[0] ?? ''
    expect(tag, '找不到 PublishNeoTVDialog 标签').not.toBe('')
    expect(
      tag,
      '⛔ PublishNeoTVDialog 必须带 v-if="showPublish"（否则异步组件照样在首屏加载）',
    ).toContain('v-if="showPublish"')
  })
})

describe('element-plus 按需引入：不做 manualChunks 合并（已实测否决）', () => {
  const vite = readWebRoot('vite.config.ts')

  it('⛔ 不得用 manualChunks 把 element-plus 合成一个 chunk', () => {
    // ⛔ 2026-10-24 实测否决：加 manualChunks 后 `element-plus` chunk 变成
    //    **324.5KB(gzip)** 且含 ElTree / ElUpload / ElCascader / ElDatePicker
    //    （只被 admin 页用到）⇒ **tree-shaking 失效**
    //    （把 `element-plus/es/index.mjs` 聚合入口拉进同一 chunk，
    //      它的全部 re-export 都必须保留）⇒ 按需省下的 315KB 全数吐回。
    //
    // ✅ 那 11 个小 chunk 合计仅 48.7KB(gzip)，与入口并行下载，不在关键路径上
    //    （关键路径是 535KB 的品牌 logo + 140KB 的入口）⇒ 不需要合并。
    //
    // 判据：源码里不得出现**可执行的** manualChunks 配置
    //（注释里提到「manualChunks」是允许的 —— 那段注释记录了否决理由）。
    const code = vite
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(code, '⛔ 不得用 manualChunks 合并 element-plus（tree-shaking 会失效）').not.toContain(
      'manualChunks',
    )
  })

  it('✅ 按需引入必须保留（resolver + importStyle）', () => {
    expect(vite, '必须配置 ElementPlusResolver').toContain('ElementPlusResolver')
    // importStyle 必须是 css/sass（不写则不带样式 ⇒ 组件裸奔）
    expect(vite, '必须指定 importStyle').toMatch(/importStyle:\s*'(css|sass)'/)
  })
})

describe('品牌页性能修复：移动端不整页刷新', () => {
  const workflowPage = stripComments(read('./WorkflowPage.vue'))
  const enterCreationSrc = stripComments(read('../composables/useEnterCreation.ts'))

  it('移动端分发用 router.replace 而非 window.location.assign', () => {
    // ⚠️ 2026-10-25 PR-1 Task 4：跳转语句已从 WorkflowPage 移入 useEnterCreation
    //    （入口分发改走 composable）。本断言随之转移，守的行为不变：
    //    「不得整页刷新 + 自动分发必须 replace」。
    expect(enterCreationSrc, '移动端不应再用 location.assign').not.toContain('window.location.assign')
    expect(enterCreationSrc, '移动端分发必须走 router.replace').toContain('router.replace.bind(router)')
  })

  it('用 replace 而非 push（自动分发不该在历史里留返回记录）', () => {
    // ⚠️ 2026-10-25 PR-1 Task 4：入口分发改走 `useEnterCreation()`，跳转语句从
    //    WorkflowPage 移到了 composable 内。本断言**随之转移**，但守的行为不变：
    //    「自动分发必须是 replace，不能是 push」。
    //    - WorkflowPage 侧：确认自动分发确实委托给了 enterCreation 且传了 replace
    //    - composable 侧：确认那里真的有 router.replace 分支
    expect(workflowPage, '移动端自动分发必须委托给 enterCreation').toContain(
      'enterCreation({ allowImplicitCreate: false, replace: true })',
    )
    const enterCreationSrc = stripComments(read('../composables/useEnterCreation.ts'))
    expect(enterCreationSrc, '自动分发必须走 router.replace（push 会让返回键弹回品牌页）').toContain(
      'router.replace.bind(router)',
    )
  })

  it('⛔ 全仓不得再有 location.assign（对话页进画布同样受害）', () => {
    // ⛔ 2026-10-24 补：初版只改了品牌页，漏了 AgentSideRail 的 3 处
    //    （点作品 / 打开项目 / 新建项目）—— 从对话页进画布也是整页刷新。
    const rail = stripComments(read('../components/agent/AgentSideRail.vue'))
    expect(rail, 'AgentSideRail 不得再用 location.assign（整页刷新 ⇒ 传输翻倍）').not.toContain(
      'window.location.assign',
    )
    // 有效性配对：改成 router.push 后必须真的 push 了
    expect(rail, '打开项目必须走 router.push').toContain('router.push(`/workflow/${id}`)')
    expect(rail, '新建项目必须走 router.push').toContain('router.push(`/workflow/${created.id}`)')
  })
})

describe('品牌页性能修复：加载态可见', () => {
  // ⚠️ 2026-10-25 PR-1 Task 4：加载态的所有者从 WorkflowPage 的 `creating`
  //    移到 `useEnterCreation()` 的 `entering`（INV-8 防连点与加载态是同一份状态，
  //    页面层再自持一份必然漂移）。守卫随之转移，**守的行为不变**：
  //    置位 / finally 复位 / 防重入 / 透传 hero 与滑条。
  const enterCreationSrc = stripComments(read('../composables/useEnterCreation.ts'))
  const workflowPage = stripComments(read('./WorkflowPage.vue'))
  const hero = stripComments(read('../components/workflow/SignatureHero.vue'))
  const slide = stripComments(read('../components/workflow/SlideToCreate.vue'))

  it('进入期间置 loading 态，并在 finally 复位', () => {
    expect(enterCreationSrc, '必须有 entering 状态').toContain('const entering = ref(false)')
    // ⛔ 复位必须在 finally：异常路径（建会话失败）不复位 ⇒ 页面永久卡在加载态。
    expect(enterCreationSrc, 'entering 必须在 finally 里复位').toMatch(
      /finally\s*\{[\s\S]{0,200}?entering\.value = false/,
    )
  })

  it('防重入：加载中不再重复触发（否则并发建多个会话）', () => {
    expect(enterCreationSrc, 'enterCreation 必须防重入').toMatch(
      /if\s*\(entering\.value\)\s*return/,
    )
  })

  it('加载态透传到 hero 与滑条（两个创作入口都要反馈）', () => {
    expect(workflowPage, 'entering 必须传给 SignatureHero').toContain(':creating="entering"')
    expect(hero, 'hero 必须消费 creating prop').toContain('props.creating')
    expect(slide, '滑条必须支持 disabled（防二次触发）').toContain('disabled')
  })

  it('加载态文案用 on-signature 令牌（签名面纪律：恒深底 ⇒ 主题不变式）', () => {
    // ⛔ 随主题翻转的令牌（--lnk-hi-bg / --lnk-hi-text / --lnk-accent-text）
    //    压在**不翻转**的恒深签名底上会翻成近黑/低对比。
    const heroAll = read('../components/workflow/SignatureHero.vue')
    const spinnerBlock = heroAll.match(/\.lnk-anchor__spinner\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(spinnerBlock, '找不到 spinner 样式块').not.toBe('')
    expect(spinnerBlock, 'spinner 不得用随主题翻转的令牌').not.toMatch(/--lnk-hi-|--lnk-accent-text/)
    expect(spinnerBlock, 'spinner 必须用 on-signature 家族令牌').toContain('--lnk-stamp-ink-on-signature')
  })
})

describe('品牌页性能修复：tiptap 异步化', () => {
  const editor = stripComments(read('../components/canvas/PromptMarkdownEditor.vue'))
  const setup = read('../components/canvas/tiptapSetup.ts')

  it('tiptap 不得在编辑器组件顶层静态 import', () => {
    // ⛔ 顶层静态 import ⇒ tiptap + prosemirror 进画布页主分包的同步依赖
    //    （生产实测 295.6KB gzip，占全部依赖 77%），而编辑器只在双击时才打开。
    expect(editor, 'tiptap 不得在组件顶层静态 import').not.toMatch(
      /^import\s+.*from\s+'@tiptap\//m,
    )
    expect(editor, 'tiptap 必须走动态 import').toContain("import('@/components/canvas/tiptapSetup')")
  })

  it('tiptap 全家集中在独立模块（Vite 靠它切独立 chunk）', () => {
    expect(setup, 'tiptapSetup 必须持有全部 tiptap import').toContain("from '@tiptap/vue-3'")
    expect(setup, 'tiptapSetup 必须持有 starter-kit').toContain("from '@tiptap/starter-kit'")
    expect(setup, 'tiptapSetup 必须持有 tiptap-markdown').toContain("from 'tiptap-markdown'")
  })

  it('⛔ 空实例守卫：模块未加载完就关闭时，不得把空串写回（会清空用户内容）', () => {
    // ⛔ 这是异步化引入的新窗口：用户「刚打开就立刻关」。
    //    若无守卫，flushSave 会 emit('') ⇒ 父组件 v-model 被置空 ⇒ 内容丢失。
    const flush = editor.match(/function flushSave\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(flush, '找不到 flushSave').not.toBe('')
    expect(flush, 'flushSave 必须有「编辑器未就绪则不写回」的守卫').toMatch(
      /if\s*\(!editor\.value\)\s*return/,
    )
  })

  it('⛔ 关闭意图补偿：加载期间关闭时，模块到位后要补一次保存', () => {
    // ⛔ 只做空实例守卫会丢内容：模块到位后用户已关闭 ⇒ 永不 flush。
    expect(editor, '必须有 pendingSaveOnLoad 之类的关闭意图缓冲').toMatch(/pendingSaveOnLoad/)
    expect(editor, '模块到位后必须补一次 flushSave').toMatch(
      /pendingSaveOnLoad[\s\S]{0,200}?flushSave\(\)/,
    )
  })

  it('加载中要有可见提示（否则用户以为没反应）', () => {
    expect(editor, '必须有加载态提示').toContain('tiptapLoading')
    expect(editor, '加载提示必须有文案').toContain('编辑器加载中')
  })
})
