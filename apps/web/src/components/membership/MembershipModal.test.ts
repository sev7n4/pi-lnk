import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import MembershipModal from './MembershipModal.vue'
import { useAuthStore } from '@/stores/auth'
import type { MembershipPlan } from '@/services/users-api'

/// 与后端 membership.service.ts PLANS 对齐的夹具（方案丙四档 + free）。
/// ⚠️ vi.mock 工厂会被提升到文件顶部，夹具必须走 vi.hoisted 否则 TDZ 报错。
const PLANS_FIXTURE = vi.hoisted((): MembershipPlan[] => [
  { id: 'free', name: '免费版', points: 1000, price: 0, features: ['每日 100 积分'] },
  { id: 'experience', name: '体验版', points: 3000, price: 29, basic: 2000, bonus: 1000, features: ['每日 100 积分'] },
  { id: 'standard', name: '标准版', points: 11000, price: 99, basic: 5000, bonus: 6000, features: ['每日 100 积分'] },
  { id: 'premium', name: '高级版', points: 25000, price: 199, basic: 10000, bonus: 15000, features: ['每日 100 积分', '优先队列'], recommended: true },
  { id: 'flagship', name: '旗舰版', points: 70000, price: 499, basic: 25000, bonus: 45000, features: ['每日 100 积分', '优先队列'] },
])

vi.mock('@/services/users-api', () => ({
  membershipApi: {
    getPlans: vi.fn(async () => ({ data: { data: PLANS_FIXTURE } })),
    getPoints: vi.fn(async () => ({ data: { data: { points: 116365, membership: 'premium' } } })),
    claimDaily: vi.fn(),
    upgrade: vi.fn(),
  },
  membershipLabel: vi.fn((id?: string) => PLANS_FIXTURE.find((p) => p.id === id)?.name ?? '免费版'),
}))

vi.mock('@/services/payment-api', () => ({
  paymentApi: {
    createSubscriptionOrder: vi.fn(),
    getOrder: vi.fn(),
  },
}))

function loginStubs() {
  return {
    ElDialog: {
      props: ['modelValue', 'appendToBody', 'width'],
      template: '<div class="el-dialog-stub"><slot name="header" /><slot /></div>',
    },
    ElButton: {
      props: ['loading', 'type', 'size'],
      emits: ['click'],
      template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
    },
  }
}

describe('MembershipModal', () => {
  it('enables append-to-body so canvas chrome cannot trap dialog clicks', () => {
    const pinia = createPinia()
    const wrapper = mount(MembershipModal, {
      props: { modelValue: false },
      global: {
        plugins: [pinia],
        stubs: {
          ...loginStubs(),
          ElDialog: {
            props: {
              modelValue: Boolean,
              appendToBody: Boolean,
            },
            template: '<div class="el-dialog-stub" :data-append-to-body="String(appendToBody)" />',
          },
        },
      },
    })
    // Vue normalizes append-to-body → appendToBody on the component
    const dialog = wrapper.findComponent({ name: 'ElDialog' })
    if (dialog.exists()) {
      expect(dialog.props('appendToBody')).toBe(true)
    } else {
      expect(wrapper.find('.el-dialog-stub').attributes('data-append-to-body')).toBe('true')
    }
    wrapper.unmount()
  })

  it('renders four purchasable tiers, filters free, and marks recommended/current', async () => {
    const pinia = createPinia()
    const auth = useAuthStore(pinia)
    auth.token = 'test-token'
    auth.user = { id: 'u1', membership: 'premium', points: 116365 } as never

    const wrapper = mount(MembershipModal, {
      props: { modelValue: true },
      global: { plugins: [pinia], stubs: loginStubs() },
    })
    await flushPromises()

    // free 档被 purchasablePlans 过滤，其余四档齐全
    const cards = wrapper.findAll('.plan')
    expect(cards).toHaveLength(4)
    expect(wrapper.text()).not.toContain('免费版')

    // 头部：品牌标题 + 当前套餐标签 + 积分数字
    expect(wrapper.find('.hd-pi').text()).toBe('π')
    expect(wrapper.find('.hd-current').text()).toContain('高级版')
    expect(wrapper.find('.hd-num').text()).toBe('116,365')

    // 推荐徽标落在高级版卡片上
    const recoCard = cards.find((c) => c.classes().includes('is-recommended'))
    expect(recoCard).toBeTruthy()
    expect(recoCard!.find('.badge-reco').text()).toBe('推荐')
    expect(recoCard!.find('.plan-name').text()).toBe('高级版')

    // 当前档卡片不渲染「立即升级」CTA，改为「当前套餐」占位
    const currentCard = cards.find((c) => c.classes().includes('is-current'))
    expect(currentCard).toBeTruthy()
    expect(currentCard!.find('.plan-cta').exists()).toBe(false)
    expect(currentCard!.find('.plan-cta-current').text()).toBe('当前套餐')

    // 其余档位渲染 CTA
    expect(wrapper.findAll('.plan-cta')).toHaveLength(3)

    // 基础/赠送行与设计稿口径一致（标准版 5,000 + 6,000）
    const standardCard = cards.find((c) => c.find('.plan-name').text() === '标准版')
    expect(standardCard!.text()).toContain('每月 5,000 积分')
    expect(standardCard!.text()).toContain('每月 6,000 积分')

    // 底部脚注（设计稿口径）
    expect(wrapper.find('.footnote').text()).toContain('当月未用完不结转')

    wrapper.unmount()
  })
})
