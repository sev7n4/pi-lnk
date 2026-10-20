import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkCard from './WorkCard.vue'

// type 只能取 'canvas' | 'shortfilm'（WorkType）
const work = {
  id: 'w_1', title: '星海回响', coverUrl: 'https://cdn/x.jpg', type: 'shortfilm',
  authorId: 'u_1', authorName: '墨行者', likes: 12, views: 340,
  createdAt: '2026-10-01T00:00:00.000Z',
}

function mountCard() {
  return mount(WorkCard, { props: { work } })
}

function actionClasses(wrapper: ReturnType<typeof mountCard>) {
  return wrapper.find('[data-testid="work-cover-actions"]').classes().join(' ')
}

describe('WorkCard 封面净化', () => {
  it('旧的三个常驻按钮文案全部撤出（立即观看 / 制作过程 / 分享）', () => {
    const wrapper = mountCard()
    expect(wrapper.text()).not.toContain('立即观看')
    expect(wrapper.text()).not.toContain('制作过程')
  })

  it('动作层默认透明，但保留在 DOM（hover 与 focus-within 都能唤出）', () => {
    const cls = actionClasses(mountCard())
    expect(cls).toContain('opacity-0')
    expect(cls).toContain('group-hover:opacity-100')
    expect(cls).toContain('group-focus-within:opacity-100')
    // 绝不能用 hidden / invisible：visibility:hidden 的元素不可聚焦，键盘用户一样拿不到
    expect(cls).not.toContain('hidden')
    expect(cls).not.toContain('invisible')
  })

  it('键盘可达：主按钮是真 button 且未被移出 Tab 序列', () => {
    const wrapper = mountCard()
    const primary = wrapper.find('[data-testid="work-cover-primary"]')
    expect(primary.element.tagName).toBe('BUTTON')
    expect(primary.attributes('type')).toBe('button')
    expect(primary.attributes('tabindex')).not.toBe('-1')
    expect(primary.text()).toBe('观看')
  })

  it('底栏一行数据（赞/浏览）并保留作者名入口', () => {
    const wrapper = mountCard()
    expect(wrapper.text()).toContain('墨行者')
    expect(wrapper.text()).toContain('12')
    expect(wrapper.text()).toContain('340')
  })
})
