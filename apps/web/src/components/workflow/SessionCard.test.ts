import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import type { Session } from '@lnkpi/shared'
import SessionCard from './SessionCard.vue'

// 注意：SFC 的 <style scoped> 不进 wrapper.html()，令牌断言必须读源码
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'SessionCard.vue'), 'utf8')

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's_1',
    title: '我的画布',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as Session
}

function mountCard(props: Partial<Session> = {}, extra: Record<string, unknown> = {}) {
  return mount(SessionCard, {
    props: { session: makeSession(props), ...extra },
  })
}

describe('SessionCard 令牌迁移（P1：--neo-* → --lnk-*）', () => {
  it('组件源码里 --neo-* 已清零', () => {
    const neoHits = SRC.match(/--neo-[a-z0-9-]+/g) ?? []
    expect(neoHits, `仍有旧令牌：${[...new Set(neoHits)].join(', ')}`).toHaveLength(0)
  })

  it('卡片边框与底色走 lnk 令牌（2026-10-22 起经全局 .lnk-media-card 单一真相源）', () => {
    // 面/描边/hover 语言已上收 main.css 的 .lnk-media-card（与 WorkCard 共用，
    // 消除「我的画布 vs 社区精选」同页割裂）。SessionCard 侧锁「挂了全局类」，
    // 令牌本体锁 main.css——守卫随实现的位置走，不扭曲实现。
    expect(SRC).toContain('lnk-media-card')
    const main = readFileSync(join(HERE, '../../styles/main.css'), 'utf8')
    expect(main).toContain('var(--lnk-border-subtle)')
    expect(main).toContain('var(--lnk-surface-base)')
  })

  it('hover 态用 accent 通道（--lnk-accent）表达高亮，不再用 --lnk-hi-text', () => {
    expect(SRC).toContain('var(--lnk-accent)')
    expect(SRC).not.toContain('--lnk-hi-text')
  })

  it('选中态用 --lnk-accent + --lnk-accent-subtle', () => {
    expect(SRC).toContain('var(--lnk-accent-subtle)')
  })

  it('弹出菜单改用 --lnk-surface-overlay 语义键（旧 .neo-popover 类不再出现）', () => {
    expect(SRC).toContain('var(--lnk-surface-overlay)')
    expect(SRC).not.toContain('neo-popover')
  })

  it('hover 阴影保留 --lnk-shadow-md（全局 .lnk-media-card:hover）', () => {
    const main = readFileSync(join(HERE, '../../styles/main.css'), 'utf8')
    expect(main).toContain('var(--lnk-shadow-md)')
  })
})

describe('SessionCard 行为不变量（迁移不许回归）', () => {
  it('点击卡片 emit open（管理态外）', async () => {
    const wrapper = mountCard()
    await wrapper.find('.session-card-body').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('管理态点击 emit toggleSelect 而非 open', async () => {
    const wrapper = mountCard({}, { manageMode: true })
    await wrapper.find('.session-card-body').trigger('click')
    expect(wrapper.emitted('toggleSelect')).toHaveLength(1)
    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('菜单三项分别 emit rename / duplicate / delete', async () => {
    const wrapper = mountCard({}, { menuOpen: true })
    const items = wrapper.findAll('.session-card-menu-anchor button')
    // 更多按钮（toggleMenu）+ 三项菜单
    expect(items.length).toBeGreaterThanOrEqual(4)
    await items[1]!.trigger('click')
    await items[2]!.trigger('click')
    await items[3]!.trigger('click')
    expect(wrapper.emitted('rename')).toHaveLength(1)
    expect(wrapper.emitted('duplicate')).toHaveLength(1)
    expect(wrapper.emitted('delete')).toHaveLength(1)
  })

  it('管理态才渲染勾选框', () => {
    expect(mountCard().find('input[type="checkbox"]').exists()).toBe(false)
    expect(mountCard({}, { manageMode: true }).find('input[type="checkbox"]').exists()).toBe(true)
  })

  it('有封面时渲染 img（canvasData 是对象不是 JSON 字符串）', () => {
    // 回归点：曾把canvasData 当字符串序列化，导致封面永远取不到 → 全落兜底
    const wrapper = mountCard({
      // CanvasData 要求 edges 必填，缺一个字段 vue-tsc -b 就报 TS2352
      canvasData: {
        nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { url: 'https://cdn/a.png' } }],
        edges: [],
      } as unknown as Session['canvasData'],
    } as Partial<Session>)
    expect(wrapper.html()).toContain('https://cdn/a.png')
    expect(wrapper.find('[data-testid="canvas-cover-fallback"]').exists()).toBe(false)
  })

  it('视频封面走 <video> 而非 <img>', () => {
    const wrapper = mountCard({
      canvasData: {
        nodes: [{ id: 'n1', type: 'video', position: { x: 0, y: 0 }, data: { url: 'https://cdn/a.mp4' } }],
        edges: [],
      } as unknown as Session['canvasData'],
    } as Partial<Session>)
    expect(wrapper.find('video').exists()).toBe(true)
  })

  it('无封面时落画布专属兜底（CanvasCoverFallback 墨点纸纹，不再是灰块/头像位语言）', () => {
    const wrapper = mountCard()
    expect(wrapper.find('[data-testid="canvas-cover-fallback"]').exists()).toBe(true)
  })

  it('标题为空时回落「未命名画布」', () => {
    const wrapper = mountCard({ title: '' })
    expect(wrapper.text()).toContain('未命名画布')
  })
})
