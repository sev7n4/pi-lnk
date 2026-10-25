// 项目列表的**加载策略**守卫（2026-10-25 生产实证）。
//
// 用户报：「点全部项目 → 抽屉只显示几个（其余在『加载中』）→ 过一会儿变成『项目加载失败』」。
// 取证结论（生产 DB + nginx 日志 + 容器内直测）：
//   · 端点不慢：最重账号（266 个项目）端点总耗时 56ms；
//   · 日志里 `canvas/list` 只有 200/304，**没有** 4xx/5xx，**也没有** 499
//     ⇒ 失败的那次请求**根本没发出去**（在浏览器连接队列里排着，15s 超时先到）；
//   · 画布页的 SSE/轮询会占满同域 HTTP/1.1 的 6 个连接（见 App.vue 注释：排队可达 55 秒）。
//
// ⇒ 对策（前端侧）：**不要在打开抽屉时再发一次注定排队的请求**；已加载的数据要活过失败。
// 本文件锁住这些策略不被改回去。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

/** 剥注释后再定位：迁移说明写进注释是本仓规范，全文扫描断言必假红。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('项目列表加载策略（2026-10-25 生产实证）', () => {
  const rail = stripComments(read('./AgentSideRail.vue'))
  const ws = stripComments(read('../../composables/useProjectWorkspace.ts'))

  it('抽屉打开走 loadIfStale（数据还新鲜就不发请求）', () => {
    const fn = rail.match(/async function loadProjects\(\)\s*\{[^}]*\}/)?.[0] ?? ''
    expect(fn, '必须能定位 loadProjects').toContain('loadIfStale')
    expect(fn, '抽屉打开不得无条件重新拉（会排队 → 15s 超时 → 假失败）').not.toMatch(
      /await list\(\)/,
    )
  })

  it('「重试」走 list() 强制拉一次（失败态下 loadIfStale 会让重试永远没反应）', () => {
    const fn = rail.match(/async function retryLoadProjects\(\)\s*\{[^}]*\}/)?.[0] ?? ''
    expect(fn, '必须能定位 retryLoadProjects').toContain('await list()')
    // 面板的 retry 事件必须接到强制重试上
    expect(rail).toContain('@retry="retryLoadProjects"')
  })

  it('项目列表是**模块级单例**（多份实例 = 多份请求 = 抢同一条被占满的连接）', () => {
    // 状态必须定义在模块作用域（不在 useProjectWorkspace() 函数体内）
    const moduleLevel = /^const projects = ref<ProjectCard\[\]>\(\[\]\)/m.test(ws)
    expect(moduleLevel, 'projects 必须是模块级单例（画布页有 4 个消费方）').toBe(true)
    expect(ws).toMatch(/^let inflight: Promise<ProjectCard\[\]> \| null = null$/m)
  })

  it('失败**不清空**已有清单（清空 = 用户正在看的项目一起消失）', () => {
    const catchBlock = ws.match(/\.catch\(\(\) => \{[\s\S]*?\}\)/)?.[0] ?? ''
    expect(catchBlock, '必须能定位 list() 的 catch').toContain('error.value = true')
    expect(
      catchBlock,
      'catch 里不得再 projects.value = []（那是「刷新失败把清单抹掉」的成因）',
    ).not.toMatch(/projects\.value\s*=\s*\[\]/)
  })

  it('单飞（single-flight）：同一时刻只允许一个列表请求在途', () => {
    expect(ws).toContain('if (inflight) return inflight')
  })
})
