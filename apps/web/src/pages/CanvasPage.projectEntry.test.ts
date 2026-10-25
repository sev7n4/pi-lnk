// PR-2 Task 8 接线契约（2026-10-25）：PC 画布页补项目入口 + 创建通道收敛。
//
// 本仓 CanvasPage 的既有测试全部是**静态源码契约**（无 mount：页面体量过大，
// 挂载代价与回归面都不划算）——本文件沿用同一形态。
//
// 覆盖三组契约：
//   ① CanvasFloatingChrome 暴露「项目名 ▾」入口（emit project-click，不新增 hex）；
//   ② CanvasPage 接上该入口并渲染 ProjectPanel；挂载时写入「最近项目」记忆；
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

describe('PC 画布页项目入口（PR-2 Task 8）', () => {
  const chrome = read('../components/canvas/CanvasFloatingChrome.vue')
  const page = read('./CanvasPage.vue')

  it('① CanvasFloatingChrome 暴露「项目名 ▾」入口并 emit project-click', () => {
    expect(stripComments(chrome)).toContain("'project-click': []")
    // 入口按钮：项目图标 + 项目名 + 下拉箭头（▾）
    const btn = chrome.match(/<button[\s\S]*?class="chrome-project-btn[\s\S]*?>/)?.[0] ?? ''
    expect(btn, '必须能定位「项目名 ▾」按钮').toContain('chrome-project-btn')
    expect(btn).toContain("emit('project-click')")
    // 项目名取自 title prop（与标题输入框同源），不是另造一份状态
    expect(chrome).toContain('<span class="truncate">{{ title || \'未命名项目\' }}</span>')
  })

  it('① 新按钮不新增 hex：走 --lnk-* 令牌（旧 --neo-* 体系只减不增）', () => {
    const style = chrome.slice(chrome.indexOf('<style'), chrome.lastIndexOf('</style>'))
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    const rule = style.match(/\.chrome-project-btn\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule, '项目入口按钮必须有样式规则').toContain('var(--lnk-')
  })

  it('② CanvasPage 接上 project-click，并渲染断点中立的 ProjectPanel', () => {
    const tag = page.match(/<CanvasFloatingChrome[\s\S]*?\/>/)?.[0] ?? ''
    expect(tag, '必须能定位 CanvasFloatingChrome 开标签').toContain('@project-click="openProjectPanel"')

    const panel = page.match(/<ProjectPanel[\s\S]*?\/>/)?.[0] ?? ''
    expect(panel, '必须能定位 ProjectPanel 开标签').toContain('<ProjectPanel')
    expect(panel).toContain(':open="projectPanelOpen"')
    expect(panel).toContain(':projects="projectWsProjects"')
    expect(panel).toContain(':current-id="sessionId"')
    // PC 无底部页签 ⇒ 必须让开页签的兜底（56px）失效，否则遮罩底部留空条：
    // 点不到 = 关不掉面板，且抽屉比视口矮一截。
    expect(panel, 'PC 端必须传 reserve-tabbar=false').toContain(':reserve-tabbar="false"')
    // 六个动作全部接线（新建 / 打开 / 重命名 / 删除 / 重试 / 关闭）
    for (const [evt, handler] of [
      ['@close', 'closeProjectPanel'],
      ['@create', 'handleProjectCreate'],
      ['@open', 'handleProjectOpen'],
      ['@rename', 'handleProjectRename'],
      ['@remove', 'handleProjectRemove'],
      ['@retry', 'handleProjectRetry'],
    ] as const) {
      expect(panel, `ProjectPanel 必须接线 ${evt}`).toContain(`${evt}="${handler}"`)
    }
  })

  it('② 挂载时写入「最近项目」记忆，且空 sessionId 不得写坏记忆', () => {
    const mounted = page.slice(page.indexOf('onMounted(() => {'))
    expect(mounted.slice(0, mounted.indexOf('\n})')).length).toBeGreaterThan(0)
    expect(mounted, 'onMounted 必须写入最近项目记忆').toContain('rememberProject(sessionId.value)')
    // 空守卫：sessionId 为空时不得把空串写进记忆（否则下次进入创作解析到不存在的项目）
    expect(stripComments(page)).toMatch(/if \(sessionId\.value\) rememberProject\(sessionId\.value\)/)
  })

  it('② 面板按需拉列表：不在挂载期重复请求（INV-10 老毛病）', () => {
    const fn = page.match(/function openProjectPanel\(\)\s*\{[^}]*\}/)?.[0] ?? ''
    expect(fn, '打开面板时才拉列表').toContain('loadProjectList()')
    expect(fn).toContain('projectPanelOpen.value = true')
  })

  it('③ 全仓唯一 create 通道：create 只允许出现在 useProjectWorkspace.ts', () => {
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
    const canvases = read('./CanvasesPage.vue')
    expect(canvases).toContain('createProject({ timeoutMs: 20_000 })')
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
