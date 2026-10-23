// 2026-10-19 真机事故回归（移动端 ≡ 抽屉「项目清单看不到」）：
// 账号 165 项目时，抽屉项目区只剩一排 ~25px 等距的 1px 细线（像素实锤：线间距
// ≈ 8px flex gap + 1px 边框，标题/时间/图标/卡片底色全部不可见）。
// 根因：抽屉是**定高** flex 列容器（position:absolute; top:0; bottom:0），
// 项目卡带 overflow:hidden ⇒ flex 规范 §4.5「自动最小尺寸」对 overflow≠visible
// 的项归零 ⇒ flex-shrink 合法地把全部项目卡压到 0 高度；而 164 条 gap×8px 的
// 总量已超抽屉高度 ⇒ 内容永远滚动不尽。create-card/caption 只因 overflow 可见
// 才靠 min-height:auto 幸存——不可依赖。
// 修复：抽屉（及同族 thread-history-sheet）直接子项一律 flex-shrink:0，
// 溢出交还 overflow-y:auto。
// 同日追加（用户裁决）：项目清单默认只预览最近 8 条 + 「展开更多」一次展开全部
// （几何依据：首屏列表区 ~590px，8×60px 卡片与按钮同屏不折叠）。
// jsdom 不计算布局 ⇒ 布局类断言只能落在 SFC 样式块契约上（与 theme-usage /
// bareBar 测试同族），否定断言一律配有效性断言（防空集假绿）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const style = sfc.slice(sfc.indexOf('<style'), sfc.lastIndexOf('</style>'))
const tpl = sfc
  .slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>'))
  .replace(/<!--[\s\S]*?-->/g, '')

describe('mobile session drawer: project cards must not be shrunk into hairlines (2026-10-19 incident)', () => {
  it('drawer direct children are shrink-proof (root cause: overflow:hidden zeroes auto min size)', () => {
    const rule = style.match(/\.session-drawer\s*>\s*\*\s*\{[^}]*\}/)?.[0]
    expect(rule, '抽屉直接子项缺少 flex-shrink:0 保护——项目卡会被压成 1px 细线').toBeTruthy()
    expect(rule).toContain('flex-shrink: 0')
  })

  it('same guard on the sibling thread-history sheet (same accident family)', () => {
    const rule = style.match(/\.thread-history-sheet\s*>\s*\*\s*\{[^}]*\}/)?.[0]
    expect(rule, '对话历史浮层直接子项缺少 flex-shrink:0 保护').toBeTruthy()
    expect(rule).toContain('flex-shrink: 0')
  })

  it('paired: hazard neutralized, not deleted — overflow:hidden stays, scroll strategy stays', () => {
    // 有效性配对①：圆角裁剪仍靠 overflow:hidden（不允许靠删 hazard 来"修"）
    expect(style).toMatch(/\.project-card\s*\{[^}]*overflow:\s*hidden/)
    // 有效性配对②：溢出策略仍是抽屉滚动，而不是把子项压扁
    expect(style).toMatch(/\.session-drawer\s*\{[^}]*overflow-y:\s*auto/)
    // 有效性配对③：保护规则确实挂在抽屉容器下（规则存在但选择器写错 = 没生效）
    expect(style).toContain('.session-drawer > *')
  })
})

// ---- 预览条数契约（2026-10-19 用户裁决：默认 8 条 + 展开更多）----
// 挂载级行为见文末 describe；这里锁「模板真的消费预览切片」——防止常量定义了
// 但 v-for 仍遍历全量（预览静默失效）。
describe('mobile session drawer: project preview wiring (default 8 + expand more)', () => {
  it('v-for iterates the preview slice, not the full list', () => {
    expect(sfc).toContain('PROJECTS_PREVIEW_COUNT')
    expect(sfc).toContain('visibleProjects')
    expect(tpl).toContain('v-for="project in visibleProjects"')
    // 配对：全量数组仍在脚本里（展开态的数据源），只是模板不再直接遍历它
    expect(sfc).not.toMatch(/v-for="project in projects"/)
  })

  it('expand control is a real button with counted copy + toggle handler', () => {
    expect(tpl).toContain('class="session-drawer__expand"')
    expect(tpl).toContain('toggleProjectsExpanded')
    expect(tpl).toContain('展开更多（还有')
    expect(style).toMatch(/\.session-drawer__expand\s*\{[^}]*text-align:\s*center/)
  })
})

// ---- 数据通路（挂载级）：抽屉开的瞬间项目卡必须真的渲染出来 ----
// 样式契约防「压扁」，这里防「压根没渲染」——两者都发生过用户可见的「清单看不到」。
//
// ⚠️ 本 describe 与下方「预览条数」describe 的 5 条用例都真实 mount 整个 AgentSideRail
// （+ memory-history router + flushPromises）。master 15:20 那次绿时本文件 10 条共
// 5352ms——正压 vitest 默认 5s 线；PR #490 新增 5 个测试文件抬高并发后必红
// （实测唯一失败项，其余 2156 项全绿）。统一显式 30s，不碰全局 testTimeout。
const MOUNT_TIMEOUT = 30_000

/** 项目 fixtures 可变（预览条数测试需要不同总量）；默认 3 个（既有数据通路用例） */
let projectFixtures: { id: string; title: string; updatedAt: string }[] = [
  { id: 's1', title: '漫剧主线', updatedAt: '2026-10-19T10:00:00.000Z' },
  { id: 's2', title: '产品图实验', updatedAt: '2026-10-18T10:00:00.000Z' },
  { id: 's3', title: '', updatedAt: '2026-10-17T10:00:00.000Z' },
]
function setProjectFixtures(n: number) {
  projectFixtures = Array.from({ length: n }, (_, i) => ({
    // updatedAt 递减 = 模拟后端 orderBy updatedAt desc；第 0 条最新
    id: `p${i}`,
    title: `项目 ${i}`,
    updatedAt: new Date(Date.UTC(2026, 9, 19, 10, 0, 0) - i * 3_600_000).toISOString(),
  }))
}

vi.mock('@/services/canvas-api', () => ({
  canvasApi: {
    list: vi.fn(async () => ({ data: { data: projectFixtures } })),
    create: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ messages: [] }),
    remove: vi.fn(),
  },
}))

vi.mock('@/services/api-base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api-base')>()),
  apiUrl: (p: string) => p,
}))

vi.mock('@/services/provider-api', () => ({
  providerApi: {
    bootstrap: vi.fn().mockResolvedValue({
      platformChannel: null,
      channels: [],
      preferences: null,
      webdav: null,
    }),
  },
}))

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '' }) },
}))

/**
 * 用例间泄漏治理（2026-10-24 CI 红灯取证）。
 *
 * 抽屉 Teleport 到 `document.body`，而本文件的用例是用 `mountRail()` 真挂载整个
 * `AgentSideRail` 的。此前只 `document.body.innerHTML = ''` 抹 DOM 而不 unmount
 * ⇒ 上一个用例的 rail 实例**仍然活着**：后续用例任何一次响应式更新都会让它把
 * 已被抹掉的卡片重新插回 body ⇒ 全局 `querySelectorAll('.project-card')` 多算
 * （CI 实测：期望 8 得 11、期望 30 得 33，多出的正是首个用例的 3 条 fixture）。
 * ⭐ 所以治理点是「卸载」，不是「把断言改宽」——后者会把泄漏固化成契约。
 */
const mountedRails: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const rail of mountedRails.splice(0)) rail.unmount()
  document.body.innerHTML = ''
})

async function mountRail() {
  const { mount, flushPromises } = await import('@vue/test-utils')
  const { createPinia, setActivePinia } = await import('pinia')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const AgentSideRail = (await import('./AgentSideRail.vue')).default

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })),
  )
  setActivePinia(createPinia())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const w = mount(AgentSideRail, {
    global: { plugins: [router] },
    props: { sessionId: 's1' },
  })
  await flushPromises()
  mountedRails.push(w)
  return w
}

describe('mobile session drawer: project list data path', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    projectFixtures = [
      { id: 's1', title: '漫剧主线', updatedAt: '2026-10-19T10:00:00.000Z' },
      { id: 's2', title: '产品图实验', updatedAt: '2026-10-18T10:00:00.000Z' },
      { id: 's3', title: '', updatedAt: '2026-10-17T10:00:00.000Z' },
    ]
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  // 挂载级用例：显式 30s（理由见文件中部 MOUNT_TIMEOUT 注释）
  it(
    'openSessionDrawer renders one card per project (title fallback + is-current accent)',
    async () => {
      const w = await mountRail()
      w.vm.openSessionDrawer()
      const { flushPromises } = await import('@vue/test-utils')
      await flushPromises()

      // 抽屉 Teleport 到 body——查询 document 而非 wrapper
      const cards = document.body.querySelectorAll('.project-card')
      expect(cards.length).toBe(3)
      expect(cards[0].textContent).toContain('漫剧主线')
      expect(cards[1].textContent).toContain('产品图实验')
      // 空标题走「未命名项目」兜底
      expect(cards[2].textContent).toContain('未命名项目')
      // 当前项目卡带 is-current（accent 边框）
      expect(cards[0].classList.contains('is-current')).toBe(true)
      expect(cards[1].classList.contains('is-current')).toBe(false)
      // 每卡都有可操作入口（打开 + 重命名 + 删除）——细线态下这些全被裁没
      expect(document.body.querySelectorAll('.project-card__main').length).toBe(3)
      expect(document.body.querySelectorAll('.project-card__more').length).toBe(6)
      // ≤ 预览条数：不出现「展开更多」（无更多可展开）
      expect(document.body.querySelector('.session-drawer__expand')).toBeNull()
    },
    MOUNT_TIMEOUT,
  )
})

// ---- 项目预览条数（2026-10-19 用户裁决：默认 8 条 + 展开更多）----
// 几何依据见 AgentSideRail.vue 的 PROJECTS_PREVIEW_COUNT 注释（首屏列表区实测 ~590px，
// 8×60px 卡片 + 按钮同屏不折叠）。这里锁行为契约：默认只渲染前 8、按钮带剩余计数、
// 点击展开全部、再点收回、边界（=8）不显示按钮。

describe('mobile session drawer: project preview cap + expand more', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  async function openDrawerWith(n: number) {
    setProjectFixtures(n)
    const w = await mountRail()
    w.vm.openSessionDrawer()
    const { flushPromises } = await import('@vue/test-utils')
    await flushPromises()
    return w
  }

  it(
    'default preview shows only the first 8 (most recent) with a counted expand button',
    async () => {
      await openDrawerWith(30)
      const cards = document.body.querySelectorAll('.project-card')
      expect(cards.length).toBe(8)
      // 前 8 = 最新 8 条（fixtures 按 updatedAt 递减生成）
      expect(cards[0].textContent).toContain('项目 0')
      expect(cards[7].textContent).toContain('项目 7')
      const btn = document.body.querySelector('.session-drawer__expand')
      expect(btn).not.toBeNull()
      expect(btn?.textContent).toContain('展开更多（还有 22 个）')
    },
    MOUNT_TIMEOUT,
  )

  it(
    'clicking expand shows all projects; clicking again collapses back to 8',
    async () => {
      await openDrawerWith(30)
      const btn = document.body.querySelector('.session-drawer__expand') as HTMLButtonElement
      btn.click()
      await (await import('@vue/test-utils')).flushPromises()
      expect(document.body.querySelectorAll('.project-card').length).toBe(30)
      expect(document.body.querySelector('.session-drawer__expand')?.textContent).toContain('收起')

      ;(document.body.querySelector('.session-drawer__expand') as HTMLButtonElement).click()
      await (await import('@vue/test-utils')).flushPromises()
      expect(document.body.querySelectorAll('.project-card').length).toBe(8)
      expect(document.body.querySelector('.session-drawer__expand')?.textContent).toContain('展开更多')
    },
    MOUNT_TIMEOUT,
  )

  it(
    'boundary: exactly 8 projects → no expand button (nothing hidden)',
    async () => {
      await openDrawerWith(8)
      expect(document.body.querySelectorAll('.project-card').length).toBe(8)
      expect(document.body.querySelector('.session-drawer__expand')).toBeNull()
    },
    MOUNT_TIMEOUT,
  )

  it(
    'boundary: 9 projects → button says 还有 1 个',
    async () => {
      await openDrawerWith(9)
      expect(document.body.querySelectorAll('.project-card').length).toBe(8)
      expect(document.body.querySelector('.session-drawer__expand')?.textContent).toContain('还有 1 个')
    },
    MOUNT_TIMEOUT,
  )
})
