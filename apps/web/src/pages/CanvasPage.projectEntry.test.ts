// PR-2 Task 8 接线契约（2026-10-25）+ 2026-10-27 三页顶栏统一重构修订。
//
// 本仓 CanvasPage 的既有测试全部是**静态源码契约**（无 mount：页面体量过大，
// 挂载代价与回归面都不划算）——本文件沿用同一形态。
//
// 覆盖三组契约：
//   ① WorkspaceTopBar 渲染「‹ 返回创作空间」入口（emit go-gallery，D7 纯微信式，▾ 已退役；
//     2026-10-27 取代 CanvasFloatingChrome——顶栏统一收进顶部单栏）；
//   ② CanvasPage 接上 go-gallery 返回创作空间；PC 项目面板已退场；挂载时写入「最近项目」记忆；
//   ③ 全仓**唯一 create 通道**：canvasApi.create / sessionsApi.create 只允许出现在
//      useProjectWorkspace.ts 里（收敛前散落 5 处、两条 service 混用）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..')
const read = (p: string) => readFileSync(join(here, p), 'utf8')

/** 剥注释：迁移说明写进注释是本仓规范，全文扫描断言必假红。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('PC 画布页项目入口（PR-2 Task 8 + 顶栏重构修订）', () => {
  const chrome = read('../components/canvas/WorkspaceTopBar.vue')
  const page = read('./CanvasPage.vue')

  it('① WorkspaceTopBar 渲染返回创作空间入口并 emit go-gallery（纯微信式，规格 v2 D7）', () => {
    expect(stripComments(chrome)).toContain("emit('go-gallery')")
    // 返回按钮：‹ 图标 + 「返回创作空间」语义（导航决定权在 CanvasPage）
    const btn = chrome.match(/<button[\s\S]*?aria-label="返回创作空间"[\s\S]*?>[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(btn, '必须能定位「返回创作空间」按钮').toContain("emit('go-gallery')")
    // ⛔ 纯微信式：「项目名 ▾」下拉已退役（切换项目 = 返回创作空间再点另一个）
    expect(stripComments(chrome), 'project-click 旧语义必须移除').not.toContain("'project-click'")
    expect(stripComments(chrome), '▾ 箭头必须移除').not.toContain('M7 10l5 5 5-5z')
    // 项目名 §6.4：次级静默文本（非交互、截断），不再可改名输入框
    expect(stripComments(chrome)).toContain('workspace-project-name')
  })

  it('① 样式不新增 hex：走令牌（旧 --neo-* 体系只减不增）', () => {
    const style = chrome.slice(chrome.indexOf('<style'), chrome.lastIndexOf('</style>'))
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('② CanvasPage 接上 go-gallery 返回创作空间；PC 项目面板已退场（D7 纯微信式）', () => {
    const tag = page.match(/<WorkspaceTopBar[\s\S]*?\/>/)?.[0] ?? ''
    expect(tag, '必须能定位 WorkspaceTopBar 开标签').toContain('@go-gallery="backToCreationHome"')
    expect(tag, '旧 project-click 接线必须移除').not.toContain('@project-click')
    // ⛔ 面板退场：PC 端不再挂载 ProjectPanel（重命名/删除/复制由创作空间行卡承载）
    expect(stripComments(page), 'ProjectPanel 必须从 CanvasPage 退场').not.toContain('<ProjectPanel')
  })

  it('② 返回创作首页 = router.push(\'/canvases\')（切换项目走列表，D7 纯微信式）', () => {
    const fn = page.match(/function backToCreationHome\(\)\s*\{[^}]*\}/)?.[0] ?? ''
    expect(fn, '必须能定位 backToCreationHome').toContain("router.push('/canvases')")
  })

  it('② 挂载时写入「最近项目」记忆，且空 sessionId 不得写坏记忆', () => {
    const mounted = page.slice(page.indexOf('onMounted(() => {'))
    expect(mounted.slice(0, mounted.indexOf('\n})')).length).toBeGreaterThan(0)
    expect(mounted, 'onMounted 必须写入最近项目记忆').toContain('rememberProject(sessionId.value)')
    // 空守卫：sessionId 为空时不得把空串写进记忆（否则下次进入创作解析到不存在的项目）
    expect(stripComments(page)).toMatch(/if \(sessionId\.value\) rememberProject\(sessionId\.value\)/)
  })

  it('② 返回语义替代面板入口：openProjectPanel 不再由 chrome 触发（D7 纯微信式）', () => {
    // chrome 的唯一项目入口已改为 go-gallery；openProjectPanel（若暂存）不得再被模板引用
    expect(stripComments(page)).not.toContain('@project-click="openProjectPanel"')
    expect(stripComments(page)).toContain('@go-gallery="backToCreationHome"')
  })

  // ⏱ timeout 60s：本用例同步遍历全 src 读文件，4 核/8GB 换页压力下 >5s（默认限时）
  // 是机器瓶颈而非代码问题（2026-10-26 实测 15-22s），放宽时间预算、断言不变。
  it('③ 全仓唯一 create 通道：create 只允许出现在 useProjectWorkspace.ts', { timeout: 60_000 }, () => {
    const allowed = join(srcRoot, 'composables', 'useProjectWorkspace.ts')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|vue)$/.test(entry)) continue
        if (full.endsWith('.test.ts')) continue
        if (full === allowed) continue
        const body = stripComments(readFileSync(full, 'utf8'))
        if (/canvasApi\.create\s*\(|sessionsApi\.create\s*\(/.test(body)) {
          hits.push(relative(srcRoot, full))
        }
      }
    }
    walk(srcRoot)
    expect(
      hits,
      `create 必须收敛到 useProjectWorkspace（这些文件仍在直接调用）：${hits.join(', ')}`,
    ).toEqual([])
  })

  it('③ 新建项目保留 20s 客户端超时（收敛通道时最易丢的就是它）', () => {
    // 2026-10-27 顶栏重构：create 入口自 CanvasesPage 页内按钮迁至 AppHeader 裸栏 ＋ 盘
    // （规格 §6.1），20s 超时必须随迁（收敛时最易丢的就是它）。
    const header = read('../components/layout/AppHeader.vue')
    expect(header).toContain('create({ timeoutMs: 20_000 })')
    // workspace 必须把超时透传给 canvasApi.create
    const ws = read('../composables/useProjectWorkspace.ts')
    expect(ws).toContain('{ timeout: opts.timeoutMs }')
    // ⛔ 默认路径必须仍是**零参数**调用 canvasApi.create —— 下游守卫锁的就是
    //    「不传 title」这个契约（title 不进请求体，IA v4 标题由后端默认值决定）。
    expect(stripComments(ws)).toContain(': await canvasApi.create()')
  })

  it('③ 只读态按钮的创建失败不再静默回主页（改为明确报错）', () => {
    const rail = read('../components/agent/AgentSideRail.vue')
    const fn = rail.match(/async function createOwnCanvas\(\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn, '必须能定位 createOwnCanvas').toContain('createProject()')
    expect(fn, '失败必须明确报错').toContain('ElMessage.error')
    expect(fn, '不得再静默 goToWorkflowHome').not.toContain('goToWorkflowHome()')
  })
})
