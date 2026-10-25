// ProjectPanel 组件级契约（PR-2 Task 7）。
//
// 为什么单独测这个组件：项目抽屉此前只被「整份挂载 AgentSideRail」的用例覆盖，
// 代价高（首挂载编译 + teardown 可达数十秒）且失败难定位。抽出组件后即可
// **只挂这一个轻量组件** ⇒ 快、且失败信号直指面板本身。
//
// ⚠️ Teleport DOM 泄漏治理：面板 Teleport 到 body，wrapper.html() 看不到内容，
//    断言必须查 document.body；且用例间必须 unmount（否则上一个实例仍活着，
//    响应式更新会把卡片插回 body ⇒ 全局 querySelectorAll 多算）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProjectPanel from './ProjectPanel.vue'
import type { ProjectCard } from '@/composables/useProjectWorkspace'

function makeProjects(n: number): ProjectCard[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    title: `项目 ${i}`,
    // updatedAt 递减 = 模拟后端 orderBy updatedAt desc；第 0 条最新
    updatedAt: new Date(Date.UTC(2026, 9, 19, 10, 0, 0) - i * 3_600_000).toISOString(),
    coverUrl: null,
    coverNodeId: null,
  }))
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  document.body.innerHTML = ''
})

async function mountPanel(props: Partial<{
  open: boolean
  projects: ProjectCard[]
  currentId: string
  loading: boolean
  error: boolean
  reserveTabbar: boolean
}> = {}) {
  const w = mount(ProjectPanel, {
    props: {
      open: true,
      projects: makeProjects(3),
      currentId: 'p0',
      loading: false,
      error: false,
      ...props,
    },
  })
  await flushPromises()
  mounted.push(w)
  return w
}

describe('ProjectPanel：项目抽屉（断点中立组件）', () => {
  it('每个项目一张卡：标题兜底 + is-current 标记 + 三个操作入口', async () => {
    await mountPanel({
      projects: [
        { id: 'p0', title: '漫剧主线', updatedAt: '2026-10-19T10:00:00.000Z', coverUrl: null, coverNodeId: null },
        { id: 'p1', title: '产品图实验', updatedAt: '2026-10-18T10:00:00.000Z', coverUrl: null, coverNodeId: null },
        { id: 'p2', title: '', updatedAt: '2026-10-17T10:00:00.000Z', coverUrl: null, coverNodeId: null },
      ],
      currentId: 'p0',
    })

    const cards = document.body.querySelectorAll('.project-card')
    expect(cards.length).toBe(3)
    expect(cards[0].textContent).toContain('漫剧主线')
    // 空标题走「未命名项目」兜底
    expect(cards[2].textContent).toContain('未命名项目')
    // 当前项目卡带 is-current（accent 边框）
    expect(cards[0].classList.contains('is-current')).toBe(true)
    expect(cards[1].classList.contains('is-current')).toBe(false)
    // 每卡三个入口：打开 + 重命名 + 删除
    expect(document.body.querySelectorAll('.project-card__main').length).toBe(3)
    expect(document.body.querySelectorAll('.project-card__more').length).toBe(6)
  })

  it('默认只预览最近 8 条，「展开更多」带剩余计数；点开=全部，再点=收回', async () => {
    await mountPanel({ projects: makeProjects(30) })

    expect(document.body.querySelectorAll('.project-card').length).toBe(8)
    expect(document.body.querySelector('.project-card')?.textContent).toContain('项目 0')

    const btn = document.body.querySelector('.session-drawer__expand') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('展开更多（还有 22 个）')

    btn.click()
    await flushPromises()
    expect(document.body.querySelectorAll('.project-card').length).toBe(30)
    expect(document.body.querySelector('.session-drawer__expand')?.textContent).toContain('收起')

    ;(document.body.querySelector('.session-drawer__expand') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.body.querySelectorAll('.project-card').length).toBe(8)
    expect(document.body.querySelector('.session-drawer__expand')?.textContent).toContain('展开更多')
  })

  it('边界：正好 8 条不显示「展开更多」（没有可展开的内容）', async () => {
    await mountPanel({ projects: makeProjects(8) })
    expect(document.body.querySelectorAll('.project-card').length).toBe(8)
    expect(document.body.querySelector('.session-drawer__expand')).toBeNull()
  })

  it('边界：9 条 ⇒ 按钮说「还有 1 个」', async () => {
    await mountPanel({ projects: makeProjects(9) })
    expect(document.body.querySelectorAll('.project-card').length).toBe(8)
    expect(document.body.querySelector('.session-drawer__expand')?.textContent).toContain('还有 1 个')
  })

  it('动作事件：新建 / 打开 / 重命名 / 删除 各自 emit', async () => {
    const w = await mountPanel({ projects: makeProjects(2) })

    document.body.querySelector<HTMLButtonElement>('.create-card')?.click()
    await flushPromises()
    expect(w.emitted('create')).toHaveLength(1)

    document.body.querySelector<HTMLButtonElement>('.project-card__main')?.click()
    await flushPromises()
    expect(w.emitted('open')).toEqual([['p0']])

    const more = document.body.querySelectorAll<HTMLButtonElement>('.project-card__more')
    more[0]?.click()
    await flushPromises()
    expect(w.emitted('rename')).toHaveLength(1)
    expect((w.emitted('rename')![0] as [{ id: string }])[0].id).toBe('p0')

    more[1]?.click()
    await flushPromises()
    expect(w.emitted('remove')).toHaveLength(1)
    expect((w.emitted('remove')![0] as [{ id: string }])[0].id).toBe('p0')
  })

  it('关闭与重试：点遮罩 emit close，失败态点「重试」emit retry', async () => {
    const w = await mountPanel({ error: true, projects: [] })

    expect(document.body.textContent).toContain('项目加载失败')
    document.body.querySelector<HTMLButtonElement>('.session-drawer__retry')?.click()
    await flushPromises()
    expect(w.emitted('retry')).toHaveLength(1)

    // 点遮罩空白处（@click.self）⇒ close
    document.body.querySelector<HTMLElement>('.session-drawer-layer')?.click()
    await flushPromises()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('加载态：**一条都没有**时才占位提示', async () => {
    await mountPanel({ loading: true, projects: [] })
    expect(document.body.textContent).toContain('项目加载中…')
  })

  it('加载态：**已有数据**时不占位（后台刷新不该把可用的清单顶掉）', async () => {
    // ⛔ 2026-10-25 生产实证：旧实现是「loading ⇒ 显示『项目加载中…』」，
    //    把上面 8 个能用的项目顶成一句提示 ⇒ 用户以为没加载出来。
    await mountPanel({ loading: true, projects: makeProjects(30) })
    expect(document.body.textContent).not.toContain('项目加载中…')
    expect(document.body.querySelectorAll('.project-card').length).toBe(8)
  })

  it('后台刷新进行中：「展开更多」按钮**仍在**（旧实现被 !loading 卡掉 ⇒ 摸不到）', async () => {
    await mountPanel({ loading: true, projects: makeProjects(30) })
    const btn = document.body.querySelector('.session-drawer__expand')
    expect(btn, '刷新期间也必须能展开到其余项目').not.toBeNull()
    expect(btn?.textContent).toContain('展开更多（还有 22 个）')
  })

  it('失败态：**无数据**才整块报错并给重试', async () => {
    await mountPanel({ error: true, projects: [] })
    expect(document.body.textContent).toContain('项目加载失败')
    expect(document.body.querySelector('.session-drawer__retry')).not.toBeNull()
  })

  it('失败态：**已有数据**时清单照常显示，只给不阻塞的提示（不再整块报错）', async () => {
    // ⛔ 2026-10-25 生产实证：旧实现失败时 projects 被清空 + 整块报错 ⇒
    //    用户正在看的项目「一起消失」，既没得看也没得选。
    await mountPanel({ error: true, projects: makeProjects(30) })
    expect(document.body.querySelectorAll('.project-card').length).toBe(8)
    expect(document.body.textContent).not.toContain('项目加载失败')
    expect(document.body.textContent).toContain('刷新失败')
    // 重试入口仍在
    expect(document.body.querySelector('.session-drawer__retry')).not.toBeNull()
  })

  it('空态文案', async () => {
    await mountPanel({ projects: [] })
    expect(document.body.textContent).toContain('暂无项目')
  })

  it('closed 时不渲染任何内容（面板关闭态零 DOM）', async () => {
    await mountPanel({ open: false })
    expect(document.body.querySelector('.session-drawer-layer')).toBeNull()
    expect(document.body.querySelectorAll('.project-card').length).toBe(0)
  })

  it('底部页签预留：默认让开页签（移动端），reserveTabbar=false 走整屏（PC）', async () => {
    // 默认（移动端）：遮罩保留 56px 兜底 —— 这是 2026-10-19「页签失灵」事故的安全网
    const mobile = await mountPanel({})
    expect(
      document.body.querySelector('.session-drawer-layer')?.classList.contains('is-full-bleed'),
    ).toBe(false)
    mobile.unmount()
    mounted.splice(0, 1)
    document.body.innerHTML = ''

    // PC：无底部页签 ⇒ 整屏，否则底部留 56px 空条（点不到 = 关不掉）+ 抽屉矮一截
    await mountPanel({ reserveTabbar: false })
    expect(
      document.body.querySelector('.session-drawer-layer')?.classList.contains('is-full-bleed'),
    ).toBe(true)
  })

  it('样式契约：整屏变体把 bottom 归零，移动端兜底仍是 56px', () => {
    // jsdom 不计算布局 ⇒ 几何类断言落在 CSS 块契约上（与本仓既有做法一致）
    const sfc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ProjectPanel.vue'), 'utf8')
    const style = sfc.slice(sfc.indexOf('<style'), sfc.lastIndexOf('</style>'))
    // 移动端安全网不得被摘掉
    expect(style).toContain('bottom: var(--lnk-tabbar-h, 56px)')
    const full = style.match(/\.session-drawer-layer\.is-full-bleed\s*\{[^}]*\}/)?.[0]
    expect(full, '必须存在整屏变体规则').toBeTruthy()
    expect(full).toContain('bottom: 0')
  })
})
